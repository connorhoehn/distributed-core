export type QueueMessageStatus = 'pending' | 'processing' | 'completed' | 'dead-letter';

export interface QueueMessage {
  id: string;
  queue: string;
  payload: any;
  enqueuedAt: number;
  attempts: number;
  maxAttempts: number;
  status: QueueMessageStatus;
  visibleAfter: number;
  metadata?: Record<string, any>;
}

export type QueueHandler = (message: QueueMessage) => Promise<void>;

export interface QueueConsumer {
  id: string;
  queue: string;
  handler: QueueHandler;
}

export interface DurableQueueConfig {
  walDir?: string;               // default './data/queues'
  enablePersistence?: boolean;   // default true
  defaultMaxAttempts?: number;   // default 3
  visibilityTimeout?: number;    // ms, default 30000
  pollInterval?: number;         // ms, default 100
}

export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  deadLetter: number;
  totalEnqueued: number;
  totalAcked: number;
  totalNacked: number;
  consumerCount: number;
}
