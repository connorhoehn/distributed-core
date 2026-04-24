import { ConnectionRegistry, ConnectionHandle } from '../../../src/connections/ConnectionRegistry';
import { EntityRegistryFactory } from '../../../src/cluster/entity/EntityRegistryFactory';
import { EntityRegistry } from '../../../src/cluster/entity/types';
import { EntityUpdate } from '../../../src/persistence/wal/types';
import { MetricsRegistry } from '../../../src/monitoring/metrics/MetricsRegistry';

jest.useFakeTimers();

const LOCAL_NODE = 'node-local';
const REMOTE_NODE = 'node-remote';
const TTL_MS = 5000;

function makeRegistry(ttlMs?: number): ConnectionRegistry {
  const entityRegistry = EntityRegistryFactory.createMemory(LOCAL_NODE, { enableTestMode: true });
  return new ConnectionRegistry(entityRegistry, LOCAL_NODE, ttlMs !== undefined ? { ttlMs } : undefined);
}

function makeReconnectRegistry(ttlMs?: number): ConnectionRegistry {
  const entityRegistry = EntityRegistryFactory.createMemory(LOCAL_NODE, { enableTestMode: true });
  return new ConnectionRegistry(entityRegistry, LOCAL_NODE, {
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    allowReconnect: true,
  });
}

function makeRemoteUpdate(overrides: Partial<EntityUpdate> & Pick<EntityUpdate, 'entityId' | 'operation'>): EntityUpdate {
  return {
    ownerNodeId: REMOTE_NODE,
    version: 1,
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

describe('ConnectionRegistry', () => {
  let registry: ConnectionRegistry;

  afterEach(async () => {
    jest.clearAllTimers();
    await registry.stop();
  });

  describe('register()', () => {
    it('returns a ConnectionHandle with correct fields', async () => {
      registry = makeRegistry();
      await registry.start();

      const before = Date.now();
      const handle = await registry.register('conn-1', { userId: 'u1' });

      expect(handle.connectionId).toBe('conn-1');
      expect(handle.nodeId).toBe(LOCAL_NODE);
      expect(handle.metadata).toEqual({ userId: 'u1' });
      expect(handle.registeredAt).toBeGreaterThanOrEqual(before);
      expect(handle.expiresAt).toBeUndefined();
    });

    it('sets expiresAt when ttlMs is configured', async () => {
      registry = makeRegistry(TTL_MS);
      await registry.start();

      const handle = await registry.register('conn-ttl');
      expect(handle.expiresAt).toBe(handle.registeredAt + TTL_MS);
    });

    it('throws on duplicate connectionId', async () => {
      registry = makeRegistry();
      await registry.start();

      await registry.register('conn-dup');
      await expect(registry.register('conn-dup')).rejects.toThrow();
    });
  });

  describe('unregister()', () => {
    it('makes locate() return null after unregister', async () => {
      registry = makeRegistry();
      await registry.start();

      await registry.register('conn-2');
      expect(registry.locate('conn-2')).toBe(LOCAL_NODE);

      await registry.unregister('conn-2');
      expect(registry.locate('conn-2')).toBeNull();
    });

    it('is a no-op for unknown connectionId', async () => {
      registry = makeRegistry();
      await registry.start();

      await expect(registry.unregister('not-registered')).resolves.toBeUndefined();
    });

    it('logs a warning when releaseEntity throws unexpectedly', async () => {
      const entityRegistry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
      const connReg = new ConnectionRegistry(entityRegistry, 'node-1');
      registry = connReg;
      await connReg.start();

      await connReg.register('conn-1');

      // Force releaseEntity to throw
      const origRelease = entityRegistry.releaseEntity.bind(entityRegistry);
      (entityRegistry as any).releaseEntity = jest.fn().mockRejectedValue(new Error('boom'));

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      // Should NOT throw despite inner error
      await expect(connReg.unregister('conn-1')).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('releaseEntity(conn-1)'),
        expect.any(Error)
      );

      warnSpy.mockRestore();
      (entityRegistry as any).releaseEntity = origRelease;
    });
  });

  describe('locate()', () => {
    it('returns the ownerNodeId for a registered connection', async () => {
      registry = makeRegistry();
      await registry.start();

      await registry.register('conn-3');
      expect(registry.locate('conn-3')).toBe(LOCAL_NODE);
    });

    it('returns null for unknown connectionId', async () => {
      registry = makeRegistry();
      await registry.start();

      expect(registry.locate('unknown')).toBeNull();
    });
  });

  describe('getLocalConnections()', () => {
    it('returns only local connections', async () => {
      registry = makeRegistry();
      await registry.start();

      await registry.register('local-1');
      await registry.register('local-2');

      const remoteUpdate = makeRemoteUpdate({ entityId: 'remote-1', operation: 'CREATE' });
      await registry.applyRemoteUpdate(remoteUpdate);

      const local = registry.getLocalConnections();
      expect(local.map((h) => h.connectionId).sort()).toEqual(['local-1', 'local-2']);
      expect(local.every((h) => h.nodeId === LOCAL_NODE)).toBe(true);
    });
  });

  describe('getAllConnections()', () => {
    it('includes local + connections applied via applyRemoteUpdate', async () => {
      registry = makeRegistry();
      await registry.start();

      await registry.register('local-a');

      const remoteUpdate = makeRemoteUpdate({ entityId: 'remote-a', operation: 'CREATE' });
      await registry.applyRemoteUpdate(remoteUpdate);

      const all = registry.getAllConnections();
      const ids = all.map((h) => h.connectionId).sort();
      expect(ids).toEqual(['local-a', 'remote-a']);
    });
  });

  describe('TTL expiry', () => {
    it('connection expires after ttlMs with no heartbeat — emits connection:expired', async () => {
      registry = makeRegistry(TTL_MS);
      await registry.start();

      const expiredHandler = jest.fn();
      const unregisteredHandler = jest.fn();
      registry.on('connection:expired', expiredHandler);
      registry.on('connection:unregistered', unregisteredHandler);

      await registry.register('conn-expire');
      expect(registry.locate('conn-expire')).toBe(LOCAL_NODE);

      await jest.advanceTimersByTimeAsync(TTL_MS + 1);

      expect(expiredHandler).toHaveBeenCalledWith('conn-expire');
      expect(unregisteredHandler).toHaveBeenCalledWith('conn-expire');
      expect(registry.locate('conn-expire')).toBeNull();
    });

    it('heartbeat resets the TTL', async () => {
      registry = makeRegistry(TTL_MS);
      await registry.start();

      const expiredHandler = jest.fn();
      registry.on('connection:expired', expiredHandler);

      await registry.register('conn-hb');

      await jest.advanceTimersByTimeAsync(TTL_MS - 1);
      registry.heartbeat('conn-hb');

      await jest.advanceTimersByTimeAsync(TTL_MS - 1);
      expect(expiredHandler).not.toHaveBeenCalled();
      expect(registry.locate('conn-hb')).toBe(LOCAL_NODE);

      await jest.advanceTimersByTimeAsync(2);
      expect(expiredHandler).toHaveBeenCalledWith('conn-hb');
    });

    it('heartbeat is a no-op when ttlMs is not configured', async () => {
      registry = makeRegistry();
      await registry.start();

      await registry.register('conn-no-ttl');
      expect(() => registry.heartbeat('conn-no-ttl')).not.toThrow();
      expect(registry.locate('conn-no-ttl')).toBe(LOCAL_NODE);
    });
  });

  describe('events', () => {
    it("emits 'connection:registered' event on register", async () => {
      registry = makeRegistry();
      await registry.start();

      const handler = jest.fn();
      registry.on('connection:registered', handler);

      await registry.register('conn-ev1', { tag: 'test' });

      expect(handler).toHaveBeenCalledTimes(1);
      const handle: ConnectionHandle = handler.mock.calls[0][0];
      expect(handle.connectionId).toBe('conn-ev1');
      expect(handle.nodeId).toBe(LOCAL_NODE);
      expect(handle.metadata).toEqual({ tag: 'test' });
    });

    it("emits 'connection:unregistered' on manual unregister", async () => {
      registry = makeRegistry();
      await registry.start();

      const handler = jest.fn();
      registry.on('connection:unregistered', handler);

      await registry.register('conn-ev2');
      await registry.unregister('conn-ev2');

      expect(handler).toHaveBeenCalledWith('conn-ev2');
    });

    it("emits 'connection:unregistered' on TTL expiry", async () => {
      registry = makeRegistry(TTL_MS);
      await registry.start();

      const unregisteredHandler = jest.fn();
      registry.on('connection:unregistered', unregisteredHandler);

      await registry.register('conn-ev3');
      await jest.advanceTimersByTimeAsync(TTL_MS + 1);

      expect(unregisteredHandler).toHaveBeenCalledWith('conn-ev3');
    });
  });

  describe('metrics', () => {
    let metricsReg: ConnectionRegistry;
    let metricsRegistry: MetricsRegistry;

    beforeEach(async () => {
      metricsRegistry = new MetricsRegistry(LOCAL_NODE);
      const entityRegistry = EntityRegistryFactory.createMemory(LOCAL_NODE, { enableTestMode: true });
      metricsReg = new ConnectionRegistry(entityRegistry, LOCAL_NODE, {
        ttlMs: TTL_MS,
        metrics: metricsRegistry,
      });
      registry = metricsReg;
      await metricsReg.start();
    });

    it('increments connection.registered.count on register', async () => {
      await metricsReg.register('c1');
      expect(metricsRegistry.counter('connection.registered.count').get()).toBe(1);
      await metricsReg.register('c2');
      expect(metricsRegistry.counter('connection.registered.count').get()).toBe(2);
    });

    it('increments connection.unregistered.count on manual unregister', async () => {
      await metricsReg.register('c1');
      await metricsReg.unregister('c1');
      expect(metricsRegistry.counter('connection.unregistered.count').get()).toBe(1);
    });

    it('connection.active.gauge reflects active connection count (increment + decrement)', async () => {
      expect(metricsRegistry.gauge('connection.active.gauge').get()).toBe(0);
      await metricsReg.register('c1');
      expect(metricsRegistry.gauge('connection.active.gauge').get()).toBe(1);
      await metricsReg.register('c2');
      expect(metricsRegistry.gauge('connection.active.gauge').get()).toBe(2);
      await metricsReg.unregister('c1');
      expect(metricsRegistry.gauge('connection.active.gauge').get()).toBe(1);
    });

    it('increments connection.expired.count and decrements gauge on TTL expiry', async () => {
      await metricsReg.register('c-expire');
      expect(metricsRegistry.gauge('connection.active.gauge').get()).toBe(1);

      await jest.advanceTimersByTimeAsync(TTL_MS + 1);

      expect(metricsRegistry.counter('connection.expired.count').get()).toBe(1);
      expect(metricsRegistry.gauge('connection.active.gauge').get()).toBe(0);
    });

    it('no metrics errors when metrics is omitted', async () => {
      const entityRegistry = EntityRegistryFactory.createMemory(LOCAL_NODE, { enableTestMode: true });
      const reg = new ConnectionRegistry(entityRegistry, LOCAL_NODE);
      await reg.start();
      await expect(reg.register('c-no-metrics')).resolves.toBeDefined();
      await reg.stop();
    });
  });

  describe('getStats()', () => {
    it('returns correct counts', async () => {
      registry = makeRegistry(TTL_MS);
      await registry.start();

      expect(registry.getStats()).toEqual({ local: 0, total: 0, pendingExpiry: 0 });

      await registry.register('conn-s1');
      await registry.register('conn-s2');

      const remoteUpdate = makeRemoteUpdate({ entityId: 'remote-s1', operation: 'CREATE' });
      await registry.applyRemoteUpdate(remoteUpdate);

      const stats = registry.getStats();
      expect(stats.local).toBe(2);
      expect(stats.total).toBe(3);
      expect(stats.pendingExpiry).toBe(2);

      await registry.unregister('conn-s1');
      const stats2 = registry.getStats();
      expect(stats2.local).toBe(1);
      expect(stats2.total).toBe(2);
      expect(stats2.pendingExpiry).toBe(1);
    });
  });

  describe('allowReconnect', () => {
    // 1. Default behavior unchanged: duplicate register throws.
    it('default (allowReconnect: false) — duplicate register still throws', async () => {
      registry = makeRegistry();
      await registry.start();

      await registry.register('conn-dup-default');
      await expect(registry.register('conn-dup-default')).rejects.toThrow();
    });

    // 2. allowReconnect: true — second register returns existing handle with reset TTL.
    it('allowReconnect: true — second register returns existing handle with reset TTL', async () => {
      registry = makeReconnectRegistry(TTL_MS);
      await registry.start();

      const first = await registry.register('conn-rc', { initial: true });
      expect(first.connectionId).toBe('conn-rc');

      const second = await registry.register('conn-rc', {});
      expect(second.connectionId).toBe('conn-rc');
      expect(second.nodeId).toBe(LOCAL_NODE);
      // expiresAt should be reset relative to the reconnect call, not the original registration.
      expect(second.expiresAt).toBeGreaterThanOrEqual(first.expiresAt!);
    });

    // 3. allowReconnect: true — metadata from second register merges with first (new values win).
    it('allowReconnect: true — metadata is merged, new values win', async () => {
      registry = makeReconnectRegistry();
      await registry.start();

      await registry.register('conn-meta', { a: 1, b: 'old' });
      const second = await registry.register('conn-meta', { b: 'new', c: 3 });

      expect(second.metadata).toEqual({ a: 1, b: 'new', c: 3 });
    });

    // 4. allowReconnect: true — 'connection:reconnected' fires instead of 'connection:registered'.
    it("allowReconnect: true — emits 'connection:reconnected' on duplicate, not 'connection:registered'", async () => {
      registry = makeReconnectRegistry();
      await registry.start();

      const registeredHandler = jest.fn();
      const reconnectedHandler = jest.fn();
      registry.on('connection:registered', registeredHandler);
      registry.on('connection:reconnected', reconnectedHandler);

      await registry.register('conn-ev-rc');
      // First register: emits 'connection:registered' via the entity:created event, not reconnected.
      expect(registeredHandler).toHaveBeenCalledTimes(1);
      expect(reconnectedHandler).toHaveBeenCalledTimes(0);

      await registry.register('conn-ev-rc', { tag: 'reconnect' });
      // Second register: emits 'connection:reconnected', NOT another 'connection:registered'.
      expect(reconnectedHandler).toHaveBeenCalledTimes(1);
      const handle: ConnectionHandle = reconnectedHandler.mock.calls[0][0];
      expect(handle.connectionId).toBe('conn-ev-rc');
      expect(handle.metadata).toMatchObject({ tag: 'reconnect' });
      // No additional 'connection:registered' fired.
      expect(registeredHandler).toHaveBeenCalledTimes(1);
    });

    // 5. allowReconnect: true + remote-owned connection: throws.
    it('allowReconnect: true — throws when trying to reconnect a remote-owned connection', async () => {
      registry = makeReconnectRegistry();
      await registry.start();

      // Inject a remote-owned connection via applyRemoteUpdate.
      const remoteUpdate = makeRemoteUpdate({ entityId: 'conn-remote-rc', operation: 'CREATE' });
      await registry.applyRemoteUpdate(remoteUpdate);

      await expect(registry.register('conn-remote-rc')).rejects.toThrow(
        /Cannot reconnect.*owned by remote node/,
      );
    });

    // 6. After reconnect, TTL timer is rescheduled correctly.
    it('allowReconnect: true — TTL timer is rescheduled after reconnect', async () => {
      registry = makeReconnectRegistry(TTL_MS);
      await registry.start();

      const expiredHandler = jest.fn();
      registry.on('connection:expired', expiredHandler);

      await registry.register('conn-ttl-rc');

      // Advance almost to the original TTL boundary.
      await jest.advanceTimersByTimeAsync(TTL_MS - 100);
      expect(expiredHandler).not.toHaveBeenCalled();

      // Reconnect — timer should be reset from this point.
      await registry.register('conn-ttl-rc', { reconnected: true });

      // Advance past where the OLD timer would have fired (100 ms more) — should NOT fire yet.
      await jest.advanceTimersByTimeAsync(200);
      expect(expiredHandler).not.toHaveBeenCalled();

      // Advance the remaining TTL from the reconnect point — should fire now.
      await jest.advanceTimersByTimeAsync(TTL_MS - 200);
      expect(expiredHandler).toHaveBeenCalledWith('conn-ttl-rc');
    });
  });
});
