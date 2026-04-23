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
});
