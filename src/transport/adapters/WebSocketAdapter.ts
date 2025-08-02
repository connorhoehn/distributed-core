import { Transport } from '../Transport';
import { Message, NodeId } from '../../types';
import { EventEmitter } from 'events';
import { Server as WebSocketServer, WebSocket, RawData } from 'ws';
import { CircuitBreaker } from '../CircuitBreaker';
import { RetryManager } from '../RetryManager';

export interface WebSocketAdapterConfig {
  port?: number;
  host?: string;
  maxConnections?: number;
  pingInterval?: number;
  pongTimeout?: number;
  compression?: boolean;
  enablePerMessageDeflate?: boolean;
  heartbeatInterval?: number;
  connectionTimeout?: number;
  enableLogging?: boolean;
}

export interface WebSocketConnection {
  id: string;
  socket: WebSocket;
  nodeId?: string;
  lastPing: number;
  lastPong: number;
  isAlive: boolean;
  connectedAt: number;
  messageCount: number;
}

export class WebSocketAdapter extends Transport {
  private readonly config: Required<WebSocketAdapterConfig>;
  private server: WebSocketServer | null = null;
  private connections = new Map<string, WebSocketConnection>();
  private isRunning = false;
  private messageHandler?: (message: Message) => void;
  private circuitBreaker: CircuitBreaker;
  private retryManager: RetryManager;
  private heartbeatTimer?: NodeJS.Timeout;
  private stats = {
    messagesReceived: 0,
    messagesSent: 0,
    connectionsEstablished: 0,
    connectionsDropped: 0,
    pingsSent: 0,
    pongsReceived: 0,
    errors: 0
  };

  constructor(
    private readonly nodeInfo: { id: string; address: string; port: number },
    config: WebSocketAdapterConfig = {}
  ) {
    super();
    
    this.config = {
      port: config.port ?? nodeInfo.port,
      host: config.host ?? nodeInfo.address,
      maxConnections: config.maxConnections ?? 100,
      pingInterval: config.pingInterval ?? 30000,
      pongTimeout: config.pongTimeout ?? 5000,
      compression: config.compression ?? true,
      enablePerMessageDeflate: config.enablePerMessageDeflate ?? true,
      heartbeatInterval: config.heartbeatInterval ?? 10000,
      connectionTimeout: config.connectionTimeout ?? 30000,
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
      throw new Error('WebSocket adapter is already running');
    }

    try {
      this.server = new WebSocketServer({
        port: this.config.port,
        host: this.config.host,
        perMessageDeflate: this.config.enablePerMessageDeflate,
        maxPayload: 1024 * 1024, // 1MB max payload
        clientTracking: true
      });

      this.server.on('connection', this.handleConnection.bind(this));
      this.server.on('error', this.handleServerError.bind(this));
      this.server.on('listening', () => {
        this.emit('started', { port: this.config.port, host: this.config.host });
      });

      this.isRunning = true;
      this.startHeartbeat();

      // Wait for server to start listening
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket server start timeout'));
        }, 5000);

        this.server!.once('listening', () => {
          clearTimeout(timeout);
          resolve();
        });

        this.server!.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

    } catch (error) {
      this.isRunning = false;
      this.stats.errors++;
      throw new Error(`Failed to start WebSocket adapter: ${error}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    // Close all connections
    Array.from(this.connections.values()).forEach(connection => {
      this.closeConnection(connection, 'Server shutting down');
    });
    this.connections.clear();

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          resolve();
        });
      });
      this.server = null;
    }

    this.emit('stopped');
  }

  async send(message: Message, target: NodeId): Promise<void> {
    if (!this.isRunning) {
      throw new Error('WebSocket adapter is not running');
    }

    const messageData = JSON.stringify(message);
    const connection = this.findConnectionByNodeId(target.id);
    
    if (connection) {
      await this.sendToConnection(connection, messageData);
    } else {
      // Try to establish new connection
      await this.connectToNode(target, messageData);
    }

    this.stats.messagesSent++;
  }

  async sendMessage(message: Message, targetNode?: NodeId): Promise<void> {
    if (!this.isRunning) {
      throw new Error('WebSocket adapter is not running');
    }

    const messageData = JSON.stringify({
      id: message.id,
      type: message.type,
      data: message.data,
      sender: message.sender,
      timestamp: message.timestamp,
      headers: message.headers
    });

    if (targetNode) {
      // Send to specific node
      const connection = this.findConnectionByNodeId(targetNode.id);
      if (connection) {
        await this.sendToConnection(connection, messageData);
      } else {
        // Try to establish new connection
        await this.connectToNode(targetNode, messageData);
      }
    } else {
      // Broadcast to all connections
      const promises: Promise<void>[] = [];
      Array.from(this.connections.values()).forEach(connection => {
        promises.push(this.sendToConnection(connection, messageData));
      });
      await Promise.allSettled(promises);
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
      if (connection.nodeId && connection.socket.readyState === WebSocket.OPEN) {
        // Convert node ID string to NodeId interface
        // This assumes the nodeId is stored as a composite string like "id:address:port"
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
      totalConnections: this.stats.connectionsEstablished,
      droppedConnections: this.stats.connectionsDropped,
      messagesReceived: this.stats.messagesReceived,
      messagesSent: this.stats.messagesSent,
      pingsSent: this.stats.pingsSent,
      pongsReceived: this.stats.pongsReceived,
      errors: this.stats.errors,
      circuitBreakerState: this.circuitBreaker.getState(),
      compressionEnabled: this.config.compression
    };
  }

  private handleConnection(socket: WebSocket, request: any): void {
    const connectionId = this.generateConnectionId();
    const connection: WebSocketConnection = {
      id: connectionId,
      socket,
      lastPing: Date.now(),
      lastPong: Date.now(),
      isAlive: true,
      connectedAt: Date.now(),
      messageCount: 0
    };

    // Connection limit check
    if (this.connections.size >= this.config.maxConnections) {
      socket.close(1008, 'Connection limit exceeded');
      return;
    }

    this.connections.set(connectionId, connection);
    this.stats.connectionsEstablished++;

    // Set up socket event handlers
    socket.on('message', (data: RawData) => {
      this.handleMessage(connection, data);
    });

    socket.on('pong', () => {
      this.handlePong(connection);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      this.handleDisconnection(connection, code, reason.toString());
    });

    socket.on('error', (error: Error) => {
      this.handleConnectionError(connection, error);
    });

    // Send initial ping
    this.sendPing(connection);

    this.emit('connection', { connectionId, nodeId: connection.nodeId });
  }

  private handleMessage(connection: WebSocketConnection, data: RawData): void {
    try {
      const messageStr = data.toString();
      const messageData = JSON.parse(messageStr);

      // Handle control messages
      if (messageData.type === 'node_info') {
        connection.nodeId = messageData.nodeId;
        this.emit('nodeIdentified', { connectionId: connection.id, nodeId: messageData.nodeId });
        return;
      }

      // Handle gossip messages
      if (this.messageHandler && messageData.id && messageData.type) {
        const message: Message = {
          id: messageData.id,
          type: messageData.type,
          data: messageData.data,
          sender: messageData.sender,
          timestamp: messageData.timestamp,
          headers: messageData.headers
        };

        connection.messageCount++;
        this.stats.messagesReceived++;
        this.messageHandler(message);
      }

    } catch (error) {
      this.stats.errors++;
      this.emit('messageError', { connectionId: connection.id, error });
      
      // Close connection on repeated parse errors
      if (connection.messageCount > 0 && Math.random() < 0.1) {
        this.closeConnection(connection, 'Invalid message format');
      }
    }
  }

  private handlePong(connection: WebSocketConnection): void {
    connection.lastPong = Date.now();
    connection.isAlive = true;
    this.stats.pongsReceived++;
  }

  private handleDisconnection(connection: WebSocketConnection, code: number, reason: string): void {
    this.connections.delete(connection.id);
    this.stats.connectionsDropped++;
    this.emit('disconnection', { 
      connectionId: connection.id, 
      nodeId: connection.nodeId,
      code,
      reason,
      duration: Date.now() - connection.connectedAt
    });
  }

  private handleConnectionError(connection: WebSocketConnection, error: Error): void {
    this.stats.errors++;
    this.emit('connectionError', { connectionId: connection.id, error });
    this.closeConnection(connection, 'Connection error');
  }

  private handleServerError(error: Error): void {
    this.stats.errors++;
    this.emit('error', error);
  }

  private async sendToConnection(connection: WebSocketConnection, message: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (connection.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Connection not open'));
        return;
      }

      connection.socket.send(message, (error) => {
        if (error) {
          this.stats.errors++;
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private async connectToNode(node: { id: string; address: string; port: number }, initialMessage?: string): Promise<void> {
    const wsUrl = `ws://${node.address}:${node.port}`;
    
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const connectionId = this.generateConnectionId();
      
      const connection: WebSocketConnection = {
        id: connectionId,
        socket,
        nodeId: node.id,
        lastPing: Date.now(),
        lastPong: Date.now(),
        isAlive: true,
        connectedAt: Date.now(),
        messageCount: 0
      };

      socket.once('open', async () => {
        this.connections.set(connectionId, connection);
        this.stats.connectionsEstablished++;

        // Send node identification
        socket.send(JSON.stringify({
          type: 'node_info',
          nodeId: this.nodeInfo.id
        }));

        // Send initial message if provided
        if (initialMessage) {
          socket.send(initialMessage);
        }

        // Set up ongoing event handlers
        this.setupOutgoingConnectionHandlers(connection);
        resolve();
      });

      socket.once('error', (error) => {
        this.stats.errors++;
        reject(error);
      });

      // Connection timeout
      setTimeout(() => {
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
          reject(new Error('Connection timeout'));
        }
      }, this.config.connectionTimeout);
    });
  }

  private setupOutgoingConnectionHandlers(connection: WebSocketConnection): void {
    connection.socket.on('message', (data: RawData) => {
      this.handleMessage(connection, data);
    });

    connection.socket.on('pong', () => {
      this.handlePong(connection);
    });

    connection.socket.on('close', (code: number, reason: Buffer) => {
      this.handleDisconnection(connection, code, reason.toString());
    });

    connection.socket.on('error', (error: Error) => {
      this.handleConnectionError(connection, error);
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const connectionsToClose: WebSocketConnection[] = [];

      Array.from(this.connections.values()).forEach(connection => {
        // Check for stale connections
        if (now - connection.lastPong > this.config.pongTimeout) {
          connectionsToClose.push(connection);
          return;
        }

        // Send ping if needed
        if (now - connection.lastPing > this.config.pingInterval) {
          this.sendPing(connection);
        }
      });

      // Close stale connections
      for (const connection of connectionsToClose) {
        this.closeConnection(connection, 'Ping timeout');
      }

    }, this.config.heartbeatInterval);
    this.heartbeatTimer?.unref();
  }

  private sendPing(connection: WebSocketConnection): void {
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.ping();
      connection.lastPing = Date.now();
      connection.isAlive = false; // Will be set to true on pong
      this.stats.pingsSent++;
    }
  }

  private closeConnection(connection: WebSocketConnection, reason: string): void {
    try {
      connection.socket.close(1000, reason);
    } catch (error) {
      // Socket might already be closed
    }
    this.connections.delete(connection.id);
  }

  private findConnectionByNodeId(nodeId: string): WebSocketConnection | undefined {
    for (const connection of Array.from(this.connections.values())) {
      if (connection.nodeId === nodeId) {
        return connection;
      }
    }
    return undefined;
  }

  private generateConnectionId(): string {
    return `ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
