import { EventEmitter } from 'events';
import { WALWriterImpl } from '../../persistence/wal/WALWriter';
import { WALReaderImpl } from '../../persistence/wal/WALReader';
import { WALConfig, WALEntry, EntityUpdate } from '../../persistence/wal/types';
import {
  QueueMessage,
  QueueHandler,
  QueueConsumer,
  DurableQueueConfig,
  QueueStats,
} from './types';

const DEFAULT_CONFIG: Required<DurableQueueConfig> = {
  walDir: './data/queues',
  enablePersistence: true,
  defaultMaxAttempts: 3,
  visibilityTimeout: 30000,
  pollInterval: 100,
};

export class DurableQueueManager extends EventEmitter {
  private readonly localNodeId: string;
  private readonly config: Required<DurableQueueConfig>;

  private queues: Map<string, QueueMessage[]> = new Map();
  private consumers: Map<string, QueueConsumer[]> = new Map();
  private processing: Map<string, QueueMessage> = new Map();
  private deadLetters: Map<string, QueueMessage[]> = new Map();
  private walWriter: WALWriterImpl | null = null;
  private walReader: WALReaderImpl | null = null;
  private pollTimers: Map<string, NodeJS.Timeout> = new Map();
  private visibilityTimers: Map<string, NodeJS.Timeout> = new Map();
  private stats: Map<string, QueueStats> = new Map();
  private consumerIdCounter = 0;
  private roundRobinIndex: Map<string, number> = new Map();
  private initialized = false;

  constructor(localNodeId: string, config?: DurableQueueConfig) {
    super();
    this.localNodeId = localNodeId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.config.enablePersistence) {
      const walConfig: WALConfig = {
        filePath: `${this.config.walDir}/durable-queue.wal`,
        maxFileSize: 100 * 1024 * 1024,
        syncInterval: 1000,
        checksumEnabled: true,
        compressionEnabled: false,
      };

      this.walWriter = new WALWriterImpl(walConfig);
      await this.walWriter.initialize();

      this.walReader = new WALReaderImpl(walConfig.filePath!);
      await this.walReader.initialize();

      await this.rebuildFromWAL();
      await this.walReader.close();
      this.walReader = null;
    }

    this.initialized = true;
  }

  async close(): Promise<void> {
    // Stop all poll timers
    for (const [queue, timer] of this.pollTimers) {
      clearInterval(timer);
    }
    this.pollTimers.clear();

    // Clear all visibility timers
    for (const [messageId, timer] of this.visibilityTimers) {
      clearTimeout(timer);
    }
    this.visibilityTimers.clear();

    // Flush and close WAL
    if (this.walWriter) {
      await this.walWriter.flush();
      await this.walWriter.close();
      this.walWriter = null;
    }

    if (this.walReader) {
      await this.walReader.close();
      this.walReader = null;
    }

    this.initialized = false;
  }

  async enqueue(
    queue: string,
    payload: any,
    metadata?: Record<string, any>,
  ): Promise<string> {
    const messageId = `qmsg-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
    const now = Date.now();

    const message: QueueMessage = {
      id: messageId,
      queue,
      payload,
      enqueuedAt: now,
      attempts: 0,
      maxAttempts: this.config.defaultMaxAttempts,
      status: 'pending',
      visibleAfter: 0,
      metadata,
    };

    // Persist to WAL
    if (this.walWriter) {
      const update: EntityUpdate = {
        entityId: messageId,
        ownerNodeId: this.localNodeId,
        version: 1,
        timestamp: now,
        operation: 'CREATE',
        metadata: {
          queue,
          payload,
          maxAttempts: message.maxAttempts,
          ...(metadata || {}),
        },
      };
      await this.walWriter.append(update);
    }

    // Add to in-memory queue (maintain order by enqueuedAt)
    const queueMessages = this.getOrCreateQueue(queue);
    queueMessages.push(message);

    // Update stats
    const queueStats = this.ensureQueueStats(queue);
    queueStats.pending++;
    queueStats.totalEnqueued++;

    this.emit('message-enqueued', message);

    // Trigger immediate dispatch attempt
    this.dispatchToConsumers(queue);

    return messageId;
  }

  consume(queue: string, handler: QueueHandler): string {
    this.consumerIdCounter++;
    const consumerId = `consumer-${this.consumerIdCounter}`;

    const consumer: QueueConsumer = {
      id: consumerId,
      queue,
      handler,
    };

    const queueConsumers = this.consumers.get(queue) || [];
    queueConsumers.push(consumer);
    this.consumers.set(queue, queueConsumers);

    // Update stats
    const queueStats = this.ensureQueueStats(queue);
    queueStats.consumerCount = queueConsumers.length;

    // Start poll timer if not already running
    if (!this.pollTimers.has(queue)) {
      this.startPollTimer(queue);
    }

    return consumerId;
  }

  removeConsumer(consumerId: string): boolean {
    for (const [queue, consumers] of this.consumers) {
      const index = consumers.findIndex((c) => c.id === consumerId);
      if (index !== -1) {
        consumers.splice(index, 1);

        // Update stats
        const queueStats = this.ensureQueueStats(queue);
        queueStats.consumerCount = consumers.length;

        // If no consumers left, stop poll timer
        if (consumers.length === 0) {
          this.stopPollTimer(queue);
          this.consumers.delete(queue);
        }

        return true;
      }
    }
    return false;
  }

  async ack(messageId: string): Promise<void> {
    const message = this.processing.get(messageId);
    if (!message) {
      return;
    }

    // Remove from processing
    this.processing.delete(messageId);
    this.clearVisibilityTimer(messageId);

    // Persist to WAL
    if (this.walWriter) {
      const update: EntityUpdate = {
        entityId: messageId,
        ownerNodeId: this.localNodeId,
        version: (message.attempts || 0) + 1,
        timestamp: Date.now(),
        operation: 'DELETE',
        metadata: { queue: message.queue },
      };
      await this.walWriter.append(update);
    }

    // Update stats
    const queueStats = this.ensureQueueStats(message.queue);
    queueStats.processing--;
    queueStats.completed++;
    queueStats.totalAcked++;

    message.status = 'completed';
    this.emit('message-acked', message);
  }

  async nack(messageId: string, delayMs?: number): Promise<void> {
    const message = this.processing.get(messageId);
    if (!message) {
      return;
    }

    // Remove from processing
    this.processing.delete(messageId);
    this.clearVisibilityTimer(messageId);

    message.attempts++;

    const queueStats = this.ensureQueueStats(message.queue);
    queueStats.processing--;
    queueStats.totalNacked++;

    if (message.attempts >= message.maxAttempts) {
      // Move to dead letter
      message.status = 'dead-letter';
      const deadLetterList = this.getOrCreateDeadLetter(message.queue);
      deadLetterList.push(message);

      queueStats.deadLetter++;

      // Persist to WAL
      if (this.walWriter) {
        const update: EntityUpdate = {
          entityId: messageId,
          ownerNodeId: this.localNodeId,
          version: message.attempts + 1,
          timestamp: Date.now(),
          operation: 'UPDATE',
          metadata: {
            queue: message.queue,
            status: 'dead-letter',
            attempts: message.attempts,
          },
        };
        await this.walWriter.append(update);
      }

      this.emit('message-dead-lettered', message);
    } else {
      // Requeue with visibility delay
      message.status = 'pending';
      message.visibleAfter = Date.now() + (delayMs ?? this.config.visibilityTimeout);

      const queueMessages = this.getOrCreateQueue(message.queue);
      queueMessages.push(message);
      queueStats.pending++;

      // Persist to WAL
      if (this.walWriter) {
        const update: EntityUpdate = {
          entityId: messageId,
          ownerNodeId: this.localNodeId,
          version: message.attempts + 1,
          timestamp: Date.now(),
          operation: 'UPDATE',
          metadata: {
            queue: message.queue,
            status: 'pending',
            attempts: message.attempts,
            visibleAfter: message.visibleAfter,
            payload: message.payload,
            maxAttempts: message.maxAttempts,
          },
        };
        await this.walWriter.append(update);
      }

      this.emit('message-nacked', message);
    }
  }

  getQueueStats(queue: string): QueueStats {
    return this.ensureQueueStats(queue);
  }

  getAllQueues(): string[] {
    const queueNames = new Set<string>();
    for (const name of this.queues.keys()) {
      queueNames.add(name);
    }
    for (const name of this.consumers.keys()) {
      queueNames.add(name);
    }
    for (const name of this.stats.keys()) {
      queueNames.add(name);
    }
    return Array.from(queueNames);
  }

  getDeadLetterMessages(queue: string): QueueMessage[] {
    return this.deadLetters.get(queue) || [];
  }

  async purgeQueue(queue: string): Promise<void> {
    const queueMessages = this.queues.get(queue);
    if (queueMessages) {
      const purgedCount = queueMessages.length;
      queueMessages.length = 0;

      const queueStats = this.ensureQueueStats(queue);
      queueStats.pending -= purgedCount;
      if (queueStats.pending < 0) {
        queueStats.pending = 0;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private dispatchToConsumers(queue: string): void {
    const queueConsumers = this.consumers.get(queue);
    if (!queueConsumers || queueConsumers.length === 0) {
      return;
    }

    const queueMessages = this.queues.get(queue);
    if (!queueMessages || queueMessages.length === 0) {
      return;
    }

    const now = Date.now();
    const queueStats = this.ensureQueueStats(queue);

    // Get the current round-robin index for this queue
    let rrIndex = this.roundRobinIndex.get(queue) || 0;

    // Process visible pending messages
    const toDispatch: QueueMessage[] = [];
    const remaining: QueueMessage[] = [];

    for (const msg of queueMessages) {
      if (msg.status === 'pending' && msg.visibleAfter <= now) {
        toDispatch.push(msg);
      } else {
        remaining.push(msg);
      }
    }

    // Replace queue contents with non-dispatched messages
    queueMessages.length = 0;
    queueMessages.push(...remaining);

    for (const message of toDispatch) {
      // Pick consumer via round-robin
      const consumer = queueConsumers[rrIndex % queueConsumers.length];
      rrIndex++;

      // Move message to processing
      message.status = 'processing';
      this.processing.set(message.id, message);
      queueStats.pending--;
      queueStats.processing++;

      // Set visibility timer
      this.setVisibilityTimer(message.id);

      this.emit('message-dispatched', message);

      // Call handler asynchronously, auto-nack on failure
      this.executeHandler(consumer.handler, message);
    }

    this.roundRobinIndex.set(queue, rrIndex);
  }

  private executeHandler(handler: QueueHandler, message: QueueMessage): void {
    Promise.resolve()
      .then(() => handler(message))
      .catch(() => {
        // Auto-nack on handler failure (only if still processing)
        if (this.processing.has(message.id)) {
          this.nack(message.id).catch(() => {
            // Nack itself failed; nothing more we can do
          });
        }
      });
  }

  private startPollTimer(queue: string): void {
    if (this.pollTimers.has(queue)) {
      return;
    }
    const timer = setInterval(() => {
      this.dispatchToConsumers(queue);
    }, this.config.pollInterval);
    timer.unref();
    this.pollTimers.set(queue, timer);
  }

  private stopPollTimer(queue: string): void {
    const timer = this.pollTimers.get(queue);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(queue);
    }
  }

  private setVisibilityTimer(messageId: string): void {
    this.clearVisibilityTimer(messageId);
    const timer = setTimeout(() => {
      // Auto-nack if still in processing when visibility timeout expires
      if (this.processing.has(messageId)) {
        this.nack(messageId).catch(() => {
          // Nack failed; nothing more we can do
        });
      }
    }, this.config.visibilityTimeout);
    timer.unref();
    this.visibilityTimers.set(messageId, timer);
  }

  private clearVisibilityTimer(messageId: string): void {
    const timer = this.visibilityTimers.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.visibilityTimers.delete(messageId);
    }
  }

  private async rebuildFromWAL(): Promise<void> {
    if (!this.walReader) {
      return;
    }

    // Track the latest state per message ID so we can replay idempotently
    const messageStates = new Map<
      string,
      { operation: string; entry: WALEntry }
    >();

    await this.walReader.replay(async (entry: WALEntry) => {
      messageStates.set(entry.data.entityId, {
        operation: entry.data.operation,
        entry,
      });
    });

    // Rebuild in-memory state from the final state of each message
    for (const [messageId, state] of messageStates) {
      const { operation, entry } = state;
      const meta = entry.data.metadata || {};
      const queue = meta.queue as string;

      if (!queue) {
        continue;
      }

      if (operation === 'DELETE') {
        // Message was acked/completed; nothing to restore
        const queueStats = this.ensureQueueStats(queue);
        queueStats.totalAcked++;
        queueStats.totalEnqueued++;
        queueStats.completed++;
        continue;
      }

      if (operation === 'UPDATE' && meta.status === 'dead-letter') {
        // Restore to dead letter
        const message: QueueMessage = {
          id: messageId,
          queue,
          payload: meta.payload,
          enqueuedAt: entry.timestamp,
          attempts: (meta.attempts as number) || 0,
          maxAttempts: (meta.maxAttempts as number) || this.config.defaultMaxAttempts,
          status: 'dead-letter',
          visibleAfter: 0,
          metadata: meta,
        };
        const deadLetterList = this.getOrCreateDeadLetter(queue);
        deadLetterList.push(message);

        const queueStats = this.ensureQueueStats(queue);
        queueStats.deadLetter++;
        queueStats.totalEnqueued++;
        continue;
      }

      if (operation === 'UPDATE' && meta.status === 'pending') {
        // Restore re-queued message
        const message: QueueMessage = {
          id: messageId,
          queue,
          payload: meta.payload,
          enqueuedAt: entry.timestamp,
          attempts: (meta.attempts as number) || 0,
          maxAttempts: (meta.maxAttempts as number) || this.config.defaultMaxAttempts,
          status: 'pending',
          visibleAfter: (meta.visibleAfter as number) || 0,
          metadata: meta,
        };
        const queueMessages = this.getOrCreateQueue(queue);
        queueMessages.push(message);

        const queueStats = this.ensureQueueStats(queue);
        queueStats.pending++;
        queueStats.totalEnqueued++;
        continue;
      }

      if (operation === 'CREATE') {
        // Restore pending message
        const message: QueueMessage = {
          id: messageId,
          queue,
          payload: meta.payload,
          enqueuedAt: entry.timestamp,
          attempts: 0,
          maxAttempts: (meta.maxAttempts as number) || this.config.defaultMaxAttempts,
          status: 'pending',
          visibleAfter: 0,
          metadata: meta,
        };
        const queueMessages = this.getOrCreateQueue(queue);
        queueMessages.push(message);

        const queueStats = this.ensureQueueStats(queue);
        queueStats.pending++;
        queueStats.totalEnqueued++;
      }
    }
  }

  private ensureQueueStats(queue: string): QueueStats {
    let existing = this.stats.get(queue);
    if (!existing) {
      existing = {
        pending: 0,
        processing: 0,
        completed: 0,
        deadLetter: 0,
        totalEnqueued: 0,
        totalAcked: 0,
        totalNacked: 0,
        consumerCount: 0,
      };
      this.stats.set(queue, existing);
    }
    return existing;
  }

  private getOrCreateQueue(queue: string): QueueMessage[] {
    let messages = this.queues.get(queue);
    if (!messages) {
      messages = [];
      this.queues.set(queue, messages);
    }
    return messages;
  }

  private getOrCreateDeadLetter(queue: string): QueueMessage[] {
    let messages = this.deadLetters.get(queue);
    if (!messages) {
      messages = [];
      this.deadLetters.set(queue, messages);
    }
    return messages;
  }
}
