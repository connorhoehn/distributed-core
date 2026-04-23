import { MessageCache } from '../../../src/transport/MessageCache';

describe('MessageCache', () => {
  let cache: MessageCache;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new MessageCache({ ttlMs: 1000 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('has()', () => {
    it('returns false for unknown message IDs', () => {
      expect(cache.has('unknown-id')).toBe(false);
    });

    it('returns true after add()', () => {
      cache.add('msg-1');
      expect(cache.has('msg-1')).toBe(true);
    });

    it('returns false after TTL expires', () => {
      cache.add('msg-ttl');
      expect(cache.has('msg-ttl')).toBe(true);

      // Advance time past TTL
      jest.advanceTimersByTime(1001);

      expect(cache.has('msg-ttl')).toBe(false);
    });

    it('returns true just before TTL expires', () => {
      cache.add('msg-boundary');

      // One millisecond before expiry — still valid
      jest.advanceTimersByTime(999);

      expect(cache.has('msg-boundary')).toBe(true);
    });
  });

  describe('add()', () => {
    it('adding the same ID twice does not increase size', () => {
      cache.add('dup-id');
      cache.add('dup-id');
      expect(cache.size()).toBe(1);
    });

    it('refreshes expiry when the same ID is added again', () => {
      cache.add('refresh-id');

      // Advance to just before expiry then re-add
      jest.advanceTimersByTime(800);
      cache.add('refresh-id');

      // Advance another 800ms — original would have expired, but refresh keeps it alive
      jest.advanceTimersByTime(800);
      expect(cache.has('refresh-id')).toBe(true);
    });
  });

  describe('size()', () => {
    it('returns 0 for an empty cache', () => {
      expect(cache.size()).toBe(0);
    });

    it('returns correct count after multiple adds', () => {
      cache.add('a');
      cache.add('b');
      cache.add('c');
      expect(cache.size()).toBe(3);
    });

    it('excludes expired entries from count', () => {
      cache.add('live-1');
      cache.add('live-2');

      // Add one that expires sooner using a separate cache with short TTL
      const shortCache = new MessageCache({ ttlMs: 100 });
      shortCache.add('short-1');
      shortCache.add('short-2');
      shortCache.add('short-3');

      jest.advanceTimersByTime(200);

      // short-lived entries have expired
      expect(shortCache.size()).toBe(0);
      // original cache entries still alive
      expect(cache.size()).toBe(2);
    });
  });

  describe('clear()', () => {
    it('empties the cache', () => {
      cache.add('x');
      cache.add('y');
      cache.clear();
      expect(cache.size()).toBe(0);
    });

    it('has() returns false for all entries after clear()', () => {
      cache.add('a');
      cache.add('b');
      cache.clear();
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(false);
    });
  });

  describe('constructor options', () => {
    it('uses default TTL of 60000ms when no options provided', () => {
      const defaultCache = new MessageCache();
      defaultCache.add('msg');

      jest.advanceTimersByTime(59_999);
      expect(defaultCache.has('msg')).toBe(true);

      jest.advanceTimersByTime(1);
      expect(defaultCache.has('msg')).toBe(false);
    });

    it('accepts a custom TTL via constructor options', () => {
      const shortTtlCache = new MessageCache({ ttlMs: 500 });
      shortTtlCache.add('msg');

      jest.advanceTimersByTime(499);
      expect(shortTtlCache.has('msg')).toBe(true);

      jest.advanceTimersByTime(1);
      expect(shortTtlCache.has('msg')).toBe(false);
    });
  });

  describe('stress test', () => {
    it('handles 1000 entries and reports correct size', () => {
      for (let i = 0; i < 1000; i++) {
        cache.add(`msg-${i}`);
      }
      expect(cache.size()).toBe(1000);
    });
  });

  describe('lazy eviction', () => {
    it('removes expired entry from internal storage when has() is called', () => {
      // Add an entry, let it expire, then confirm has() removes it lazily
      cache.add('lazy-victim');

      jest.advanceTimersByTime(1001);

      // has() should lazily remove the expired entry and return false
      const result = cache.has('lazy-victim');
      expect(result).toBe(false);

      // After the lazy eviction, size() reflects the removal
      // (size() triggers a full sweep, but the lazy deletion already happened)
      expect(cache.size()).toBe(0);
    });

    it('does not affect other live entries during lazy eviction', () => {
      cache.add('will-expire');
      jest.advanceTimersByTime(500);
      cache.add('still-alive');

      // Advance past the first entry's TTL but not the second's
      jest.advanceTimersByTime(600);

      // Triggering has() on the expired entry does lazy removal
      expect(cache.has('will-expire')).toBe(false);
      expect(cache.has('still-alive')).toBe(true);
    });
  });
});
