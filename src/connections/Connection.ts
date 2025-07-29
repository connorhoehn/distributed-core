import { EventEmitter } from 'events';
import { Session } from './Session';
import { SendFunction, ConnectionStatus, ConnectionStats, ConnectionConfig } from './types';

export interface Connection {
  on(event: 'message-sent', listener: (message: any) => void): this;
  on(event: 'message-received', listener: (message: any) => void): this;
  on(event: 'closed', listener: (reason?: string) => void): this;
  on(event: 'timeout', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  
  emit(event: 'message-sent', message: any): boolean;
  emit(event: 'message-received', message: any): boolean;
  emit(event: 'closed', reason?: string): boolean;
  emit(event: 'timeout'): boolean;
  emit(event: 'error', error: Error): boolean;
  emit(event: string, ...args: any[]): boolean;
}

export class Connection extends EventEmitter {
  private status: ConnectionStatus = 'active';
  private stats: ConnectionStats;
  private heartbeatTimer?: NodeJS.Timeout;
  private timeoutTimer?: NodeJS.Timeout;
  private readonly config: Required<ConnectionConfig>;

  constructor(
    public readonly id: string,
    private sendFn: SendFunction,
    public readonly session: Session,
    config: ConnectionConfig = {}
  ) {
    super();
    
    this.config = {
      heartbeatInterval: 30000, // 30 seconds
      timeoutMs: 60000,         // 1 minute
      maxMessageSize: 64 * 1024, // 64KB
      ...config
    };

    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      bytesTransferred: 0,
      lastActivity: Date.now(),
      errors: 0
    };

    this.startHeartbeat();
  }

  send(message: object): void {
    if (this.status !== 'active') {
      throw new Error(`Cannot send message on ${this.status} connection`);
    }

    try {
      const encoded = JSON.stringify(message);
      
      if (encoded.length > this.config.maxMessageSize) {
        throw new Error(`Message size ${encoded.length} exceeds limit ${this.config.maxMessageSize}`);
      }

      this.sendFn(encoded);
      this.updateStats('sent', encoded.length);
      this.emit('message-sent', message);
    } catch (error) {
      this.stats.errors++;
      this.emit('error', error);
      throw error;
    }
  }

  sendRaw(data: string | Buffer): void {
    if (this.status !== 'active') {
      throw new Error(`Cannot send data on ${this.status} connection`);
    }

    try {
      const size = typeof data === 'string' ? data.length : data.byteLength;
      
      if (size > this.config.maxMessageSize) {
        throw new Error(`Data size ${size} exceeds limit ${this.config.maxMessageSize}`);
      }

      this.sendFn(data);
      this.updateStats('sent', size);
      this.emit('data-sent', data);
    } catch (error) {
      this.stats.errors++;
      this.emit('error', error);
      throw error;
    }
  }

  close(reason?: string): void {
    if (this.status === 'closed') return;

    this.status = 'closed';
    this.session.markClosed();
    this.cleanup();
    this.emit('closed', reason);
  }

  ping(): void {
    if (this.status === 'active') {
      this.send({ type: 'ping', timestamp: Date.now() });
    }
  }

  pong(data?: any): void {
    if (this.status === 'active') {
      this.send({ type: 'pong', timestamp: Date.now(), data });
    }
  }

  markActivity(): void {
    this.stats.lastActivity = Date.now();
    this.session.updateLastActivity();
    this.resetTimeout();
  }

  onMessageReceived(message: any): void {
    this.markActivity();
    const size = JSON.stringify(message).length;
    this.updateStats('received', size);
    this.emit('message-received', message);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getStats(): Readonly<ConnectionStats> {
    return { ...this.stats };
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  getIdleTime(): number {
    return Date.now() - this.stats.lastActivity;
  }

  private updateStats(direction: 'sent' | 'received', bytes: number): void {
    if (direction === 'sent') {
      this.stats.messagesSent++;
    } else {
      this.stats.messagesReceived++;
    }
    this.stats.bytesTransferred += bytes;
    this.stats.lastActivity = Date.now();
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.status === 'active') {
        this.ping();
      }
    }, this.config.heartbeatInterval);

    this.resetTimeout();
  }

  private resetTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
    }

    this.timeoutTimer = setTimeout(() => {
      if (this.status === 'active') {
        this.status = 'idle';
        this.emit('timeout');
        this.close('timeout');
      }
    }, this.config.timeoutMs);
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }

    this.removeAllListeners();
  }
}
