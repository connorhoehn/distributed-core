// Node.js environment access
declare const console: any;

export interface BackpressureConfig {
  maxQueuePerConnection: number;
  writeTimeoutMs: number;
  dropPolicy: 'oldest' | 'newest' | 'error';
  slowConsumerThresholdMs: number;
  maxRetries: number;
}

export interface QueuedMessage {
  data: any;
  meta: {
    opId?: string;
    priority?: number;
    enqueuedAt: number;
  };
}

export interface OutboundQueue {
  offer(data: any, meta: { opId?: string; priority?: number }): 'enqueued' | 'dropped' | 'error';
  drain(writer: (data: any) => Promise<void>): Promise<void>;
  size(): number;
  clear(): void;
  isFull(): boolean;
  getOldestMessageAge(): number;
}

export interface BackpressureStats {
  queueSize: number;
  totalEnqueued: number;
  totalDropped: number;
  totalDelivered: number;
  oldestMessageAge: number;
  isSlowConsumer: boolean;
}

/**
 * Simple bounded FIFO queue with configurable drop policies
 */
export class BoundedQueue implements OutboundQueue {
  private queue: QueuedMessage[] = [];
  private stats = {
    totalEnqueued: 0,
    totalDropped: 0,
    totalDelivered: 0
  };

  constructor(
    private config: BackpressureConfig,
    private connectionId: string
  ) {}

  offer(data: any, meta: { opId?: string; priority?: number } = {}): 'enqueued' | 'dropped' | 'error' {
    const message: QueuedMessage = {
      data,
      meta: {
        ...meta,
        enqueuedAt: Date.now()
      }
    };

    if (this.isFull()) {
      return this.handleFullQueue(message);
    }

    this.queue.push(message);
    this.stats.totalEnqueued++;
    return 'enqueued';
  }

  private handleFullQueue(message: QueuedMessage): 'dropped' | 'error' {
    switch (this.config.dropPolicy) {
      case 'oldest':
        // Drop oldest message and add new one
        const dropped = this.queue.shift();
        this.queue.push(message);
        this.stats.totalDropped++;
        console.log(`📉 Dropped oldest message for connection ${this.connectionId}, opId: ${dropped?.meta.opId}`);
        return 'dropped';

      case 'newest':
        // Drop the new message
        this.stats.totalDropped++;
        console.log(`📉 Dropped newest message for connection ${this.connectionId}, opId: ${message.meta.opId}`);
        return 'dropped';

      case 'error':
        // Return error without dropping
        console.warn(`🚫 Queue full for connection ${this.connectionId}, rejecting message`);
        return 'error';

      default:
        return 'error';
    }
  }

  async drain(writer: (data: any) => Promise<void>): Promise<void> {
    const startTime = Date.now();
    let processed = 0;

    while (this.queue.length > 0) {
      const message = this.queue.shift()!;
      
      try {
        await writer(message.data);
        this.stats.totalDelivered++;
        processed++;

        // Check for timeout
        if (Date.now() - startTime > this.config.writeTimeoutMs) {
          console.warn(`⏰ Write timeout for connection ${this.connectionId}, processed ${processed} messages`);
          break;
        }
      } catch (error) {
        console.error(`❌ Failed to write message for connection ${this.connectionId}:`, error);
        
        // Put message back at front of queue for retry
        this.queue.unshift(message);
        break;
      }
    }
  }

  size(): number {
    return this.queue.length;
  }

  clear(): void {
    this.stats.totalDropped += this.queue.length;
    this.queue = [];
  }

  isFull(): boolean {
    return this.queue.length >= this.config.maxQueuePerConnection;
  }

  getOldestMessageAge(): number {
    if (this.queue.length === 0) {
      return 0;
    }
    return Date.now() - this.queue[0].meta.enqueuedAt;
  }

  getStats(): BackpressureStats {
    return {
      queueSize: this.queue.length,
      totalEnqueued: this.stats.totalEnqueued,
      totalDropped: this.stats.totalDropped,
      totalDelivered: this.stats.totalDelivered,
      oldestMessageAge: this.getOldestMessageAge(),
      isSlowConsumer: this.getOldestMessageAge() > this.config.slowConsumerThresholdMs
    };
  }
}

/**
 * Manages backpressure for all connections
 */
export class ConnectionBackpressureManager {
  private queues = new Map<string, OutboundQueue>();
  private defaultConfig: BackpressureConfig;

  constructor(config: Partial<BackpressureConfig> = {}) {
    this.defaultConfig = {
      maxQueuePerConnection: 1000,
      writeTimeoutMs: 5000,
      dropPolicy: 'oldest',
      slowConsumerThresholdMs: 10000,
      maxRetries: 3,
      ...config
    };
  }

  getQueue(connectionId: string): OutboundQueue {
    if (!this.queues.has(connectionId)) {
      this.queues.set(connectionId, new BoundedQueue(this.defaultConfig, connectionId));
    }
    return this.queues.get(connectionId)!;
  }

  removeQueue(connectionId: string): void {
    const queue = this.queues.get(connectionId);
    if (queue) {
      queue.clear();
      this.queues.delete(connectionId);
      console.log(`🗑️ Removed queue for connection ${connectionId}`);
    }
  }

  async enforceBackpressure(connectionId: string, writer: (data: any) => Promise<void>): Promise<void> {
    const queue = this.getQueue(connectionId);
    await queue.drain(writer);
  }

  getStats(connectionId: string): BackpressureStats | null {
    const queue = this.queues.get(connectionId);
    if (queue instanceof BoundedQueue) {
      return queue.getStats();
    }
    return null;
  }

  getAllStats(): Map<string, BackpressureStats> {
    const stats = new Map<string, BackpressureStats>();
    for (const [connectionId, queue] of this.queues) {
      if (queue instanceof BoundedQueue) {
        stats.set(connectionId, queue.getStats());
      }
    }
    return stats;
  }

  updateConfig(config: Partial<BackpressureConfig>): void {
    this.defaultConfig = { ...this.defaultConfig, ...config };
  }

  getConfig(): BackpressureConfig {
    return { ...this.defaultConfig };
  }
}
