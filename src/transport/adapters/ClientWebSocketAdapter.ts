import WebSocket = require('ws');
import * as http from 'http';
import { EventEmitter } from 'events';
import { NodeId } from '../../types';

export interface ClientConnection {
  id: string;
  ws: WebSocket;
  isActive: boolean;
  lastActivity: number;
  metadata: Record<string, any>;
}

export interface ClientMessage {
  type: string;
  data: any;
  clientId?: string;
  timestamp?: number;
}

export interface ClientWebSocketAdapterOptions {
  port?: number;
  host?: string;
  path?: string;
  maxConnections?: number;
  pingInterval?: number;
  enableLogging?: boolean;
  enableCompression?: boolean;
}

/**
 * WebSocket adapter specifically for external client connections
 * Separate from cluster transport - handles application-level client communication
 */
export class ClientWebSocketAdapter extends EventEmitter {
  private readonly options: Required<ClientWebSocketAdapterOptions>;
  private server?: http.Server;
  private wss?: WebSocket.Server;
  private connections = new Map<string, ClientConnection>();
  private isStarted = false;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(options: ClientWebSocketAdapterOptions = {}) {
    super();
    
    this.options = {
      port: options.port !== undefined ? options.port : 3001,
      host: options.host || '0.0.0.0',
      path: options.path || '/ws',
      maxConnections: options.maxConnections || 1000,
      pingInterval: options.pingInterval || 30000,
      enableLogging: options.enableLogging !== false,
      enableCompression: options.enableCompression !== false
    };
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    // Create HTTP server
    this.server = http.createServer();
    
    // Create WebSocket server
    this.wss = new WebSocket.Server({
      server: this.server,
      path: this.options.path,
      clientTracking: true,
      maxPayload: 1024 * 1024, // 1MB for client messages
      perMessageDeflate: this.options.enableCompression ? {
        zlibDeflateOptions: {
          level: 6,
          chunkSize: 32 * 1024
        }
      } : false
    });

    this.setupServerHandlers();

    // Start HTTP server
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.options.port, this.options.host, () => {
        if (this.options.enableLogging) {
          console.log(`ClientWebSocketAdapter listening on ${this.options.host}:${this.options.port}${this.options.path}`);
        }
        resolve();
      });
      this.server!.on('error', reject);
    });

    this.startHeartbeat();
    this.isStarted = true;
    this.emit('started', { port: this.options.port, host: this.options.host });
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    this.stopHeartbeat();

    // Close all client connections
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

    this.isStarted = false;
    this.emit('stopped');
  }

  private setupServerHandlers(): void {
    this.wss!.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
      this.handleNewConnection(ws, request);
    });

    this.wss!.on('error', (error: Error) => {
      this.emit('server-error', error);
      if (this.options.enableLogging) {
        console.error('WebSocket server error:', error);
      }
    });
  }

  private handleNewConnection(ws: WebSocket, request: http.IncomingMessage): void {
    if (this.connections.size >= this.options.maxConnections) {
      if (this.options.enableLogging) {
        console.log(`Max connections reached, rejecting connection from ${request.socket.remoteAddress}`);
      }
      ws.close(1013, 'Server overloaded');
      return;
    }

    const clientId = this.generateClientId();
    const connection: ClientConnection = {
      id: clientId,
      ws,
      isActive: true,
      lastActivity: Date.now(),
      metadata: {
        remoteAddress: request.socket.remoteAddress,
        remotePort: request.socket.remotePort,
        userAgent: request.headers['user-agent']
      }
    };

    this.connections.set(clientId, connection);
    this.setupConnectionHandlers(connection);

    if (this.options.enableLogging) {
      console.log(`Client ${clientId} connected from ${request.socket.remoteAddress}`);
    }

    // Send welcome message
    this.sendToClient(clientId, {
      type: 'welcome',
      data: {
        clientId,
        timestamp: Date.now()
      }
    });

    this.emit('client-connected', { clientId, connection });
  }

  private setupConnectionHandlers(connection: ClientConnection): void {
    connection.ws.on('message', (data: WebSocket.Data) => {
      this.handleClientMessage(connection, data);
    });

    connection.ws.on('error', (error: Error) => {
      this.handleConnectionError(connection, error);
    });

    connection.ws.on('close', (code: number, reason: Buffer) => {
      this.handleConnectionClose(connection, code, reason);
    });

    connection.ws.on('pong', () => {
      connection.lastActivity = Date.now();
    });
  }

  private handleClientMessage(connection: ClientConnection, data: WebSocket.Data): void {
    connection.lastActivity = Date.now();

    try {
      const rawMessage = data.toString();
      const message: ClientMessage = JSON.parse(rawMessage);
      
      // Add client context
      message.clientId = connection.id;
      message.timestamp = Date.now();

      this.emit('client-message', { clientId: connection.id, message, connection });

      if (this.options.enableLogging) {
        console.log(`Message from client ${connection.id}: ${message.type}`);
      }

    } catch (error) {
      this.emit('message-parse-error', { 
        clientId: connection.id, 
        error, 
        rawData: data.toString() 
      });
      
      this.sendToClient(connection.id, {
        type: 'error',
        data: { message: 'Invalid message format' }
      });
    }
  }

  private handleConnectionError(connection: ClientConnection, error: Error): void {
    connection.isActive = false;
    this.emit('connection-error', { clientId: connection.id, error });
    this.closeConnection(connection);
  }

  private handleConnectionClose(connection: ClientConnection, code: number, reason: Buffer): void {
    connection.isActive = false;
    this.connections.delete(connection.id);
    
    if (this.options.enableLogging) {
      console.log(`Client ${connection.id} disconnected with code ${code}: ${reason.toString()}`);
    }

    this.emit('client-disconnected', { 
      clientId: connection.id, 
      code, 
      reason: reason.toString(),
      connection 
    });
  }

  private async closeConnection(connection: ClientConnection): Promise<void> {
    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.close();
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      
      for (const connection of this.connections.values()) {
        if (connection.isActive && connection.ws.readyState === WebSocket.OPEN) {
          // Check for stale connections
          if (now - connection.lastActivity > this.options.pingInterval * 2) {
            this.closeConnection(connection);
          } else {
            // Send ping
            connection.ws.ping();
          }
        }
      }
    }, this.options.pingInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  // Public API methods

  /**
   * Send message to a specific client
   */
  sendToClient(clientId: string, message: ClientMessage): boolean {
    const connection = this.connections.get(clientId);
    if (!connection || !connection.isActive || connection.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      const serialized = JSON.stringify(message);
      connection.ws.send(serialized);
      return true;
    } catch (error) {
      this.emit('send-error', { clientId, error, message });
      return false;
    }
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(message: ClientMessage, excludeClientId?: string): number {
    let sentCount = 0;
    
    for (const [clientId, connection] of this.connections) {
      if (excludeClientId && clientId === excludeClientId) {
        continue;
      }
      
      if (this.sendToClient(clientId, message)) {
        sentCount++;
      }
    }
    
    return sentCount;
  }

  /**
   * Broadcast to clients matching a filter
   */
  broadcastToMatching(
    message: ClientMessage, 
    filter: (connection: ClientConnection) => boolean
  ): number {
    let sentCount = 0;
    
    for (const connection of this.connections.values()) {
      if (filter(connection) && this.sendToClient(connection.id, message)) {
        sentCount++;
      }
    }
    
    return sentCount;
  }

  /**
   * Get all connected client IDs
   */
  getConnectedClients(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Get connection count
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Get connection info
   */
  getConnectionInfo(clientId: string): ClientConnection | undefined {
    return this.connections.get(clientId);
  }

  /**
   * Disconnect a specific client
   */
  disconnectClient(clientId: string, code: number = 1000, reason: string = 'Disconnected by server'): boolean {
    const connection = this.connections.get(clientId);
    if (!connection) {
      return false;
    }

    connection.ws.close(code, reason);
    return true;
  }

  private generateClientId(): string {
    return `client-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  private log(...args: any[]): void {
    if (this.options.enableLogging) {
      console.log('[ClientWebSocketAdapter]', ...args);
    }
  }
}
