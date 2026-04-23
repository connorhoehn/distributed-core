import { GossipBackoff } from '../../../src/gossip/transport/GossipBackoff';

describe('GossipBackoff', () => {
  let backoff: GossipBackoff;

  beforeEach(() => {
    backoff = new GossipBackoff({ jitter: false });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getDelay()', () => {
    it('returns 0 for an unknown peer with no failures recorded', () => {
      expect(backoff.getDelay('peer-unknown')).toBe(0);
    });

    it('returns baseDelayMs for 1 failure (multiplier^0 = 1)', () => {
      backoff.recordFailure('peer-a');
      // formula: base * multiplier^(failures-1) = 100 * 2^0 = 100
      expect(backoff.getDelay('peer-a')).toBe(100);
    });

    it('grows exponentially: 2 failures → base * multiplier^1', () => {
      backoff.recordFailure('peer-b');
      backoff.recordFailure('peer-b');
      // 100 * 2^1 = 200
      expect(backoff.getDelay('peer-b')).toBe(200);
    });

    it('grows exponentially: 3 failures → base * multiplier^2', () => {
      backoff.recordFailure('peer-c');
      backoff.recordFailure('peer-c');
      backoff.recordFailure('peer-c');
      // 100 * 2^2 = 400
      expect(backoff.getDelay('peer-c')).toBe(400);
    });

    it('caps at maxDelayMs', () => {
      const cappedBackoff = new GossipBackoff({
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        multiplier: 10,
        jitter: false
      });

      // 1 failure → 1000 * 10^0 = 1000
      // 2 failures → 1000 * 10^1 = 10000, but capped at 5000
      cappedBackoff.recordFailure('peer-cap');
      cappedBackoff.recordFailure('peer-cap');
      expect(cappedBackoff.getDelay('peer-cap')).toBe(5000);
    });

    it('returns 0 after recordSuccess() resets the peer', () => {
      backoff.recordFailure('peer-d');
      backoff.recordSuccess('peer-d');
      expect(backoff.getDelay('peer-d')).toBe(0);
    });
  });

  describe('recordFailure() / recordSuccess()', () => {
    it('increments failure count on each call', () => {
      backoff.recordFailure('peer-e');
      backoff.recordFailure('peer-e');
      expect(backoff.getFailureCount('peer-e')).toBe(2);
    });

    it('recordSuccess() removes the peer entry entirely', () => {
      backoff.recordFailure('peer-f');
      backoff.recordSuccess('peer-f');
      expect(backoff.getFailureCount('peer-f')).toBe(0);
      expect(backoff.getDelay('peer-f')).toBe(0);
    });
  });

  describe('reset()', () => {
    it('clears only the specified peer', () => {
      backoff.recordFailure('peer-g');
      backoff.recordFailure('peer-h');

      backoff.reset('peer-g');

      expect(backoff.getDelay('peer-g')).toBe(0);
      expect(backoff.getDelay('peer-h')).toBe(100); // still has 1 failure
    });
  });

  describe('resetAll()', () => {
    it('clears all tracked peers', () => {
      backoff.recordFailure('peer-i');
      backoff.recordFailure('peer-j');
      backoff.recordFailure('peer-k');

      backoff.resetAll();

      expect(backoff.getDelay('peer-i')).toBe(0);
      expect(backoff.getDelay('peer-j')).toBe(0);
      expect(backoff.getDelay('peer-k')).toBe(0);
    });
  });

  describe('getFailureCount()', () => {
    it('returns 0 for a peer with no failures', () => {
      expect(backoff.getFailureCount('new-peer')).toBe(0);
    });

    it('accurately tracks incremental failure counts', () => {
      backoff.recordFailure('peer-l');
      expect(backoff.getFailureCount('peer-l')).toBe(1);

      backoff.recordFailure('peer-l');
      expect(backoff.getFailureCount('peer-l')).toBe(2);

      backoff.recordFailure('peer-l');
      expect(backoff.getFailureCount('peer-l')).toBe(3);
    });

    it('resets to 0 after recordSuccess()', () => {
      backoff.recordFailure('peer-m');
      backoff.recordFailure('peer-m');
      backoff.recordSuccess('peer-m');
      expect(backoff.getFailureCount('peer-m')).toBe(0);
    });
  });

  describe('jitter', () => {
    it('returns a value within [delay/2, delay] when jitter=true', () => {
      const jitterBackoff = new GossipBackoff({
        baseDelayMs: 200,
        multiplier: 2,
        maxDelayMs: 30000,
        jitter: true
      });

      jitterBackoff.recordFailure('peer-jitter');
      // With 1 failure and no jitter: delay = 200 * 2^0 = 200
      // With jitter: result ∈ [100, 200)

      const samples = 50;
      for (let i = 0; i < samples; i++) {
        const delay = jitterBackoff.getDelay('peer-jitter');
        expect(delay).toBeGreaterThanOrEqual(100);
        expect(delay).toBeLessThanOrEqual(200);
      }
    });

    it('jitter range scales with computed delay', () => {
      const jitterBackoff = new GossipBackoff({
        baseDelayMs: 100,
        multiplier: 2,
        maxDelayMs: 30000,
        jitter: true
      });

      // 3 failures → base delay = 100 * 2^2 = 400; jitter range [200, 400)
      jitterBackoff.recordFailure('peer-scale');
      jitterBackoff.recordFailure('peer-scale');
      jitterBackoff.recordFailure('peer-scale');

      for (let i = 0; i < 50; i++) {
        const delay = jitterBackoff.getDelay('peer-scale');
        expect(delay).toBeGreaterThanOrEqual(200);
        expect(delay).toBeLessThanOrEqual(400);
      }
    });
  });

  describe('custom config', () => {
    it('respects custom baseDelayMs', () => {
      const custom = new GossipBackoff({ baseDelayMs: 500, jitter: false });
      custom.recordFailure('p');
      expect(custom.getDelay('p')).toBe(500);
    });

    it('respects custom multiplier', () => {
      const custom = new GossipBackoff({ baseDelayMs: 100, multiplier: 3, jitter: false });
      custom.recordFailure('p');
      custom.recordFailure('p');
      // 100 * 3^1 = 300
      expect(custom.getDelay('p')).toBe(300);
    });

    it('respects custom maxDelayMs', () => {
      const custom = new GossipBackoff({
        baseDelayMs: 100,
        multiplier: 2,
        maxDelayMs: 150,
        jitter: false
      });
      custom.recordFailure('p');
      custom.recordFailure('p');
      // 100 * 2^1 = 200, capped at 150
      expect(custom.getDelay('p')).toBe(150);
    });
  });

  describe('multiple independent peers', () => {
    it('tracks failure counts independently for each peer', () => {
      backoff.recordFailure('peer-x');

      backoff.recordFailure('peer-y');
      backoff.recordFailure('peer-y');

      backoff.recordFailure('peer-z');
      backoff.recordFailure('peer-z');
      backoff.recordFailure('peer-z');

      expect(backoff.getFailureCount('peer-x')).toBe(1);
      expect(backoff.getFailureCount('peer-y')).toBe(2);
      expect(backoff.getFailureCount('peer-z')).toBe(3);
    });

    it('computes delays independently for each peer', () => {
      backoff.recordFailure('peer-x');          // 1 failure → 100
      backoff.recordFailure('peer-y');
      backoff.recordFailure('peer-y');          // 2 failures → 200
      backoff.recordFailure('peer-z');
      backoff.recordFailure('peer-z');
      backoff.recordFailure('peer-z');          // 3 failures → 400

      expect(backoff.getDelay('peer-x')).toBe(100);
      expect(backoff.getDelay('peer-y')).toBe(200);
      expect(backoff.getDelay('peer-z')).toBe(400);
    });

    it('resetting one peer does not affect others', () => {
      backoff.recordFailure('peer-x');
      backoff.recordFailure('peer-y');

      backoff.reset('peer-x');

      expect(backoff.getDelay('peer-x')).toBe(0);
      expect(backoff.getDelay('peer-y')).toBe(100);
    });
  });
});
