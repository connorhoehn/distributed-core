import { RateLimiter } from '../../common/RateLimiter';
import { MetricsRegistry } from '../../monitoring/metrics/MetricsRegistry';

export type DropStrategy = 'drop-oldest' | 'drop-newest' | 'reject';

export interface BackpressureConfig<T> {
  maxQueueSize: number;
  strategy: DropStrategy;
  flushIntervalMs?: number;
  rateLimiter?: RateLimiter;
  onDrop?: (key: string, item: T) => void;
  metrics?: MetricsRegistry;
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
  private readonly metrics: MetricsRegistry | null;
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
    this.metrics = config.metrics ?? null;
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
      this.metrics?.counter('bp.enqueued.count').inc();
      this.metrics?.gauge('bp.queue_depth.gauge', { key }).set(queue.length);
      return { accepted: true, dropped: 0 };
    }

    const { strategy } = this.config;

    if (strategy === 'drop-oldest') {
      const dropped = queue.shift()!;
      this.totalDropped++;
      this.metrics?.counter('bp.dropped.count', { strategy: 'drop-oldest' }).inc();
      this.config.onDrop?.(key, dropped);
      queue.push(item);
      this.totalEnqueued++;
      this.metrics?.counter('bp.enqueued.count').inc();
      this.metrics?.gauge('bp.queue_depth.gauge', { key }).set(queue.length);
      return { accepted: true, dropped: 1 };
    }

    if (strategy === 'drop-newest') {
      this.totalDropped++;
      this.metrics?.counter('bp.dropped.count', { strategy: 'drop-newest' }).inc();
      this.config.onDrop?.(key, item);
      return { accepted: false, dropped: 1 };
    }

    this.metrics?.counter('bp.dropped.count', { strategy: 'reject' }).inc();
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
      this.metrics?.counter('bp.flushed.count').inc(items.length);
      this.metrics?.gauge('bp.queue_depth.gauge', { key }).set(0);
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
    let iterations = 0;
    const maxIterations = 10;
    while (iterations < maxIterations) {
      try {
        await this.flushAll();
      } catch {
        // swallow — items will be re-queued by flush()
      }
      const hasPending = Array.from(this.queues.values()).some(q => q.length > 0);
      if (!hasPending) return;
      iterations++;
    }
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
