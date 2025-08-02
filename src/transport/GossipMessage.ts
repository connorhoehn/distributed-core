import { EventEmitter } from 'events';
import { NodeId } from '../types';

export enum MessageType {
  HEARTBEAT = 'heartbeat',
  JOIN = 'join',
  LEAVE = 'leave',
  DATA = 'data',
  SYNC = 'sync',
  ACK = 'ack',
  PING = 'ping',
  PONG = 'pong',
  BROADCAST = 'broadcast'
}

export enum MessagePriority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  URGENT = 3
}

export interface MessageHeader {
  id: string;
  type: MessageType;
  version: string;
  timestamp: number;
  sender: NodeId;
  recipient?: NodeId;
  priority: MessagePriority;
  ttl: number;
  compression?: string;
  encryption?: boolean;
  checksum: string;
}

export interface MessagePayload {
  data: any;
  metadata?: Record<string, any>;
}

export interface MessageMetrics {
  sendTime: number;
  receiveTime?: number;
  processingTime?: number;
  retryCount: number;
  hopCount: number;
}

/**
 * Gossip message implementation for distributed communication
 * Supports compression, encryption, routing, and lifecycle management
 */
export class GossipMessage extends EventEmitter {
  public readonly header: MessageHeader;
  public readonly payload: MessagePayload;
  public readonly metrics: MessageMetrics;
  private _isDelivered: boolean = false;
  private _isExpired: boolean = false;

  constructor(
    type: MessageType,
    sender: NodeId,
    data: any,
    options: {
      recipient?: NodeId;
      priority?: MessagePriority;
      ttl?: number;
      metadata?: Record<string, any>;
      compression?: string;
      encryption?: boolean;
    } = {}
  ) {
    super();

    const now = Date.now();
    this.header = {
      id: this.generateMessageId(),
      type,
      version: '1.0',
      timestamp: now,
      sender,
      recipient: options.recipient,
      priority: options.priority || MessagePriority.NORMAL,
      ttl: options.ttl || 30000, // 30 seconds default
      compression: options.compression,
      encryption: options.encryption || false,
      checksum: this.calculateChecksum(data)
    };

    this.payload = {
      data,
      metadata: options.metadata
    };

    this.metrics = {
      sendTime: now,
      retryCount: 0,
      hopCount: 0
    };
  }

  /**
   * Get message as serializable object
   */
  toJSON(): any {
    return {
      header: this.header,
      payload: this.payload,
      metrics: this.metrics
    };
  }

  /**
   * Create message from JSON
   */
  static fromJSON(json: any): GossipMessage {
    const message = Object.create(GossipMessage.prototype);
    Object.assign(message, json);
    EventEmitter.call(message);
    return message;
  }

  /**
   * Serialize message to buffer
   */
  serialize(): Buffer {
    const json = this.toJSON();
    return Buffer.from(JSON.stringify(json), 'utf8');
  }

  /**
   * Deserialize message from buffer
   */
  static deserialize(buffer: Buffer): GossipMessage {
    const json = JSON.parse(buffer.toString('utf8'));
    return GossipMessage.fromJSON(json);
  }

  /**
   * Clone message with new recipient
   */
  clone(newRecipient?: NodeId): GossipMessage {
    const cloned = GossipMessage.fromJSON(this.toJSON());
    if (newRecipient) {
      cloned.header.recipient = newRecipient;
    }
    cloned.metrics.hopCount++;
    return cloned;
  }

  /**
   * Check if message is expired
   */
  isExpired(): boolean {
    if (this._isExpired) return true;
    
    const now = Date.now();
    const elapsed = now - this.header.timestamp;
    this._isExpired = elapsed > this.header.ttl;
    
    if (this._isExpired) {
      this.emit('expired', this);
    }
    
    return this._isExpired;
  }

  /**
   * Mark message as delivered
   */
  markDelivered(): void {
    if (this._isDelivered) return;
    
    this._isDelivered = true;
    this.metrics.receiveTime = Date.now();
    this.emit('delivered', this);
  }

  /**
   * Check if message is delivered
   */
  isDelivered(): boolean {
    return this._isDelivered;
  }

  /**
   * Increment retry count
   */
  incrementRetry(): void {
    this.metrics.retryCount++;
    this.emit('retry', this.metrics.retryCount);
  }

  /**
   * Update processing metrics
   */
  updateProcessingTime(): void {
    if (this.metrics.receiveTime) {
      this.metrics.processingTime = Date.now() - this.metrics.receiveTime;
    }
  }

  /**
   * Get message age in milliseconds
   */
  getAge(): number {
    return Date.now() - this.header.timestamp;
  }

  /**
   * Get remaining TTL in milliseconds
   */
  getRemainingTTL(): number {
    return Math.max(0, this.header.ttl - this.getAge());
  }

  /**
   * Check if message is for a specific recipient
   */
  isForRecipient(nodeId: NodeId): boolean {
    return this.header.recipient?.id === nodeId.id;
  }

  /**
   * Check if message is broadcast
   */
  isBroadcast(): boolean {
    return !this.header.recipient;
  }

  /**
   * Get message size in bytes
   */
  getSize(): number {
    return this.serialize().length;
  }

  /**
   * Validate message integrity
   */
  isValid(): boolean {
    const currentChecksum = this.calculateChecksum(this.payload.data);
    return currentChecksum === this.header.checksum;
  }

  /**
   * Generate unique message ID
   */
  private generateMessageId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `msg_${timestamp}_${random}`;
  }

  /**
   * Calculate message checksum
   */
  private calculateChecksum(data: any): string {
    const crypto = require('crypto');
    const serialized = JSON.stringify(data);
    return crypto.createHash('sha256').update(serialized).digest('hex').substring(0, 16);
  }

  /**
   * Get message summary for logging
   */
  getSummary(): string {
    return `${this.header.type}:${this.header.id} from ${this.header.sender.id} ` +
           `(age: ${this.getAge()}ms, size: ${this.getSize()}b, hops: ${this.metrics.hopCount})`;
  }
}

/**
 * Message factory for creating different types of messages
 */
export class MessageFactory {
  static heartbeat(sender: NodeId, data: any = {}): GossipMessage {
    return new GossipMessage(MessageType.HEARTBEAT, sender, data, {
      priority: MessagePriority.HIGH,
      ttl: 10000 // 10 seconds for heartbeats
    });
  }

  static join(sender: NodeId, nodeInfo: any): GossipMessage {
    return new GossipMessage(MessageType.JOIN, sender, nodeInfo, {
      priority: MessagePriority.HIGH,
      ttl: 60000 // 1 minute for join messages
    });
  }

  static leave(sender: NodeId, reason?: string): GossipMessage {
    return new GossipMessage(MessageType.LEAVE, sender, { reason }, {
      priority: MessagePriority.HIGH,
      ttl: 30000
    });
  }

  static data(sender: NodeId, data: any, recipient?: NodeId): GossipMessage {
    return new GossipMessage(MessageType.DATA, sender, data, {
      recipient,
      priority: MessagePriority.NORMAL,
      ttl: 120000 // 2 minutes for data
    });
  }

  static broadcast(sender: NodeId, data: any): GossipMessage {
    return new GossipMessage(MessageType.BROADCAST, sender, data, {
      priority: MessagePriority.NORMAL,
      ttl: 60000
    });
  }

  static ping(sender: NodeId, recipient: NodeId): GossipMessage {
    return new GossipMessage(MessageType.PING, sender, { timestamp: Date.now() }, {
      recipient,
      priority: MessagePriority.HIGH,
      ttl: 5000 // 5 seconds for pings
    });
  }

  static pong(sender: NodeId, recipient: NodeId, pingTimestamp: number): GossipMessage {
    return new GossipMessage(MessageType.PONG, sender, { 
      pingTimestamp, 
      pongTimestamp: Date.now() 
    }, {
      recipient,
      priority: MessagePriority.HIGH,
      ttl: 5000
    });
  }
}
