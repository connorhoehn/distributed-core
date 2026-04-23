export type FlushHandler<T> = (key: string, updates: T[]) => void | Promise<void>;
export type MergeFunction<T> = (updates: T[]) => T[];

export interface UpdateCoalescerOptions<T> {
  windowMs: number;
  onFlush: FlushHandler<T>;
  /**
   * Optional: combine buffered updates before handing them to onFlush.
   * If omitted, the raw array is passed through unchanged.
   * Useful when the caller can compress multiple deltas into one
   * (e.g. Yjs mergeUpdates, JSON patch squashing).
   */
  merge?: MergeFunction<T>;
}

/**
 * Buffers updates by key and flushes them as a batch after a fixed time
 * window. A new window only opens when the first update for a key arrives
 * after a previous flush — no sliding windows, no reset-on-arrival.
 *
 * Timers are unref()'d to avoid holding the event loop open.
 */
export class UpdateCoalescer<T> {
  private readonly buffers = new Map<string, T[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly windowMs: number;
  private readonly onFlush: FlushHandler<T>;
  private readonly merge?: MergeFunction<T>;

  constructor(options: UpdateCoalescerOptions<T>) {
    this.windowMs = options.windowMs;
    this.onFlush = options.onFlush;
    this.merge = options.merge;
  }

  buffer(key: string, update: T): void {
    let buf = this.buffers.get(key);
    if (buf === undefined) {
      buf = [];
      this.buffers.set(key, buf);
    }
    buf.push(update);

    if (!this.timers.has(key)) {
      const timer = setTimeout(() => this.flush(key), this.windowMs);
      timer.unref();
      this.timers.set(key, timer);
    }
  }

  flush(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }

    const updates = this.buffers.get(key);
    if (updates === undefined || updates.length === 0) return;

    this.buffers.delete(key);

    const payload = this.merge ? this.merge(updates) : updates;
    Promise.resolve(this.onFlush(key, payload)).catch(() => {});
  }

  flushAll(): void {
    for (const key of Array.from(this.buffers.keys())) {
      this.flush(key);
    }
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.buffers.delete(key);
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.buffers.clear();
  }

  get pendingCount(): number {
    return this.buffers.size;
  }

  pendingUpdatesFor(key: string): number {
    return this.buffers.get(key)?.length ?? 0;
  }
}
