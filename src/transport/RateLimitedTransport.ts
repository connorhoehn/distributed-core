import { Transport } from './Transport';
import { NodeId, Message } from '../types';

/**
 * Configuration for the rate-limited transport wrapper.
 */
export interface RateLimitConfig {
  /** Maximum number of messages allowed per second. */
  maxMessagesPerSecond: number;
  /** Optional bandwidth limit in bytes per second. */
  maxBytesPerSecond?: number;
  /** Optional limit on concurrent in-flight send() calls. */
  maxConcurrentConnections?: number;
  /**
   * Behaviour when a rate limit is exceeded.
   * - `'throw'` (default): reject the send() promise with a RateLimitError.
   * - `'drop'`:  silently discard the message.
   * - `'queue'`: buffer the message and drain it when tokens become available.
   */
  onLimitExceeded?: 'drop' | 'queue' | 'throw';
}

/**
 * Snapshot of rate-limiter counters returned by {@link RateLimitedTransport.getStats}.
 */
export interface RateLimitStats {
  /** Total messages successfully forwarded to the inner transport. */
  sent: number;
  /** Messages silently dropped (only when onLimitExceeded = 'drop'). */
  dropped: number;
  /** Messages currently sitting in the overflow queue. */
  queued: number;
  /** Total number of times a send() was rejected / deferred by the limiter. */
  rateLimitHits: number;
}

/**
 * Error thrown when a send() call is rejected by the rate limiter
 * (onLimitExceeded = 'throw').
 */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

interface QueuedItem {
  message: Message;
  target: NodeId;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Transport middleware that enforces send-side rate limits using a token-bucket
 * algorithm.  All other Transport methods are delegated to the wrapped inner
 * transport unchanged.
 *
 * Usage:
 * ```ts
 * const limited = RateLimitedTransport.wrapTransport(innerTransport, {
 *   maxMessagesPerSecond: 100,
 *   onLimitExceeded: 'queue',
 * });
 * await limited.send(msg, target);
 * ```
 */
export class RateLimitedTransport extends Transport {
  private readonly inner: Transport;
  private readonly config: Required<Pick<RateLimitConfig, 'maxMessagesPerSecond' | 'onLimitExceeded'>> & RateLimitConfig;

  // Token bucket state — message rate
  private messageTokens: number;
  private readonly maxMessageTokens: number;

  // Token bucket state — byte rate (optional)
  private byteTokens: number;
  private readonly maxByteTokens: number;

  // Concurrency tracking
  private inFlight: number = 0;
  private readonly maxConcurrent: number;

  // Overflow queue (used when onLimitExceeded = 'queue')
  private readonly queue: QueuedItem[] = [];

  // Refill timer handle
  private refillTimer: ReturnType<typeof setInterval> | null = null;

  // Stats
  private stats: RateLimitStats = { sent: 0, dropped: 0, queued: 0, rateLimitHits: 0 };

  // Listener map for onMessage / removeMessageListener delegation
  private readonly messageListenerMap = new Map<
    (message: Message) => void,
    (message: Message) => void
  >();

  constructor(inner: Transport, config: RateLimitConfig) {
    super();
    this.inner = inner;
    this.config = {
      ...config,
      onLimitExceeded: config.onLimitExceeded ?? 'throw',
    };

    this.maxMessageTokens = config.maxMessagesPerSecond;
    this.messageTokens = this.maxMessageTokens;

    this.maxByteTokens = config.maxBytesPerSecond ?? Infinity;
    this.byteTokens = this.maxByteTokens;

    this.maxConcurrent = config.maxConcurrentConnections ?? Infinity;
  }

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  /**
   * Convenience factory that wraps an existing transport with rate limiting.
   */
  static wrapTransport(transport: Transport, config: RateLimitConfig): RateLimitedTransport {
    return new RateLimitedTransport(transport, config);
  }

  // ---------------------------------------------------------------------------
  // Transport lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // Start the token refill interval (1 second cadence)
    this.refillTimer = setInterval(() => this.refillTokens(), 1000);
    return this.inner.start();
  }

  async stop(): Promise<void> {
    if (this.refillTimer !== null) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }

    // Reject any queued messages
    for (const item of this.queue) {
      item.reject(new RateLimitError('Transport stopped while message was queued'));
    }
    this.queue.length = 0;
    this.stats.queued = 0;

    return this.inner.stop();
  }

  // ---------------------------------------------------------------------------
  // send() — the core rate-limited path
  // ---------------------------------------------------------------------------

  async send(message: Message, target: NodeId): Promise<void> {
    const messageBytes = this.estimateBytes(message);

    // Check concurrency limit
    if (this.inFlight >= this.maxConcurrent) {
      return this.handleLimitExceeded(message, target, 'Max concurrent connections exceeded');
    }

    // Check message token bucket
    if (this.messageTokens < 1) {
      return this.handleLimitExceeded(message, target, 'Message rate limit exceeded');
    }

    // Check byte token bucket
    if (this.maxByteTokens !== Infinity && this.byteTokens < messageBytes) {
      return this.handleLimitExceeded(message, target, 'Byte rate limit exceeded');
    }

    // Consume tokens and forward
    return this.doSend(message, target, messageBytes);
  }

  // ---------------------------------------------------------------------------
  // Delegation of remaining Transport methods
  // ---------------------------------------------------------------------------

  onMessage(callback: (message: Message) => void): void {
    // Pass through directly — rate limiting is send-side only
    const wrappedCallback = (message: Message) => callback(message);
    this.messageListenerMap.set(callback, wrappedCallback);
    this.inner.onMessage(wrappedCallback);
  }

  removeMessageListener(callback: (message: Message) => void): void {
    const mapped = this.messageListenerMap.get(callback);
    if (mapped) {
      this.inner.removeMessageListener(mapped);
      this.messageListenerMap.delete(callback);
    }
  }

  getConnectedNodes(): NodeId[] {
    return this.inner.getConnectedNodes();
  }

  getLocalNodeInfo(): NodeId {
    return this.inner.getLocalNodeInfo();
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  /**
   * Return a snapshot of rate-limiter counters.
   */
  getStats(): RateLimitStats {
    return { ...this.stats, queued: this.queue.length };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async doSend(message: Message, target: NodeId, messageBytes: number): Promise<void> {
    this.messageTokens -= 1;
    if (this.maxByteTokens !== Infinity) {
      this.byteTokens -= messageBytes;
    }

    this.inFlight++;
    try {
      await this.inner.send(message, target);
      this.stats.sent++;
    } finally {
      this.inFlight--;
    }
  }

  private handleLimitExceeded(message: Message, target: NodeId, reason: string): Promise<void> {
    this.stats.rateLimitHits++;

    switch (this.config.onLimitExceeded) {
      case 'drop':
        this.stats.dropped++;
        return Promise.resolve();

      case 'queue':
        return new Promise<void>((resolve, reject) => {
          this.queue.push({ message, target, resolve, reject });
          this.stats.queued = this.queue.length;
        });

      case 'throw':
      default:
        return Promise.reject(new RateLimitError(reason));
    }
  }

  /**
   * Refill tokens and drain the queue if possible.
   * Called once per second by the refill interval.
   */
  private refillTokens(): void {
    this.messageTokens = Math.min(
      this.messageTokens + this.maxMessageTokens,
      this.maxMessageTokens
    );

    if (this.maxByteTokens !== Infinity) {
      this.byteTokens = Math.min(
        this.byteTokens + this.maxByteTokens,
        this.maxByteTokens
      );
    }

    this.drainQueue();
  }

  /**
   * Attempt to send queued messages using available tokens.
   */
  private drainQueue(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      const bytes = this.estimateBytes(next.message);

      if (this.messageTokens < 1) break;
      if (this.inFlight >= this.maxConcurrent) break;
      if (this.maxByteTokens !== Infinity && this.byteTokens < bytes) break;

      // Dequeue
      this.queue.shift();
      this.stats.queued = this.queue.length;

      this.doSend(next.message, next.target, bytes)
        .then(() => next.resolve())
        .catch((err) => next.reject(err instanceof Error ? err : new Error(String(err))));
    }
  }

  /** Rough byte-size estimate for a message (used for bandwidth limiting). */
  private estimateBytes(message: Message): number {
    try {
      return Buffer.byteLength(JSON.stringify(message), 'utf8');
    } catch {
      return 256; // fallback
    }
  }

  /**
   * Manually trigger a token refill and queue drain.
   * Useful for testing without waiting for the 1-second interval.
   */
  _testRefill(): void {
    this.refillTokens();
  }
}
