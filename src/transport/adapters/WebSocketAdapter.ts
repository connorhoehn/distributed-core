import * as WebSocket from 'ws';
import { EventEmitter } from 'events';
import * as http from 'http';
import { Transport } from '../Transport';
import { NodeId, Message } from '../../types';
import { CircuitBreaker } from '../CircuitBreaker';
import { RetryManager } from '../RetryManager';
import { GossipMessage } from '../GossipMessage';

interface WebSocketConnection {
  ws: WebSocket;
  nodeId: NodeId;
  isActive: boolean;
  lastActivity: number;
  isAlive: boolean;
}

interface WebSocketAdapterOptions {
  port?: number;
  host?: string;
  maxConnections?: number;
  pingInterval?: number;
  pongTimeout?: number;
  upgradeTimeout?: number;
  enableCompression?: boolean;
}

/**
 * WebSocket transport adapter for real-time bi-directional communication
 * Provides low-latency messaging with automatic reconnection and heartbeat monitoring
 */
export class WebSocketAdapter extends Transport {
  private readonly nodeId: NodeId;
  private readonly options: Required<WebSocketAdapterOptions>;
  private server?: http.Server;
  private wss?: WebSocket.Server;
  private connections = new Map<string, WebSocketConnection>();
  private isStarted = false;
  private circuitBreaker: CircuitBreaker;
  private retryManager: RetryManager;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(nodeId: NodeId, options: WebSocketAdapterOptions = {}) {
    super();
    this.nodeId = nodeId;
    this.options = {
      port: options.port || 8080,
      host: options.host || '0.0.0.0',
      maxConnections: options.maxConnections || 200,
      pingInterval: options.pingInterval || 30000, // 30 seconds
      pongTimeout: options.pongTimeout || 5000, // 5 seconds
      upgradeTimeout: options.upgradeTimeout || 10000, // 10 seconds
      enableCompression: options.enableCompression !== false
    };

    this.circuitBreaker = new CircuitBreaker({
      name: `websocket-adapter-${nodeId.id}`,
      failureThreshold: 5,
      timeout: 15000
    });

    this.retryManager = new RetryManager({
      maxRetries: 5,
      baseDelay: 2000,
      maxDelay: 30000,
      enableLogging: false
    });

    this.setupEventHandlers();
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    try {
      await this.circuitBreaker.execute(async () => {
        // Create HTTP server
        this.server = http.createServer();
        
        // Create WebSocket server
        this.wss = new WebSocket.Server({
          server: this.server,
          clientTracking: true,
          maxPayload: 64 * 1024, // 64KB
          perMessageDeflate: this.options.enableCompression ? {
            zlibDeflateOptions: {
              level: 6,
              chunkSize: 32 * 1024
            }
          } : false
        });

        this.wss.on('connection', (ws: WebSocket, request) => this.handleConnection(ws, request));
        this.wss.on('error', (error) => this.handleServerError(error));
        this.wss.on('close', () => this.emit('server-closed'));

        // Start HTTP server
        await new Promise<void>((resolve, reject) => {
          this.server!.listen(this.options.port, this.options.host, () => {
            this.log(`WebSocket server listening on ${this.options.host}:${this.options.port}`);
            resolve();
          });
          this.server!.on('error', reject);
        });

        this.isStarted = true;
        this.startHeartbeat();
        this.emit('started', { port: this.options.port, host: this.options.host });
      });
    } catch (error) {
      this.emit('start-error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    try {
      this.stopHeartbeat();

      // Close all connections
      const closePromises = Array.from(this.connections.values()).map(conn =>
        this.closeConnection(conn)
      );
      await Promise.allSettled(closePromises);

      // Close WebSocket server
      if (this.wss) {
        await new Promise<void>((resolve) => {
          this.wss!.close(() => resolve());
        });
      }

      // Close HTTP server
      if (this.server) {
        await new Promise<void>((resolve) => {
          this.server!.close(() => resolve());
        });
      }

      this.circuitBreaker.destroy();
      this.retryManager.destroy();

      this.isStarted = false;
      this.emit('stopped');
    } catch (error) {
      this.emit('stop-error', error);
      throw error;
    }
  }

  async send(message: Message): Promise<void> {
    if (!this.isStarted) {
      throw new Error('WebSocket adapter not started');
    }

    const gossipMessage = message as unknown as GossipMessage;
    
    if (gossipMessage.isBroadcast()) {
      await this.broadcast(gossipMessage);
    } else if (gossipMessage.header.recipient) {
      await this.sendToNode(gossipMessage.header.recipient, gossipMessage);
    } else {
      throw new Error('Message must have recipient or be broadcast');
    }
  }

  async connect(nodeId: NodeId): Promise<void> {
    const operationId = `connect-${nodeId.id}`;
    
    await this.retryManager.execute(async () => {
      await this.createOutgoingConnection(nodeId);
    }, operationId);
  }

  private async sendToNode(nodeId: NodeId, message: GossipMessage): Promise<void> {
    const connection = this.connections.get(nodeId.id);
    if (!connection || !connection.isActive) {
      throw new Error(`No active connection to node ${nodeId.id}`);
    }

    await this.sendMessage(connection, message);
  }

  private async broadcast(message: GossipMessage): Promise<void> {
    const activeConnections = Array.from(this.connections.values())
      .filter(conn => conn.isActive);

    if (activeConnections.length === 0) {
      this.emit('broadcast-no-connections', message);
      return;
    }

    const sendPromises = activeConnections.map(async (connection) => {
      try {
        await this.sendMessage(connection, message);
      } catch (error) {
        this.emit('broadcast-error', { connection: connection.nodeId, error });
      }
    });

    await Promise.allSettled(sendPromises);
    this.emit('broadcast-sent', { 
      message: message.header.id, 
      connections: activeConnections.length 
    });
  }

  private async sendMessage(connection: WebSocketConnection, message: GossipMessage): Promise<void> {
    if (connection.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket connection is not open');
    }

    const serialized = message.serialize();
    
    return new Promise<void>((resolve, reject) => {
      connection.ws.send(serialized, (error) => {
        if (error) {
          this.handleConnectionError(connection, error);
          reject(error);
        } else {
          connection.lastActivity = Date.now();
          this.emit('message-sent', { 
            nodeId: connection.nodeId, 
            messageId: message.header.id 
          });
          resolve();
        }
      });
    });
  }

  private async createOutgoingConnection(nodeId: NodeId): Promise<WebSocketConnection> {
    const url = `ws://${nodeId.address}:${nodeId.port}`;
    const ws = new (WebSocket as any)(url, {
      handshakeTimeout: this.options.upgradeTimeout,
      perMessageDeflate: this.options.enableCompression
    });

    const connection: WebSocketConnection = {
      ws,
      nodeId,
      isActive: false,
      lastActivity: Date.now(),
      isAlive: true
    };

    return new Promise<WebSocketConnection>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Connection timeout to ${url}`));
      }, this.options.upgradeTimeout);

      ws.on('open', () => {
        clearTimeout(timeout);
        connection.isActive = true;
        this.connections.set(nodeId.id, connection);
        this.setupConnectionHandlers(connection);
        this.emit('connection-established', nodeId);
        resolve(connection);
      });

      ws.on('error', (error: any) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private handleConnection(ws: WebSocket, request: http.IncomingMessage): void {
    if (this.connections.size >= this.options.maxConnections) {
      this.log(`Max connections reached, rejecting connection from ${request.socket.remoteAddress}`);
      ws.close(1013, 'Server overloaded');
      return;
    }

    // Create temporary connection until we get node identification
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const connection: WebSocketConnection = {
      ws,
      nodeId: { 
        id: tempId, 
        address: request.socket.remoteAddress || 'unknown', 
        port: request.socket.remotePort || 0 
      },
      isActive: true,
      lastActivity: Date.now(),
      isAlive: true
    };

    this.connections.set(tempId, connection);
    this.setupConnectionHandlers(connection);
    this.emit('connection-received', connection.nodeId);
  }

  private setupConnectionHandlers(connection: WebSocketConnection): void {
    connection.ws.on('message', (data) => this.handleMessage(connection, data));
    connection.ws.on('error', (error) => this.handleConnectionError(connection, error));
    connection.ws.on('close', (code, reason) => this.handleConnectionClose(connection, code, reason.toString()));
    connection.ws.on('pong', () => this.handlePong(connection));
  }

  private handleMessage(connection: WebSocketConnection, data: WebSocket.Data): void {
    connection.lastActivity = Date.now();
    
    try {
      const buffer = data instanceof Buffer ? data : Buffer.from(data.toString());
      const message = GossipMessage.deserialize(buffer);
      this.emit('message-received', message, connection.nodeId);
    } catch (error) {
      this.emit('message-parse-error', { error, connection: connection.nodeId });
    }
  }

  private handleConnectionError(connection: WebSocketConnection, error: Error): void {
    connection.isActive = false;
    this.emit('connection-error', { nodeId: connection.nodeId, error });
    this.closeConnection(connection);
  }

  private handleConnectionClose(connection: WebSocketConnection, code: number, reason: string): void {
    connection.isActive = false;
    this.connections.delete(connection.nodeId.id);
    this.emit('connection-closed', { 
      nodeId: connection.nodeId, 
      code, 
      reason: reason.toString() 
    });
  }

  private handlePong(connection: WebSocketConnection): void {
    connection.isAlive = true;
    connection.lastActivity = Date.now();
  }

  private handleServerError(error: Error): void {
    this.emit('server-error', error);
    this.log(`WebSocket server error: ${error.message}`);
  }

  private async closeConnection(connection: WebSocketConnection): Promise<void> {
    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.close(1000, 'Normal closure');
    } else if (connection.ws.readyState === WebSocket.CONNECTING) {
      connection.ws.terminate();
    }
    this.connections.delete(connection.nodeId.id);
  }

  private setupEventHandlers(): void {
    this.circuitBreaker.on('state-change', (data) => {
      this.emit('circuit-breaker-state-change', data);
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      
      this.connections.forEach((connection) => {
        if (!connection.isActive) return;
        
        // Check if connection is stale
        if (!connection.isAlive) {
          this.log(`Terminating stale connection to ${connection.nodeId.id}`);
          connection.ws.terminate();
          return;
        }
        
        // Send ping
        connection.isAlive = false;
        try {
          connection.ws.ping();
        } catch (error) {
          this.handleConnectionError(connection, error as Error);
        }
      });
    }, this.options.pingInterval);
    this.heartbeatTimer?.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  getStats(): {
    isStarted: boolean;
    activeConnections: number;
    totalConnections: number;
    port: number;
    host: string;
  } {
    return {
      isStarted: this.isStarted,
      activeConnections: Array.from(this.connections.values()).filter(c => c.isActive).length,
      totalConnections: this.connections.size,
      port: this.options.port,
      host: this.options.host
    };
  }

  /**
   * Register a callback to handle incoming messages
   */
  onMessage(callback: (message: Message) => void): void {
    this.on('message', callback);
  }

  /**
   * Remove a message listener
   */
  removeMessageListener(callback: (message: Message) => void): void {
    this.off('message', callback);
  }

  /**
   * Get currently connected nodes
   */
  getConnectedNodes(): NodeId[] {
    return Array.from(this.connections.values())
      .filter(conn => conn.isActive)
      .map(conn => conn.nodeId);
  }

  private log(message: string): void {
    console.log(`[WebSocketAdapter:${this.nodeId.id}] ${message}`);
  }
}
