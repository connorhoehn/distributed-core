import { EntityRegistryFactory } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { EntityRegistry } from '../../../../src/cluster/entity/types';
import { DistributedLock } from '../../../../src/cluster/locks/DistributedLock';
import { MetricsRegistry } from '../../../../src/monitoring/metrics/MetricsRegistry';
import { CoreError, TimeoutError, NotOwnedError } from '../../../../src/common/errors';

describe('DistributedLock', () => {
  let registry: EntityRegistry;
  let lock: DistributedLock;
  let lock2: DistributedLock;

  beforeEach(async () => {
    jest.useFakeTimers();
    registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
    lock = new DistributedLock(registry, 'node-1', {
      defaultTtlMs: 1_000,
      acquireTimeoutMs: 500,
      retryIntervalMs: 100,
    });
    lock2 = new DistributedLock(registry, 'node-2', {
      defaultTtlMs: 1_000,
      acquireTimeoutMs: 1_000,
      retryIntervalMs: 100,
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await registry.stop();
  });

  it('tryAcquire returns a LockHandle on success', async () => {
    const handle = await lock.tryAcquire('lock-1');
    expect(handle).not.toBeNull();
    expect(handle!.lockId).toBe('lock-1');
    expect(handle!.nodeId).toBe('node-1');
    expect(handle!.acquiredAt).toBeGreaterThan(0);
    expect(handle!.expiresAt).toBe(handle!.acquiredAt + 1_000);
  });

  it('tryAcquire returns null when lock is already held by another node', async () => {
    await lock2.tryAcquire('lock-1');
    const result = await lock.tryAcquire('lock-1');
    expect(result).toBeNull();
  });

  it('isHeldLocally is true after acquire and false after release', async () => {
    const handle = await lock.tryAcquire('lock-1');
    expect(lock.isHeldLocally('lock-1')).toBe(true);
    await lock.release(handle!);
    expect(lock.isHeldLocally('lock-1')).toBe(false);
  });

  it('isHeldByAny is true when any node holds the lock', async () => {
    expect(lock.isHeldByAny('lock-1')).toBe(false);
    const handle = await lock.tryAcquire('lock-1');
    expect(lock.isHeldByAny('lock-1')).toBe(true);
    await lock.release(handle!);
    expect(lock.isHeldByAny('lock-1')).toBe(false);
  });

  it('isHeldByAny is true when the other node holds the lock', async () => {
    await lock2.tryAcquire('lock-1');
    expect(lock.isHeldByAny('lock-1')).toBe(true);
    expect(lock2.isHeldByAny('lock-1')).toBe(true);
  });

  it('release allows another node to acquire the lock', async () => {
    const handle1 = await lock.tryAcquire('lock-1');
    expect(handle1).not.toBeNull();

    const nullHandle = await lock2.tryAcquire('lock-1');
    expect(nullHandle).toBeNull();

    await lock.release(handle1!);

    const handle2 = await lock2.tryAcquire('lock-1');
    expect(handle2).not.toBeNull();
    expect(handle2!.nodeId).toBe('node-2');
  });

  it('TTL expiry auto-releases the lock', async () => {
    const handle = await lock.tryAcquire('lock-1', { ttlMs: 500 });
    expect(handle).not.toBeNull();
    expect(lock.isHeldLocally('lock-1')).toBe(true);

    jest.advanceTimersByTime(600);
    await Promise.resolve();

    expect(lock.isHeldLocally('lock-1')).toBe(false);
    expect(lock.isHeldByAny('lock-1')).toBe(false);
  });

  it('acquire polls until lock becomes available', async () => {
    const handle2 = await lock2.tryAcquire('lock-1');
    expect(handle2).not.toBeNull();

    const acquirePromise = lock.acquire('lock-1', { ttlMs: 1_000 });

    await jest.advanceTimersByTimeAsync(200);
    await lock2.release(handle2!);
    await jest.advanceTimersByTimeAsync(200);

    const handle1 = await acquirePromise;
    expect(handle1).not.toBeNull();
    expect(handle1.nodeId).toBe('node-1');
  });

  it('acquire throws TimeoutError after acquireTimeoutMs if lock never becomes free', async () => {
    const blockingLock = new DistributedLock(registry, 'node-1', {
      defaultTtlMs: 10_000,
      acquireTimeoutMs: 500,
      retryIntervalMs: 100,
    });
    await lock2.tryAcquire('lock-1', { ttlMs: 10_000 });

    const acquirePromise = blockingLock.acquire('lock-1', { ttlMs: 10_000 });
    const rejectPromise = acquirePromise.catch(e => e);
    await jest.advanceTimersByTimeAsync(600);
    const err = await rejectPromise;
    expect(err).toBeInstanceOf(CoreError);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.code).toBe('timeout');
    expect(err.message).toContain('lock-1');
    expect(err.message).toContain('500');
  });

  it('extend throws NotOwnedError when the lock is not held', async () => {
    // Create a fake handle pointing to a lock we never acquired.
    const fakeHandle = { lockId: 'nonexistent', nodeId: 'node-1', acquiredAt: 0, expiresAt: 9999, fencingToken: 0n };
    const err = await lock.extend(fakeHandle).catch(e => e);
    expect(err).toBeInstanceOf(CoreError);
    expect(err).toBeInstanceOf(NotOwnedError);
    expect(err.code).toBe('not-owned');
    expect(err.lockId).toBe('nonexistent');
    expect(err.message).toContain('nonexistent');
  });

  it('extend resets the TTL so the lock is still held past the original expiry', async () => {
    const handle = await lock.tryAcquire('lock-1', { ttlMs: 500 });
    expect(handle).not.toBeNull();

    jest.advanceTimersByTime(400);
    await Promise.resolve();
    expect(lock.isHeldLocally('lock-1')).toBe(true);

    const extended = await lock.extend(handle!, 500);
    expect(extended.expiresAt).toBeGreaterThan(handle!.expiresAt);

    jest.advanceTimersByTime(300);
    await Promise.resolve();
    expect(lock.isHeldLocally('lock-1')).toBe(true);

    jest.advanceTimersByTime(300);
    await Promise.resolve();
    expect(lock.isHeldLocally('lock-1')).toBe(false);
  });

  describe('metrics', () => {
    let metricsRegistry: MetricsRegistry;
    let metricsLock: DistributedLock;

    beforeEach(() => {
      metricsRegistry = new MetricsRegistry('node-1');
      metricsLock = new DistributedLock(registry, 'node-1', {
        defaultTtlMs: 1_000,
        acquireTimeoutMs: 500,
        retryIntervalMs: 100,
        metrics: metricsRegistry,
      });
    });

    it('increments lock.acquire.count{result=success} on successful tryAcquire', async () => {
      await metricsLock.tryAcquire('lock-m1');
      expect(metricsRegistry.counter('lock.acquire.count', { result: 'success' }).get()).toBe(1);
    });

    it('increments lock.acquire.count{result=fail} when lock is already held', async () => {
      await lock2.tryAcquire('lock-m2');
      await metricsLock.tryAcquire('lock-m2');
      expect(metricsRegistry.counter('lock.acquire.count', { result: 'fail' }).get()).toBe(1);
    });

    it('records lock.acquire.latency_ms histogram on successful acquire', async () => {
      await metricsLock.tryAcquire('lock-m3');
      expect(metricsRegistry.histogram('lock.acquire.latency_ms').getCount()).toBe(1);
    });

    it('lock.hold.gauge reflects held lock count (increment + decrement cycle)', async () => {
      expect(metricsRegistry.gauge('lock.hold.gauge').get()).toBe(0);
      const h1 = await metricsLock.tryAcquire('lock-m4');
      expect(metricsRegistry.gauge('lock.hold.gauge').get()).toBe(1);
      const h2 = await metricsLock.tryAcquire('lock-m5');
      expect(metricsRegistry.gauge('lock.hold.gauge').get()).toBe(2);
      await metricsLock.release(h1!);
      expect(metricsRegistry.gauge('lock.hold.gauge').get()).toBe(1);
      await metricsLock.release(h2!);
      expect(metricsRegistry.gauge('lock.hold.gauge').get()).toBe(0);
    });

    it('increments lock.extend.count on extend', async () => {
      const h = await metricsLock.tryAcquire('lock-m6');
      await metricsLock.extend(h!, 500);
      expect(metricsRegistry.counter('lock.extend.count').get()).toBe(1);
    });

    it('increments lock.expired.count on TTL expiry', async () => {
      await metricsLock.tryAcquire('lock-m7', { ttlMs: 500 });
      jest.advanceTimersByTime(600);
      await Promise.resolve();
      expect(metricsRegistry.counter('lock.expired.count').get()).toBe(1);
    });

    it('increments lock.acquire.count{result=timeout} when acquire times out', async () => {
      const blockLock = new DistributedLock(registry, 'node-2', {
        defaultTtlMs: 10_000,
        acquireTimeoutMs: 500,
        retryIntervalMs: 100,
        metrics: metricsRegistry,
      });
      await blockLock.tryAcquire('lock-timeout', { ttlMs: 10_000 });

      const acquirePromise = metricsLock.acquire('lock-timeout');
      const rejectAssertion = expect(acquirePromise).rejects.toBeInstanceOf(TimeoutError);
      await jest.advanceTimersByTimeAsync(600);
      await rejectAssertion;

      expect(metricsRegistry.counter('lock.acquire.count', { result: 'timeout' }).get()).toBe(1);
    });

    it('no metrics errors when metrics is omitted', async () => {
      const h = await lock.tryAcquire('lock-no-metrics');
      expect(h).not.toBeNull();
    });
  });

  it('getHeldLocks returns all locks held by this node', async () => {
    expect(lock.getHeldLocks()).toHaveLength(0);

    const h1 = await lock.tryAcquire('lock-a');
    const h2 = await lock.tryAcquire('lock-b');
    expect(lock.getHeldLocks()).toHaveLength(2);

    await lock.release(h1!);
    const held = lock.getHeldLocks();
    expect(held).toHaveLength(1);
    expect(held[0].lockId).toBe('lock-b');

    await lock.release(h2!);
    expect(lock.getHeldLocks()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // handleRemoteNodeFailure
  // -------------------------------------------------------------------------

  describe('handleRemoteNodeFailure', () => {
    it('removes registry entries owned by the failed node', async () => {
      // Inject a lock entry owned by a remote node
      await registry.applyRemoteUpdate({
        entityId: 'remote-lock-1', ownerNodeId: 'node-dead', version: 1,
        timestamp: Date.now(), operation: 'CREATE', metadata: {},
      });

      expect(lock.isHeldByAny('remote-lock-1')).toBe(true);

      lock.handleRemoteNodeFailure('node-dead');

      // Flush microtask queue so the void applyRemoteUpdate promise settles
      await Promise.resolve();
      await Promise.resolve();

      expect(lock.isHeldByAny('remote-lock-1')).toBe(false);
    });

    it('returns the correct count of cleaned-up locks', async () => {
      await registry.applyRemoteUpdate({
        entityId: 'dead-lock-a', ownerNodeId: 'node-dead', version: 1,
        timestamp: Date.now(), operation: 'CREATE', metadata: {},
      });
      await registry.applyRemoteUpdate({
        entityId: 'dead-lock-b', ownerNodeId: 'node-dead', version: 2,
        timestamp: Date.now(), operation: 'CREATE', metadata: {},
      });

      const count = lock.handleRemoteNodeFailure('node-dead');

      expect(count).toBe(2);
    });

    it('does not affect locks owned by other (alive) nodes', async () => {
      await registry.applyRemoteUpdate({
        entityId: 'alive-lock', ownerNodeId: 'node-alive', version: 1,
        timestamp: Date.now(), operation: 'CREATE', metadata: {},
      });
      await registry.applyRemoteUpdate({
        entityId: 'dead-lock', ownerNodeId: 'node-dead', version: 1,
        timestamp: Date.now(), operation: 'CREATE', metadata: {},
      });

      const count = lock.handleRemoteNodeFailure('node-dead');
      expect(count).toBe(1);

      // Flush microtask queue
      await Promise.resolve();
      await Promise.resolve();

      expect(lock.isHeldByAny('alive-lock')).toBe(true);
      expect(lock.isHeldByAny('dead-lock')).toBe(false);
    });

    it('returns 0 when the node held no locks', async () => {
      const count = lock.handleRemoteNodeFailure('node-with-no-locks');
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Fix 5 — _onExpired silent error swallow (audit H3)
  // -------------------------------------------------------------------------
  describe('TTL expiry release error handling (audit fix H3)', () => {
    it('emits lock:release-failed when releaseEntity rejects on TTL expiry', async () => {
      const metricsRegistry = new MetricsRegistry('node-1');
      const failingLock = new DistributedLock(registry, 'node-1', {
        defaultTtlMs: 1_000,
        acquireTimeoutMs: 500,
        retryIntervalMs: 100,
        metrics: metricsRegistry,
      });

      // Acquire a lock so it is in heldLocks.
      const handle = await failingLock.tryAcquire('expiry-fail-lock', { ttlMs: 500 });
      expect(handle).not.toBeNull();

      // Make the registry reject the next releaseEntity call.
      jest.spyOn(registry, 'releaseEntity').mockRejectedValueOnce(new Error('network error'));

      const emitted: unknown[] = [];
      failingLock.on('lock:release-failed', (payload) => { emitted.push(payload); });

      // Advance timers to trigger TTL expiry.
      jest.advanceTimersByTime(600);
      // Flush microtask queue so the promise rejection handler runs.
      await Promise.resolve();
      await Promise.resolve();

      expect(emitted).toHaveLength(1);
      const payload = emitted[0] as { lockId: string; reason: string; error: Error };
      expect(payload.lockId).toBe('expiry-fail-lock');
      expect(payload.reason).toBe('ttl-expiry-cleanup');
      expect(payload.error).toBeInstanceOf(Error);
    });

    it('increments lock.release_failed.count metric on TTL expiry release failure', async () => {
      const metricsRegistry = new MetricsRegistry('node-1');
      const failingLock = new DistributedLock(registry, 'node-1', {
        defaultTtlMs: 1_000,
        acquireTimeoutMs: 500,
        retryIntervalMs: 100,
        metrics: metricsRegistry,
      });

      await failingLock.tryAcquire('metric-fail-lock', { ttlMs: 500 });

      jest.spyOn(registry, 'releaseEntity').mockRejectedValueOnce(new Error('disk error'));

      jest.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();

      expect(metricsRegistry.counter('lock.release_failed.count').get()).toBe(1);
    });
  });
});
