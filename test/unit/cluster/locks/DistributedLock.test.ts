import { EntityRegistryFactory } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { EntityRegistry } from '../../../../src/cluster/entity/types';
import { DistributedLock } from '../../../../src/cluster/locks/DistributedLock';

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

  it('acquire throws after acquireTimeoutMs if lock never becomes free', async () => {
    const blockingLock = new DistributedLock(registry, 'node-1', {
      defaultTtlMs: 10_000,
      acquireTimeoutMs: 500,
      retryIntervalMs: 100,
    });
    await lock2.tryAcquire('lock-1', { ttlMs: 10_000 });

    const acquirePromise = blockingLock.acquire('lock-1', { ttlMs: 10_000 });
    const rejectAssertion = expect(acquirePromise).rejects.toThrow(/Failed to acquire lock/);
    await jest.advanceTimersByTimeAsync(600);
    await rejectAssertion;
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
});
