export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
  burstLimit?: number;
  /** Maximum number of tracked buckets before idle eviction is triggered. Default: 10_000. */
  maxBuckets?: number;
  /** Time (ms) after which a full, untouched bucket is eligible for eviction. Default: 300_000 (5 min). */
  idleEvictMs?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

interface Bucket {
  tokens: number;
  lastRefillAt: number;
}

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly burstLimit: number;
  private readonly refillRate: number;
  private readonly maxBuckets: number;
  private readonly idleEvictMs: number;
  private readonly buckets: Map<string, Bucket> = new Map();

  constructor(config: RateLimiterConfig) {
    this.maxRequests = config.maxRequests;
    this.windowMs = config.windowMs;
    this.burstLimit = config.burstLimit ?? config.maxRequests;
    this.refillRate = config.maxRequests / config.windowMs;
    this.maxBuckets = config.maxBuckets ?? 10_000;
    this.idleEvictMs = config.idleEvictMs ?? 300_000;
  }

  private refill(bucket: Bucket, now: number): void {
    const elapsed = now - bucket.lastRefillAt;
    bucket.tokens = Math.min(this.burstLimit, bucket.tokens + elapsed * this.refillRate);
    bucket.lastRefillAt = now;
  }

  check(key: string): RateLimitResult {
    const now = Date.now();

    if (!this.buckets.has(key)) {
      this.buckets.set(key, { tokens: this.burstLimit, lastRefillAt: now });
    }

    // Lazy probabilistic eviction: 1% chance per check when over limit.
    if (this.buckets.size > this.maxBuckets && Math.random() < 0.01) {
      this._evictIdle(now);
    }

    const bucket = this.buckets.get(key)!;
    this.refill(bucket, now);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      const resetAt = now + Math.ceil((this.burstLimit - bucket.tokens) / this.refillRate);
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        resetAt,
      };
    }

    const retryAfter = Math.ceil((1 - bucket.tokens) / this.refillRate);
    const resetAt = now + Math.ceil((this.burstLimit - bucket.tokens) / this.refillRate);
    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfter,
    };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Returns the current number of tracked buckets. Useful for observability. */
  getBucketCount(): number {
    return this.buckets.size;
  }

  /** Evict buckets that are full (tokens >= burstLimit) and have been idle for idleEvictMs.
   *
   * Uses the original lastRefillAt timestamp for the idle age check (not the
   * post-refill value) while computing the theoretical token count after refill
   * to correctly identify buckets that are now full and have been dormant.
   */
  private _evictIdle(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const lastTouched = bucket.lastRefillAt;
      // Compute theoretical token count without mutating lastRefillAt yet.
      const elapsed = now - lastTouched;
      const theoreticalTokens = Math.min(this.burstLimit, bucket.tokens + elapsed * this.refillRate);
      if (lastTouched + this.idleEvictMs < now && theoreticalTokens >= this.burstLimit) {
        this.buckets.delete(key);
      }
    }
  }

  getStats(key: string): { tokens: number; lastRefillAt: number } | null {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;

    this.refill(bucket, Date.now());
    return { tokens: Math.floor(bucket.tokens), lastRefillAt: bucket.lastRefillAt };
  }
}
