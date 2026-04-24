import { ConnectionRegistry, ConnectionHandle } from '../../../src/connections/ConnectionRegistry';
import { EntityRegistryFactory } from '../../../src/cluster/entity/EntityRegistryFactory';
import { EntityRegistry } from '../../../src/cluster/entity/types';
import { EntityUpdate } from '../../../src/persistence/wal/types';

jest.useFakeTimers();

const LOCAL_NODE = 'node-local';
const REMOTE_NODE = 'node-remote';
const TTL_MS = 5000;

function makeRegistry(ttlMs?: number): ConnectionRegistry {
  const entityRegistry = EntityRegistryFactory.createMemory(LOCAL_NODE, { enableTestMode: true });
  return new ConnectionRegistry(entityRegistry, LOCAL_NODE, ttlMs !== undefined ? { ttlMs } : undefined);
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
});
