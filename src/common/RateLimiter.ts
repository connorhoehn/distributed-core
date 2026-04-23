export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
  burstLimit?: number;
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
  private readonly buckets: Map<string, Bucket> = new Map();

  constructor(config: RateLimiterConfig) {
    this.maxRequests = config.maxRequests;
    this.windowMs = config.windowMs;
    this.burstLimit = config.burstLimit ?? config.maxRequests;
    this.refillRate = config.maxRequests / config.windowMs;
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

  getStats(key: string): { tokens: number; lastRefillAt: number } | null {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;

    this.refill(bucket, Date.now());
    return { tokens: Math.floor(bucket.tokens), lastRefillAt: bucket.lastRefillAt };
  }
}
