import { EventEmitter } from 'events';

export interface BatchOptions {
  maxBatchSize?: number;
  maxBatchSizeBytes?: number;
  flushInterval?: number;
  maxBatchAge?: number;
  enableCompression?: boolean;
  compressionThreshold?: number;
  priorityLevels?: number;
  enableLogging?: boolean;
}

export interface BatchedMessage {
  id: string;
  data: Buffer;
  destination: string;
  priority: number;
  timestamp: number;
  urgent?: boolean;
  metadata?: Record<string, any>;
}

export interface MessageBatch {
  id: string;
  destination: string;
  messages: BatchedMessage[];
  totalSize: number;
  priority: number;
  createdAt: number;
  compressed: boolean;
}

export interface BatchStats {
  totalBatches: number;
  totalMessages: number;
  avgBatchSize: number;
  avgCompressionRatio: number;
  pendingMessages: number;
  queuedDestinations: number;
}

/**
 * Intelligent message batching system with priority queues, compression,
 * and destination-based grouping
 */
export class MessageBatcher extends EventEmitter {
  private messageQueues = new Map<string, BatchedMessage[]>();
  private batchTimers = new Map<string, NodeJS.Timeout>();
  private stats = {
    totalBatches: 0,
    totalMessages: 0,
    totalBytes: 0,
    compressionSavings: 0
  };
  
  private readonly options: Required<BatchOptions>;

  constructor(options: BatchOptions = {}) {
    super();
    
    this.options = {
      maxBatchSize: options.maxBatchSize || 100,
      maxBatchSizeBytes: options.maxBatchSizeBytes || 1024 * 1024, // 1MB
      flushInterval: options.flushInterval || 50, // 50ms
      maxBatchAge: options.maxBatchAge || 5000, // 5 seconds
      enableCompression: options.enableCompression !== false,
      compressionThreshold: options.compressionThreshold || 1024, // 1KB
      priorityLevels: options.priorityLevels || 5,
      enableLogging: options.enableLogging !== false
    };

    this.log('Message batcher initialized');
  }

  /**
   * Add message to batch queue
   */
  addMessage(
    destination: string,
    data: Buffer | string,
    priority: number = 5,
    urgent: boolean = false,
    metadata?: Record<string, any>
  ): string {
    const messageId = this.generateMessageId();
    const dataBuffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    
    const message: BatchedMessage = {
      id: messageId,
      data: dataBuffer,
      destination,
      priority: Math.max(1, Math.min(priority, this.options.priorityLevels)),
      timestamp: Date.now(),
      urgent,
      metadata
    };

    // Handle urgent messages immediately
    if (urgent) {
      this.flushUrgentMessage(message);
      return messageId;
    }

    // Add to queue
    if (!this.messageQueues.has(destination)) {
      this.messageQueues.set(destination, []);
    }

    const queue = this.messageQueues.get(destination)!;
    queue.push(message);
    
    // Sort by priority (higher priority first)
    queue.sort((a, b) => b.priority - a.priority);

    this.emit('message-queued', { messageId, destination, priority, queueSize: queue.length });

    // Check if we should flush immediately
    if (this.shouldFlushQueue(destination)) {
      this.flushDestination(destination);
    } else {
      this.scheduleFlush(destination);
    }

    return messageId;
  }

  /**
   * Add multiple messages in bulk
   */
  addMessages(messages: Array<{
    destination: string;
    data: Buffer | string;
    priority?: number;
    urgent?: boolean;
    metadata?: Record<string, any>;
  }>): string[] {
    const messageIds: string[] = [];
    
    for (const msg of messages) {
      const id = this.addMessage(
        msg.destination,
        msg.data,
        msg.priority,
        msg.urgent,
        msg.metadata
      );
      messageIds.push(id);
    }

    this.emit('bulk-messages-added', { count: messages.length, messageIds });
    return messageIds;
  }

  /**
   * Check if queue should be flushed
   */
  private shouldFlushQueue(destination: string): boolean {
    const queue = this.messageQueues.get(destination);
    if (!queue || queue.length === 0) return false;

    // Check batch size limit
    if (queue.length >= this.options.maxBatchSize) {
      return true;
    }

    // Check batch size in bytes
    const totalBytes = queue.reduce((sum, msg) => sum + msg.data.length, 0);
    if (totalBytes >= this.options.maxBatchSizeBytes) {
      return true;
    }

    // Check if oldest message is too old
    const oldestMessage = queue[queue.length - 1]; // Queue is priority-sorted
    const age = Date.now() - oldestMessage.timestamp;
    if (age >= this.options.maxBatchAge) {
      return true;
    }

    return false;
  }

  /**
   * Schedule flush for destination
   */
  private scheduleFlush(destination: string): void {
    if (this.batchTimers.has(destination)) {
      return; // Timer already scheduled
    }

    const timer = setTimeout(() => {
      this.flushDestination(destination);
    }, this.options.flushInterval);

    this.batchTimers.set(destination, timer);
  }

  /**
   * Flush messages for specific destination
   */
  flushDestination(destination: string): void {
    const queue = this.messageQueues.get(destination);
    if (!queue || queue.length === 0) {
      return;
    }

    // Clear timer
    const timer = this.batchTimers.get(destination);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(destination);
    }

    // Create batch
    const batch = this.createBatch(destination, queue);
    
    // Clear queue
    this.messageQueues.set(destination, []);

    // Emit batch
    this.emit('batch-ready', batch);
    
    // Update stats
    this.updateStats(batch);

    this.log(`Flushed batch for ${destination}: ${batch.messages.length} messages, ${batch.totalSize} bytes`);
  }

  /**
   * Handle urgent message immediately
   */
  private flushUrgentMessage(message: BatchedMessage): void {
    const batch = this.createBatch(message.destination, [message]);
    
    this.emit('urgent-batch-ready', batch);
    this.updateStats(batch);
    
    this.log(`Urgent message sent to ${message.destination}: ${message.data.length} bytes`);
  }

  /**
   * Create message batch
   */
  private createBatch(destination: string, messages: BatchedMessage[]): MessageBatch {
    const batchId = this.generateBatchId();
    const totalSize = messages.reduce((sum, msg) => sum + msg.data.length, 0);
    const avgPriority = messages.reduce((sum, msg) => sum + msg.priority, 0) / messages.length;
    
    let compressed = false;
    
    // Apply compression if enabled and beneficial
    if (this.options.enableCompression && totalSize >= this.options.compressionThreshold) {
      try {
        const compressedMessages = this.compressMessages(messages);
        const compressedSize = compressedMessages.reduce((sum, msg) => sum + msg.data.length, 0);
        
        if (compressedSize < totalSize * 0.9) { // Only use if >10% savings
          messages = compressedMessages;
          compressed = true;
        }
      } catch (error) {
        this.emit('compression-error', { error, destination, batchId });
      }
    }

    return {
      id: batchId,
      destination,
      messages,
      totalSize,
      priority: Math.round(avgPriority),
      createdAt: Date.now(),
      compressed
    };
  }

  /**
   * Compress messages using LZ4 (if available)
   */
  private compressMessages(messages: BatchedMessage[]): BatchedMessage[] {
    try {
      // Try to load LZ4 compression
      const lz4 = require('lz4');
      
      return messages.map(msg => ({
        ...msg,
        data: lz4.encode(msg.data),
        metadata: {
          ...msg.metadata,
          compressed: true,
          originalSize: msg.data.length
        }
      }));
    } catch (error) {
      // LZ4 not available, try built-in zlib
      const zlib = require('zlib');
      
      return messages.map(msg => ({
        ...msg,
        data: zlib.deflateSync(msg.data),
        metadata: {
          ...msg.metadata,
          compressed: true,
          originalSize: msg.data.length,
          compressionType: 'zlib'
        }
      }));
    }
  }

  /**
   * Flush all destinations immediately
   */
  flushAll(): void {
    const destinations = Array.from(this.messageQueues.keys());
    
    for (const destination of destinations) {
      this.flushDestination(destination);
    }

    this.emit('all-flushed', { destinationCount: destinations.length });
    this.log('All destinations flushed');
  }

  /**
   * Flush messages by priority
   */
  flushByPriority(minPriority: number): void {
    let flushedCount = 0;
    
    for (const [destination, queue] of this.messageQueues) {
      const highPriorityMessages = queue.filter(msg => msg.priority >= minPriority);
      
      if (highPriorityMessages.length > 0) {
        const batch = this.createBatch(destination, highPriorityMessages);
        
        // Remove flushed messages from queue
        const remainingMessages = queue.filter(msg => msg.priority < minPriority);
        this.messageQueues.set(destination, remainingMessages);
        
        this.emit('priority-batch-ready', batch);
        this.updateStats(batch);
        flushedCount++;
      }
    }

    this.emit('priority-flush-complete', { minPriority, batchesFlushed: flushedCount });
    this.log(`Priority flush completed: ${flushedCount} batches for priority >= ${minPriority}`);
  }

  /**
   * Get pending message count for destination
   */
  getPendingCount(destination: string): number {
    const queue = this.messageQueues.get(destination);
    return queue ? queue.length : 0;
  }

  /**
   * Get all pending destinations
   */
  getPendingDestinations(): string[] {
    return Array.from(this.messageQueues.keys()).filter(dest => 
      this.messageQueues.get(dest)!.length > 0
    );
  }

  /**
   * Get queue status for destination
   */
  getQueueStatus(destination: string): {
    messageCount: number;
    totalBytes: number;
    oldestMessage?: number;
    avgPriority: number;
    hasTimer: boolean;
  } {
    const queue = this.messageQueues.get(destination) || [];
    
    if (queue.length === 0) {
      return {
        messageCount: 0,
        totalBytes: 0,
        avgPriority: 0,
        hasTimer: false
      };
    }

    const totalBytes = queue.reduce((sum, msg) => sum + msg.data.length, 0);
    const avgPriority = queue.reduce((sum, msg) => sum + msg.priority, 0) / queue.length;
    const oldestMessage = Math.min(...queue.map(msg => msg.timestamp));

    return {
      messageCount: queue.length,
      totalBytes,
      oldestMessage,
      avgPriority,
      hasTimer: this.batchTimers.has(destination)
    };
  }

  /**
   * Get comprehensive statistics
   */
  getStats(): BatchStats {
    const pendingMessages = Array.from(this.messageQueues.values())
      .reduce((sum, queue) => sum + queue.length, 0);
    
    const queuedDestinations = this.getPendingDestinations().length;
    
    const avgBatchSize = this.stats.totalBatches > 0 
      ? this.stats.totalMessages / this.stats.totalBatches 
      : 0;
    
    const avgCompressionRatio = this.stats.totalBytes > 0
      ? this.stats.compressionSavings / this.stats.totalBytes
      : 0;

    return {
      totalBatches: this.stats.totalBatches,
      totalMessages: this.stats.totalMessages,
      avgBatchSize,
      avgCompressionRatio,
      pendingMessages,
      queuedDestinations
    };
  }

  /**
   * Update internal statistics
   */
  private updateStats(batch: MessageBatch): void {
    this.stats.totalBatches++;
    this.stats.totalMessages += batch.messages.length;
    this.stats.totalBytes += batch.totalSize;
    
    if (batch.compressed) {
      const originalSize = batch.messages.reduce((sum, msg) => 
        sum + (msg.metadata?.originalSize || msg.data.length), 0
      );
      this.stats.compressionSavings += (originalSize - batch.totalSize);
    }
  }

  /**
   * Clear all pending messages
   */
  clear(): void {
    // Clear all timers
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    this.batchTimers.clear();

    // Clear all queues
    this.messageQueues.clear();

    this.emit('cleared');
    this.log('All queues cleared');
  }

  /**
   * Update batching options
   */
  updateOptions(newOptions: Partial<BatchOptions>): void {
    Object.assign(this.options, newOptions);
    this.emit('options-updated', { options: this.options });
    this.log('Options updated');
  }

  /**
   * Generate unique message ID
   */
  private generateMessageId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate unique batch ID
   */
  private generateBatchId(): string {
    return `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Log message if logging is enabled
   */
  private log(message: string): void {
    if (this.options.enableLogging) {
      console.log(`[MessageBatcher] ${message}`);
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.clear();
    this.removeAllListeners();
    this.emit('destroyed');
    this.log('Message batcher destroyed');
  }
}
