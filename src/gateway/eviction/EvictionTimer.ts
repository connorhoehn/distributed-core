export type EvictionCallback<K> = (key: K) => void | Promise<void>;

/**
 * Generic timer-based eviction manager. Schedule a callback for a key after
 * N ms of inactivity; cancel on renewal (e.g. a new subscriber arrives).
 *
 * Timers are unref()'d so they don't keep the process alive.
 */
export class EvictionTimer<K = string> {
  private readonly timers = new Map<K, NodeJS.Timeout>();
  private readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  schedule(key: K, callback: EvictionCallback<K>): void {
    this.cancel(key);
    const timer = setTimeout(async () => {
      this.timers.delete(key);
      await callback(key);
    }, this.delayMs);
    timer.unref();
    this.timers.set(key, timer);
  }

  cancel(key: K): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  isScheduled(key: K): boolean {
    return this.timers.has(key);
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}
