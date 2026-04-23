export interface MessageCacheOptions {
  /** Time-to-live for cached message IDs in milliseconds. Default: 60000 (60s). */
  ttlMs?: number;
}

/**
 * Deduplication cache for in-flight messages.
 *
 * Stores recently seen message IDs with a timestamp so that duplicate
 * deliveries (e.g. from gossip fan-out or retries) are discarded before
 * they reach application logic. Eviction is lazy: expired entries are
 * removed on `has()` for single-entry checks, and a full sweep runs on
 * `size()` for accurate counts.
 *
 * Internally uses a Map<string, number> mapping message ID -> expiry
 * timestamp (absolute ms). This avoids an extra Set and keeps both the
 * existence check and the TTL comparison in a single data structure.
 */
export class MessageCache {
  private readonly cache: Map<string, number> = new Map();
  private readonly ttlMs: number;

  constructor(options: MessageCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  /**
   * Returns true if the message ID is present in the cache and has not
   * yet expired. Lazily removes the entry if it has expired.
   */
  has(messageId: string): boolean {
    const expiry = this.cache.get(messageId);
    if (expiry === undefined) {
      return false;
    }
    if (Date.now() >= expiry) {
      this.cache.delete(messageId);
      return false;
    }
    return true;
  }

  /**
   * Records a message ID in the cache with the configured TTL.
   * If the ID is already present its expiry is refreshed.
   */
  add(messageId: string): void {
    this.cache.set(messageId, Date.now() + this.ttlMs);
  }

  /**
   * Returns the number of non-expired entries currently tracked.
   * Triggers a full eviction pass so the count is accurate.
   */
  size(): number {
    this.evictExpired();
    return this.cache.size;
  }

  /**
   * Removes all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Scans the cache and removes all entries whose TTL has passed.
   */
  private evictExpired(): void {
    const now = Date.now();
    for (const [id, expiry] of this.cache) {
      if (now >= expiry) {
        this.cache.delete(id);
      }
    }
  }
}
