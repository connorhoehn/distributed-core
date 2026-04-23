import { RateLimiter } from '../../common/RateLimiter';

export type DropStrategy = 'drop-oldest' | 'drop-newest' | 'reject';

export interface BackpressureConfig<T> {
  maxQueueSize: number;
  strategy: DropStrategy;
  flushIntervalMs?: number;
  rateLimiter?: RateLimiter;
  onDrop?: (key: string, item: T) => void;
}

export interface EnqueueResult {
  accepted: boolean;
  dropped: number;
}

export interface BackpressureStats {
  totalEnqueued: number;
  totalFlushed: number;
  totalDropped: number;
  queueDepths: Record<string, number>;
}

export class BackpressureController<T> {
  private readonly queues: Map<string, T[]> = new Map();
  private readonly onFlush: (key: string, items: T[]) => Promise<void>;
  private readonly config: BackpressureConfig<T>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private totalEnqueued = 0;
  private totalFlushed = 0;
  private totalDropped = 0;

  constructor(
    onFlush: (key: string, items: T[]) => Promise<void>,
    config: BackpressureConfig<T>
  ) {
    this.onFlush = onFlush;
    this.config = config;
  }

  enqueue(key: string, item: T): EnqueueResult {
    if (this.config.rateLimiter) {
      const result = this.config.rateLimiter.check(key);
      if (!result.allowed) {
        return { accepted: false, dropped: 0 };
      }
    }

    if (!this.queues.has(key)) {
      this.queues.set(key, []);
    }
    const queue = this.queues.get(key)!;

    if (queue.length < this.config.maxQueueSize) {
      queue.push(item);
      this.totalEnqueued++;
      return { accepted: true, dropped: 0 };
    }

    const { strategy } = this.config;

    if (strategy === 'drop-oldest') {
      const dropped = queue.shift()!;
      this.totalDropped++;
      this.config.onDrop?.(key, dropped);
      queue.push(item);
      this.totalEnqueued++;
      return { accepted: true, dropped: 1 };
    }

    if (strategy === 'drop-newest') {
      this.totalDropped++;
      this.config.onDrop?.(key, item);
      return { accepted: false, dropped: 1 };
    }

    return { accepted: false, dropped: 0 };
  }

  async flush(key: string): Promise<void> {
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return;

    const items = queue.splice(0);
    this.queues.set(key, []);

    try {
      await this.onFlush(key, items);
      this.totalFlushed += items.length;
    } catch (err) {
      const current = this.queues.get(key) ?? [];
      this.queues.set(key, [...items, ...current]);
      throw err;
    }
  }

  async flushAll(): Promise<void> {
    const keys = Array.from(this.queues.entries())
      .filter(([, q]) => q.length > 0)
      .map(([k]) => k);
    await Promise.all(keys.map((k) => this.flush(k)));
  }

  async drain(): Promise<void> {
    await this.flushAll();
  }

  getQueueDepth(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  getStats(): BackpressureStats {
    const queueDepths: Record<string, number> = {};
    for (const [key, queue] of this.queues) {
      queueDepths[key] = queue.length;
    }
    return {
      totalEnqueued: this.totalEnqueued,
      totalFlushed: this.totalFlushed,
      totalDropped: this.totalDropped,
      queueDepths,
    };
  }

  start(): void {
    if (this.config.flushIntervalMs == null) return;
    if (this.timer !== null) return;
    const t = setInterval(() => this.flushAll(), this.config.flushIntervalMs);
    t.unref();
    this.timer = t;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
