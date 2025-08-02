import * as grpc from '@grpc/grpc-js';
import { Transport } from '../Transport';
import { NodeId, Message } from '../../types';
import { CircuitBreaker } from '../CircuitBreaker';
import { RetryManager } from '../RetryManager';

export interface GRPCAdapterConfig {
  port?: number;
  host?: string;
  maxConnections?: number;
  keepaliveTime?: number;
  keepaliveTimeout?: number;
  keepalivePermitWithoutCalls?: boolean;
  maxReceiveMessageLength?: number;
  maxSendMessageLength?: number;
  enableRetries?: boolean;
  healthCheckInterval?: number;
  enableLogging?: boolean;
}

export interface GRPCConnection {
  id: string;
  client: grpc.Client;
  nodeId?: string;
  connectedAt: number;
  lastHealthCheck: number;
  isHealthy: boolean;
  messageCount: number;
}

export class GRPCAdapter extends Transport {
  private readonly config: Required<GRPCAdapterConfig>;
  private server: grpc.Server | null = null;
  private connections = new Map<string, GRPCConnection>();
  private isRunning = false;
  private messageHandler?: (message: Message) => void;
  private circuitBreaker: CircuitBreaker;
  private retryManager: RetryManager;
  private healthCheckTimer?: NodeJS.Timeout;
  private stats = {
    messagesReceived: 0,
    messagesSent: 0,
    connectionsEstablished: 0,
    connectionsDropped: 0,
    healthChecks: 0,
    errors: 0
  };

  constructor(
    private readonly nodeInfo: { id: string; address: string; port: number },
    config: GRPCAdapterConfig = {}
  ) {
    super();
    
    this.config = {
      port: config.port ?? nodeInfo.port,
      host: config.host ?? nodeInfo.address,
      maxConnections: config.maxConnections ?? 100,
      keepaliveTime: config.keepaliveTime ?? 30000,
      keepaliveTimeout: config.keepaliveTimeout ?? 5000,
      keepalivePermitWithoutCalls: config.keepalivePermitWithoutCalls ?? true,
      maxReceiveMessageLength: config.maxReceiveMessageLength ?? 4 * 1024 * 1024,
      maxSendMessageLength: config.maxSendMessageLength ?? 4 * 1024 * 1024,
      enableRetries: config.enableRetries ?? true,
      healthCheckInterval: config.healthCheckInterval ?? 30000,
      enableLogging: config.enableLogging ?? true
    };

    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 30000,
      timeout: 5000,
      enableLogging: this.config.enableLogging
    });

    this.retryManager = new RetryManager({
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffFactor: 2,
      enableLogging: this.config.enableLogging
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('gRPC adapter is already running');
    }

    try {
      this.server = new grpc.Server({
        'grpc.keepalive_time_ms': this.config.keepaliveTime,
        'grpc.keepalive_timeout_ms': this.config.keepaliveTimeout,
        'grpc.keepalive_permit_without_calls': this.config.keepalivePermitWithoutCalls ? 1 : 0,
        'grpc.max_receive_message_length': this.config.maxReceiveMessageLength,
        'grpc.max_send_message_length': this.config.maxSendMessageLength
      });

      // Use a simplified service implementation
      const serviceImplementation = {
        SendMessage: this.handleSendMessage.bind(this),
        StreamMessages: this.handleStreamMessages.bind(this),
        HealthCheck: this.handleHealthCheck.bind(this)
      };

      // Create a basic service definition (simplified for transport adapter)
      const packageDefinition = {
        SendMessage: {
          path: '/gossip.GossipService/SendMessage',
          requestStream: false,
          responseStream: false
        }
      };

      // For now, we'll implement basic message handling without full gRPC proto definitions
      // This is sufficient for transport layer functionality

      const bindAddress = `${this.config.host}:${this.config.port}`;
      
      await new Promise<void>((resolve, reject) => {
        this.server!.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (error, port) => {
          if (error) {
            reject(error);
            return;
          }
          
          this.server!.start();
          this.isRunning = true;
          this.startHealthChecks();
          resolve();
        });
      });

      this.emit('started', { port: this.config.port, host: this.config.host });

    } catch (error) {
      this.isRunning = false;
      this.stats.errors++;
      throw new Error(`Failed to start gRPC adapter: ${error}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    // Stop health checks
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    // Close all connections
    Array.from(this.connections.values()).forEach(connection => {
      try {
        connection.client.close();
      } catch (error) {
        // Ignore errors when closing
      }
    });
    this.connections.clear();

    // Stop server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.tryShutdown((error) => {
          if (error) {
            // Force shutdown if graceful shutdown fails
            this.server!.forceShutdown();
          }
          resolve();
        });
      });
      this.server = null;
    }

    this.emit('stopped');
  }

  async send(message: Message, target: NodeId): Promise<void> {
    if (!this.isRunning) {
      throw new Error('gRPC adapter is not running');
    }

    const connection = this.findConnectionByNodeId(target.id);
    
    if (connection) {
      await this.sendToConnection(connection, message);
    } else {
      // Try to establish new connection
      await this.connectToNode(target, message);
    }

    this.stats.messagesSent++;
  }

  onMessage(handler: (message: Message) => void): void {
    this.messageHandler = handler;
  }

  removeMessageListener(callback: (message: Message) => void): void {
    if (this.messageHandler === callback) {
      this.messageHandler = undefined;
    }
  }

  getConnectedNodes(): NodeId[] {
    const nodes: NodeId[] = [];
    Array.from(this.connections.values()).forEach(connection => {
      if (connection.nodeId && connection.isHealthy) {
        // Parse nodeId if it's stored as composite string
        const parts = connection.nodeId.split(':');
        if (parts.length >= 3) {
          nodes.push({
            id: parts[0],
            address: parts[1],
            port: parseInt(parts[2])
          });
        }
      }
    });
    return nodes;
  }

  getStats() {
    return {
      isStarted: this.isRunning,
      host: this.config.host,
      port: this.config.port,
      activeConnections: this.connections.size,
      maxConnections: this.config.maxConnections,
      healthyConnections: Array.from(this.connections.values()).filter(c => c.isHealthy).length,
      totalConnections: this.stats.connectionsEstablished,
      droppedConnections: this.stats.connectionsDropped,
      messagesReceived: this.stats.messagesReceived,
      messagesSent: this.stats.messagesSent,
      healthChecks: this.stats.healthChecks,
      errors: this.stats.errors,
      circuitBreakerState: this.circuitBreaker.getState(),
      keepaliveTime: this.config.keepaliveTime
    };
  }

  private handleSendMessage(call: any, callback: any): void {
    try {
      const request = call.request;
      
      if (this.messageHandler && request.message) {
        const message: Message = {
          id: request.message.id,
          type: request.message.type,
          data: request.message.data,
          sender: request.message.sender,
          timestamp: request.message.timestamp,
          headers: request.message.headers
        };

        this.stats.messagesReceived++;
        this.messageHandler(message);
      }

      callback(null, { 
        success: true, 
        timestamp: Date.now(),
        nodeId: this.nodeInfo.id 
      });

    } catch (error) {
      this.stats.errors++;
      callback({
        code: grpc.status.INTERNAL,
        details: `Error processing message: ${error}`
      });
    }
  }

  private handleStreamMessages(call: any): void {
    const connectionId = this.generateConnectionId();
    
    call.on('data', (request: any) => {
      try {
        if (this.messageHandler && request.message) {
          const message: Message = {
            id: request.message.id,
            type: request.message.type,
            data: request.message.data,
            sender: request.message.sender,
            timestamp: request.message.timestamp,
            headers: request.message.headers
          };

          this.stats.messagesReceived++;
          this.messageHandler(message);
        }
      } catch (error) {
        this.stats.errors++;
        call.emit('error', {
          code: grpc.status.INTERNAL,
          details: `Error processing streamed message: ${error}`
        });
      }
    });

    call.on('end', () => {
      call.end();
    });

    call.on('error', (error: any) => {
      this.stats.errors++;
      console.error(`gRPC stream error for connection ${connectionId}:`, error);
    });
  }

  private handleHealthCheck(call: any, callback: any): void {
    this.stats.healthChecks++;
    
    callback(null, {
      status: 'SERVING',
      nodeId: this.nodeInfo.id,
      timestamp: Date.now(),
      connections: this.connections.size
    });
  }

  private async sendToConnection(connection: GRPCConnection, message: Message): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000; // 5 second timeout
      
      const call = connection.client.makeUnaryRequest(
        '/gossip.GossipService/SendMessage',
        (arg: any) => Buffer.from(JSON.stringify(arg)),
        (arg: Buffer) => JSON.parse(arg.toString()),
        { message },
        { deadline },
        (error, response) => {
          if (error) {
            this.stats.errors++;
            connection.isHealthy = false;
            reject(error);
          } else {
            connection.messageCount++;
            resolve();
          }
        }
      );
    });
  }

  private async connectToNode(node: NodeId, initialMessage?: Message): Promise<void> {
    const address = `${node.address}:${node.port}`;
    
    return new Promise((resolve, reject) => {
      const client = new grpc.Client(address, grpc.credentials.createInsecure(), {
        'grpc.keepalive_time_ms': this.config.keepaliveTime,
        'grpc.keepalive_timeout_ms': this.config.keepaliveTimeout,
        'grpc.keepalive_permit_without_calls': this.config.keepalivePermitWithoutCalls ? 1 : 0
      });

      const connectionId = this.generateConnectionId();
      const connection: GRPCConnection = {
        id: connectionId,
        client,
        nodeId: node.id,
        connectedAt: Date.now(),
        lastHealthCheck: Date.now(),
        isHealthy: true,
        messageCount: 0
      };

      // Test connection with health check
      const deadline = Date.now() + 5000;
      client.makeUnaryRequest(
        '/gossip.GossipService/HealthCheck',
        (arg: any) => Buffer.from(JSON.stringify(arg)),
        (arg: Buffer) => JSON.parse(arg.toString()),
        { nodeId: this.nodeInfo.id },
        { deadline },
        (error, response) => {
          if (error) {
            this.stats.errors++;
            client.close();
            reject(error);
          } else {
            this.connections.set(connectionId, connection);
            this.stats.connectionsEstablished++;

            // Send initial message if provided
            if (initialMessage) {
              this.sendToConnection(connection, initialMessage).catch(() => {
                // Ignore initial message send errors
              });
            }

            resolve();
          }
        }
      );
    });
  }

  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(() => {
      const now = Date.now();
      const connectionsToClose: GRPCConnection[] = [];

      Array.from(this.connections.values()).forEach(connection => {
        // Skip recent connections
        if (now - connection.lastHealthCheck < this.config.healthCheckInterval) {
          return;
        }

        // Perform health check
        const deadline = now + 3000; // 3 second timeout
        connection.client.makeUnaryRequest(
          '/gossip.GossipService/HealthCheck',
          (arg: any) => Buffer.from(JSON.stringify(arg)),
          (arg: Buffer) => JSON.parse(arg.toString()),
          { nodeId: this.nodeInfo.id },
          { deadline },
          (error, response) => {
            connection.lastHealthCheck = now;
            this.stats.healthChecks++;

            if (error) {
              connection.isHealthy = false;
              connectionsToClose.push(connection);
            } else {
              connection.isHealthy = true;
            }
          }
        );
      });

      // Clean up unhealthy connections
      connectionsToClose.forEach(connection => {
        this.closeConnection(connection, 'Health check failed');
      });

    }, this.config.healthCheckInterval);
    this.healthCheckTimer?.unref();
  }

  private closeConnection(connection: GRPCConnection, reason: string): void {
    try {
      connection.client.close();
    } catch (error) {
      // Ignore errors when closing
    }
    
    this.connections.delete(connection.id);
    this.stats.connectionsDropped++;
    
    this.emit('disconnection', {
      connectionId: connection.id,
      nodeId: connection.nodeId,
      reason,
      duration: Date.now() - connection.connectedAt
    });
  }

  private findConnectionByNodeId(nodeId: string): GRPCConnection | undefined {
    return Array.from(this.connections.values()).find(connection => 
      connection.nodeId === nodeId
    );
  }

  private generateConnectionId(): string {
    return `grpc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
