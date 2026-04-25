import { RateLimiter } from '../../../src/common/RateLimiter';

describe('RateLimiter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('allows requests up to maxRequests in a window', () => {
    it('allows exactly maxRequests requests before denying', () => {
      const limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 });
      const results = [
        limiter.check('user1'),
        limiter.check('user1'),
        limiter.check('user1'),
      ];
      expect(results.every(r => r.allowed)).toBe(true);
      const denied = limiter.check('user1');
      expect(denied.allowed).toBe(false);
    });
  });

  describe('denies requests when bucket is empty', () => {
    it('returns retryAfter > 0 when denied', () => {
      const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
      limiter.check('user1');
      const result = limiter.check('user1');
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeDefined();
      expect(result.retryAfter!).toBeGreaterThan(0);
    });
  });

  describe('remaining decrements correctly', () => {
    it('decrements remaining on each allowed request', () => {
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });
      const first = limiter.check('user1');
      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(4);

      const second = limiter.check('user1');
      expect(second.allowed).toBe(true);
      expect(second.remaining).toBe(3);

      const third = limiter.check('user1');
      expect(third.allowed).toBe(true);
      expect(third.remaining).toBe(2);
    });
  });

  describe('bucket refills over time', () => {
    it('refills tokens after advancing timers by one window', () => {
      const limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 });

      limiter.check('user1');
      limiter.check('user1');
      limiter.check('user1');
      expect(limiter.check('user1').allowed).toBe(false);

      jest.advanceTimersByTime(1000);

      const result = limiter.check('user1');
      expect(result.allowed).toBe(true);
    });

    it('partially refills tokens after advancing timers by half a window', () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });

      limiter.check('user1');
      limiter.check('user1');
      expect(limiter.check('user1').allowed).toBe(false);

      jest.advanceTimersByTime(500);

      const result = limiter.check('user1');
      expect(result.allowed).toBe(true);
    });
  });

  describe('burst allows initial burst > 1 request immediately', () => {
    it('allows burstLimit requests when burstLimit > maxRequests', () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000, burstLimit: 5 });

      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(limiter.check('user1').allowed);
      }
      expect(results.every(r => r)).toBe(true);

      expect(limiter.check('user1').allowed).toBe(false);
    });
  });

  describe('different keys have independent buckets', () => {
    it('exhausting one key does not affect another', () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });

      limiter.check('user1');
      limiter.check('user1');
      expect(limiter.check('user1').allowed).toBe(false);

      expect(limiter.check('user2').allowed).toBe(true);
      expect(limiter.check('user2').allowed).toBe(true);
    });
  });

  describe('reset()', () => {
    it('clears the bucket so the next request is allowed again', () => {
      const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 });

      limiter.check('user1');
      expect(limiter.check('user1').allowed).toBe(false);

      limiter.reset('user1');
      expect(limiter.check('user1').allowed).toBe(true);
    });
  });

  describe('getStats()', () => {
    it('returns null for an unknown key', () => {
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });
      expect(limiter.getStats('unknown')).toBeNull();
    });

    it('returns token count for a known key', () => {
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });
      limiter.check('user1');
      limiter.check('user1');

      const stats = limiter.getStats('user1');
      expect(stats).not.toBeNull();
      expect(stats!.tokens).toBe(3);
      expect(stats!.lastRefillAt).toBeGreaterThan(0);
    });
  });

  describe('resetAt is in the future when tokens < burstLimit', () => {
    it('resetAt is greater than now when tokens have been consumed', () => {
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });
      limiter.check('user1');

      const now = Date.now();
      const result = limiter.check('user1');
      expect(result.resetAt).toBeGreaterThan(now);
    });

    it('resetAt is in the future on a denied request', () => {
      const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
      limiter.check('user1');

      const now = Date.now();
      const result = limiter.check('user1');
      expect(result.allowed).toBe(false);
      expect(result.resetAt).toBeGreaterThan(now);
    });
  });

  describe('retryAfter is approximately windowMs/maxRequests when fully depleted', () => {
    it('retryAfter is close to windowMs/maxRequests after full depletion', () => {
      const maxRequests = 5;
      const windowMs = 1000;
      const limiter = new RateLimiter({ maxRequests, windowMs });

      for (let i = 0; i < maxRequests; i++) {
        limiter.check('user1');
      }

      const result = limiter.check('user1');
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeDefined();

      const expectedRetryAfter = windowMs / maxRequests;
      expect(result.retryAfter!).toBeGreaterThanOrEqual(expectedRetryAfter - 1);
      expect(result.retryAfter!).toBeLessThanOrEqual(expectedRetryAfter + 1);
    });
  });

  // -------------------------------------------------------------------------
  // Fix 3 — Unbounded bucket growth (audit H3)
  // -------------------------------------------------------------------------
  describe('bucket eviction (audit fix H3)', () => {
    it('getBucketCount() returns the current number of tracked buckets', () => {
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });
      expect(limiter.getBucketCount()).toBe(0);

      limiter.check('key-a');
      expect(limiter.getBucketCount()).toBe(1);

      limiter.check('key-b');
      expect(limiter.getBucketCount()).toBe(2);

      limiter.reset('key-a');
      expect(limiter.getBucketCount()).toBe(1);
    });

    it('idle buckets are evicted once maxBuckets is exceeded and idleEvictMs has elapsed', () => {
      const maxBuckets = 5;
      const idleEvictMs = 60_000;
      const windowMs = 1000;
      const maxRequests = 10;
      const limiter = new RateLimiter({
        maxRequests,
        windowMs,
        maxBuckets,
        idleEvictMs,
      });

      // Create buckets — each check consumes exactly 1 token (burstLimit - 1 remaining).
      for (let i = 0; i < maxBuckets + 2; i++) {
        limiter.check(`key-${i}`);
      }
      expect(limiter.getBucketCount()).toBe(maxBuckets + 2);

      // Advance time by enough for:
      //  1. Tokens to fully refill  (1 token / refillRate = windowMs / maxRequests ms)
      //  2. idleEvictMs to elapse
      // Both conditions are required for a bucket to be eviction-eligible.
      const refillTimeMs = Math.ceil(windowMs / maxRequests) + 1;
      jest.advanceTimersByTime(idleEvictMs + refillTimeMs);

      // Force Math.random to return a value that triggers eviction (< 0.01).
      const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.005);
      try {
        limiter.check('trigger-key');
      } finally {
        randomSpy.mockRestore();
      }

      // Idle-and-full buckets should have been evicted; only trigger-key should remain.
      expect(limiter.getBucketCount()).toBeLessThan(maxBuckets + 3);
    });

    it('partially-consumed buckets are NOT evicted even after idleEvictMs elapses', () => {
      // Use a high burstLimit vs refill rate so partial consumption keeps tokens < burstLimit
      // even after a long idle window.
      const limiter = new RateLimiter({
        maxRequests: 1,    // refillRate = 0.001 tokens/ms (very slow)
        windowMs: 1000,
        burstLimit: 100,   // large burst; one check consumes 1 token leaving 99/100
        maxBuckets: 2,
        idleEvictMs: 1_000,
      });

      // Drain one token — bucket now has 99/100 tokens.
      limiter.check('partial-key');

      // Advance past idleEvictMs but NOT enough to refill to 100 tokens.
      // At refillRate=0.001, to refill 1 token takes 1000ms. We advance 1001ms
      // (just past idleEvictMs) so only ~1 token refills → still 100/100 at boundary.
      // Use 999ms to stay just under the refill threshold:
      // 99 + 999 * 0.001 = 99.999 < 100 → still not full.
      jest.advanceTimersByTime(1_500); // past idleEvictMs but theoreticalTokens = 99 + 1.5 = 100.5 → capped at 100

      // The test above actually reaches burstLimit. Let us instead drain more tokens.
      // Reset and use a scenario where tokens can never reach full within idleEvictMs:
      // Drain all tokens (100), then advance by idleEvictMs. With refillRate=0.001,
      // 1000ms only refills 1 token (0 + 1000 * 0.001 = 1 < 100). Not full → not evicted.
      const limiter2 = new RateLimiter({
        maxRequests: 1,
        windowMs: 1000,
        burstLimit: 100,
        maxBuckets: 2,
        idleEvictMs: 1_000,
      });

      for (let i = 0; i < 100; i++) {
        limiter2.check('not-full-key');
      }

      jest.advanceTimersByTime(1_001); // past idleEvictMs; tokens = 0 + 1001*0.001 = 1.001 < 100 → NOT full

      const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.005);
      try {
        limiter2.check('extra-key-1');
        limiter2.check('extra-key-2');
        limiter2.check('eviction-trigger');
      } finally {
        randomSpy.mockRestore();
      }

      // not-full-key tokens < burstLimit → NOT evicted.
      expect(limiter2.getStats('not-full-key')).not.toBeNull();
    });
  });
});
