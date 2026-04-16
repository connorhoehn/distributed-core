import * as net from 'net';
import * as tls from 'tls';
import { Transport } from '../Transport';
import { NodeId, Message } from '../../types';
import { CircuitBreaker } from '../CircuitBreaker';
import { RetryManager } from '../RetryManager';
import { Logger } from '../../common/logger';

interface TCPConnection {
  socket: net.Socket;
  nodeId: NodeId;
  isActive: boolean;
  lastActivity: number;
  messageBuffer: Buffer;
}

interface TLSOptions {
  enabled: boolean;
  key?: string | Buffer;    // PEM private key
  cert?: string | Buffer;   // PEM certificate
  ca?: string | Buffer;     // PEM CA certificate (for client verification)
  rejectUnauthorized?: boolean; // default true
}

interface TCPAdapterOptions {
  port?: number;
  host?: string;
  maxConnections?: number;
  connectionTimeout?: number;
  keepAliveInterval?: number;
  enableNagle?: boolean;
  enableLogging?: boolean;
  tls?: TLSOptions;
  // Test-specific options for faster failures
  maxRetries?: number;
  baseRetryDelay?: number;
  circuitBreakerTimeout?: number;
}

/**
 * TCP transport adapter for reliable, persistent connections
 * Provides low-latency, high-throughput communication with connection pooling
 */
export class TCPAdapter extends Transport {
  private readonly nodeId: NodeId;
  private readonly options: Required<Omit<TCPAdapterOptions, 'tls'>> & { tls: TLSOptions };
  private server?: net.Server | tls.Server;
  private connections = new Map<string, TCPConnection>();
  private isStarted = false;
  private circuitBreaker: CircuitBreaker;
  private retryManager: RetryManager;
  private keepAliveTimer?: NodeJS.Timeout;
  private messageHandlers: Set<(message: Message) => void> = new Set();
  private readonly logger = Logger.create('TCPAdapter');

  private _canSend = true;
  private _queueDepth = 0;

  private static readonly MESSAGE_DELIMITER = '\n\n';
  private static readonly MAX_MESSAGE_SIZE = 64 * 1024; // 64KB

  constructor(nodeId: NodeId, options: TCPAdapterOptions = {}) {
    super();
    this.nodeId = nodeId;
    this.options = {
      port: options.port || 9090,
      host: options.host || '0.0.0.0',
      maxConnections: options.maxConnections || 100,
      connectionTimeout: options.connectionTimeout || 30000,
      keepAliveInterval: options.keepAliveInterval || 60000,
      enableNagle: options.enableNagle !== false,
      enableLogging: options.enableLogging ?? true,
      tls: options.tls ?? { enabled: false },
      maxRetries: options.maxRetries ?? 3,
      baseRetryDelay: options.baseRetryDelay ?? 1000,
      circuitBreakerTimeout: options.circuitBreakerTimeout ?? 10000
    };

    this.circuitBreaker = new CircuitBreaker({
      name: `tcp-adapter-${nodeId.id}`,
      failureThreshold: 5,
      timeout: this.options.circuitBreakerTimeout,
      enableLogging: this.options.enableLogging
    });

    this.retryManager = new RetryManager({
      maxRetries: this.options.maxRetries,
      baseDelay: this.options.baseRetryDelay,
      enableLogging: this.options.enableLogging
    });
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    // Emit deprecation warning
    process.emitWarning(
      'Calling start() is no longer necessary. It can be safely omitted.',
      'DeprecationWarning'
    );

    try {
      await this.circuitBreaker.execute(async () => {
        if (this.options.tls.enabled) {
          this.server = tls.createServer({
            key: this.options.tls.key,
            cert: this.options.tls.cert,
            ca: this.options.tls.ca ? [this.options.tls.ca] : undefined,
            requestCert: !!this.options.tls.ca,
            rejectUnauthorized: this.options.tls.rejectUnauthorized ?? true,
            allowHalfOpen: false,
            pauseOnConnect: false
          });
        } else {
          this.server = net.createServer({
            allowHalfOpen: false,
            pauseOnConnect: false
          });
        }

        const connectionEvent = this.options.tls.enabled ? 'secureConnection' : 'connection';
        this.server.on(connectionEvent, (socket: net.Socket) => this.handleIncomingConnection(socket));
        this.server.on('error', (error) => this.handleServerError(error));
        this.server.on('close', () => this.emit('server-closed'));

        await new Promise<void>((resolve, reject) => {
          this.server!.listen(this.options.port, this.options.host, () => {
            this.log(`TCP server listening on ${this.options.host}:${this.options.port}`);
            resolve();
          });
          this.server!.on('error', reject);
        });

        this.isStarted = true;
        this.startKeepAlive();
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
      this.stopKeepAlive();
      
      // Close all connections
      const closePromises = Array.from(this.connections.values()).map(conn => 
        this.closeConnection(conn)
      );
      await Promise.all(closePromises);

      // Close server
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

  async send(message: Message, target: NodeId): Promise<void> {
    if (!this.isStarted) {
      // Auto-start if not already started
      await this.start();
    }

    const operationId = `send-${target.id}-${Date.now()}`;
    
    await this.retryManager.execute(async () => {
      const connection = await this.getOrCreateConnection(target);
      await this.sendMessage(connection, message);
    }, operationId);
  }

  onMessage(callback: (message: Message) => void): void {
    this.messageHandlers.add(callback);
  }

  removeMessageListener(callback: (message: Message) => void): void {
    this.messageHandlers.delete(callback);
  }

  getConnectedNodes(): NodeId[] {
    return Array.from(this.connections.values())
      .filter(conn => conn.isActive)
      .map(conn => conn.nodeId);
  }

  getLocalNodeInfo(): NodeId {
    return this.nodeId;
  }

  override canSend(): boolean {
    return this._canSend;
  }

  override getQueueDepth(): number {
    return this._queueDepth;
  }

  private async sendMessage(connection: TCPConnection, message: Message): Promise<void> {
    if (!connection.isActive) {
      throw new Error('Connection is not active');
    }

    const serialized = this.serializeMessage(message);
    const messageWithDelimiter = Buffer.concat([
      serialized,
      Buffer.from(TCPAdapter.MESSAGE_DELIMITER, 'utf8')
    ]);

    this._queueDepth++;

    return new Promise<void>((resolve, reject) => {
      const flushed = connection.socket.write(messageWithDelimiter, (error) => {
        this._queueDepth--;
        if (error) {
          this.handleConnectionError(connection, error);
          reject(error);
        } else {
          connection.lastActivity = Date.now();
          this.emit('message-sent', { nodeId: connection.nodeId });
          resolve();
        }
      });

      if (!flushed && this._canSend) {
        this._canSend = false;
        this.emit('backpressure');
      }
    });
  }

  private async getOrCreateConnection(nodeId: NodeId): Promise<TCPConnection> {
    const existingConnection = this.connections.get(nodeId.id);
    if (existingConnection && existingConnection.isActive) {
      return existingConnection;
    }

    return this.createOutgoingConnection(nodeId);
  }

  private async createOutgoingConnection(nodeId: NodeId): Promise<TCPConnection> {
    let socket: net.Socket;

    if (this.options.tls.enabled) {
      socket = tls.connect({
        host: nodeId.address,
        port: nodeId.port!,
        key: this.options.tls.key,
        cert: this.options.tls.cert,
        ca: this.options.tls.ca ? [this.options.tls.ca] : undefined,
        rejectUnauthorized: this.options.tls.rejectUnauthorized ?? true
      });
    } else {
      socket = new net.Socket();
    }

    // Configure socket options
    socket.setNoDelay(!this.options.enableNagle);
    socket.setKeepAlive(true, this.options.keepAliveInterval);
    socket.setTimeout(this.options.connectionTimeout);

    const connection: TCPConnection = {
      socket,
      nodeId,
      isActive: false,
      lastActivity: Date.now(),
      messageBuffer: Buffer.alloc(0)
    };

    return new Promise<TCPConnection>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${nodeId.address}:${nodeId.port}`));
      }, this.options.connectionTimeout);

      if (this.options.tls.enabled) {
        // TLS socket connects during tls.connect(), wait for 'secureConnect'
        (socket as tls.TLSSocket).on('secureConnect', () => {
          clearTimeout(timeout);
          connection.isActive = true;
          this.connections.set(nodeId.id, connection);
          this.setupConnectionHandlers(connection);
          this.emit('connection-established', nodeId);
          resolve(connection);
        });
      } else {
        socket.connect(nodeId.port!, nodeId.address, () => {
          clearTimeout(timeout);
          connection.isActive = true;
          this.connections.set(nodeId.id, connection);
          this.setupConnectionHandlers(connection);
          this.emit('connection-established', nodeId);
          resolve(connection);
        });
      }

      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private handleIncomingConnection(socket: net.Socket): void {
    if (this.connections.size >= this.options.maxConnections) {
      this.log(`Max connections reached, rejecting connection from ${socket.remoteAddress}`);
      socket.end();
      return;
    }

    // Configure socket
    socket.setNoDelay(!this.options.enableNagle);
    socket.setKeepAlive(true, this.options.keepAliveInterval);
    socket.setTimeout(this.options.connectionTimeout);

    // Create temporary connection until we get node identification
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const connection: TCPConnection = {
      socket,
      nodeId: { id: tempId, address: socket.remoteAddress || 'unknown', port: socket.remotePort || 0 },
      isActive: true,
      lastActivity: Date.now(),
      messageBuffer: Buffer.alloc(0)
    };

    this.connections.set(tempId, connection);
    this.setupConnectionHandlers(connection);
    this.emit('connection-received', connection.nodeId);
  }

  private setupConnectionHandlers(connection: TCPConnection): void {
    connection.socket.on('data', (data) => this.handleConnectionData(connection, data));
    connection.socket.on('error', (error) => this.handleConnectionError(connection, error));
    connection.socket.on('close', () => this.handleConnectionClose(connection));
    connection.socket.on('timeout', () => this.handleConnectionTimeout(connection));
    connection.socket.on('drain', () => {
      if (!this._canSend) {
        this._canSend = true;
        this.emit('drain');
      }
    });
  }

  private handleConnectionData(connection: TCPConnection, data: Buffer): void {
    connection.lastActivity = Date.now();
    connection.messageBuffer = Buffer.concat([connection.messageBuffer, data]);

    // Process complete messages
    let delimiterIndex: number;
    while ((delimiterIndex = connection.messageBuffer.indexOf(TCPAdapter.MESSAGE_DELIMITER)) !== -1) {
      const messageData = connection.messageBuffer.slice(0, delimiterIndex);
      connection.messageBuffer = connection.messageBuffer.slice(delimiterIndex + TCPAdapter.MESSAGE_DELIMITER.length);

      try {
        const message = this.deserializeMessage(messageData);
        this.messageHandlers.forEach(handler => {
          try {
            handler(message);
          } catch (error) {
            this.emit('handler-error', { error, connection: connection.nodeId });
          }
        });
      } catch (error) {
        this.emit('message-parse-error', { error, connection: connection.nodeId });
      }
    }

    // Prevent buffer overflow
    if (connection.messageBuffer.length > TCPAdapter.MAX_MESSAGE_SIZE) {
      this.log(`Message buffer overflow for ${connection.nodeId.id}, closing connection`);
      this.closeConnection(connection);
    }
  }

  private handleConnectionError(connection: TCPConnection, error: Error): void {
    connection.isActive = false;
    this.emit('connection-error', { nodeId: connection.nodeId, error });
    this.closeConnection(connection);
  }

  private handleConnectionClose(connection: TCPConnection): void {
    connection.isActive = false;
    this.connections.delete(connection.nodeId.id);
    this.emit('connection-closed', connection.nodeId);
  }

  private handleConnectionTimeout(connection: TCPConnection): void {
    this.log(`Connection timeout for ${connection.nodeId.id}`);
    this.closeConnection(connection);
  }

  private handleServerError(error: Error): void {
    this.emit('server-error', error);
    this.log(`TCP server error: ${error.message}`);
  }

  private async closeConnection(connection: TCPConnection): Promise<void> {
    if (!connection.socket.destroyed) {
      connection.socket.destroy();
    }
    this.connections.delete(connection.nodeId.id);
  }

  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => {
      const now = Date.now();
      const staleConnections = Array.from(this.connections.values())
        .filter(conn => 
          conn.isActive && 
          (now - conn.lastActivity) > this.options.keepAliveInterval * 2
        );

      staleConnections.forEach(conn => {
        this.log(`Closing stale connection to ${conn.nodeId.id}`);
        this.closeConnection(conn);
      });
    }, this.options.keepAliveInterval);
    
    // Unref the timer to prevent hanging in tests
    this.keepAliveTimer?.unref();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  private serializeMessage(message: Message): Buffer {
    // Simple JSON serialization for now
    return Buffer.from(JSON.stringify(message), 'utf8');
  }

  private deserializeMessage(buffer: Buffer): Message {
    // Simple JSON deserialization for now
    return JSON.parse(buffer.toString('utf8'));
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

  private log(message: string): void {
    if (this.options.enableLogging) {
      this.logger.info(message);
    }
  }
}
