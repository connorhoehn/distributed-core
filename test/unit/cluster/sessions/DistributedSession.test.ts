import { EventEmitter } from 'events';
import { ResourceRouter } from '../../../../src/routing/ResourceRouter';
import { EntityRegistryFactory } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { MembershipEntry } from '../../../../src/cluster/types';
import { HashPlacement, LocalPlacement } from '../../../../src/routing/PlacementStrategy';
import { DistributedSession } from '../../../../src/cluster/sessions/DistributedSession';
import { SharedStateAdapter } from '../../../../src/gateway/state/types';
import { MetricsRegistry } from '../../../../src/monitoring/metrics/MetricsRegistry';

// ---------------------------------------------------------------------------
// Minimal ClusterManager stub
// ---------------------------------------------------------------------------

function makeCluster(localNodeId: string, peers: { id: string; address: string; port: number }[] = []) {
  const emitter = new EventEmitter();
  const membership = new Map<string, MembershipEntry>();

  membership.set(localNodeId, {
    id: localNodeId,
    status: 'ALIVE',
    lastSeen: Date.now(),
    version: 1,
    lastUpdated: Date.now(),
    metadata: { address: '127.0.0.1', port: 7000 },
  } as MembershipEntry);

  for (const peer of peers) {
    membership.set(peer.id, {
      id: peer.id,
      status: 'ALIVE',
      lastSeen: Date.now(),
      version: 1,
      lastUpdated: Date.now(),
      metadata: { address: peer.address, port: peer.port },
    } as MembershipEntry);
  }

  return {
    getMembership: () => membership,
    getLocalNodeInfo: () => ({ id: localNodeId, status: 'ALIVE', lastSeen: Date.now(), version: 1 }),
    on: (event: string, handler: (...args: any[]) => void) => emitter.on(event, handler),
    off: (event: string, handler: (...args: any[]) => void) => emitter.off(event, handler),
    emit: (event: string, ...args: any[]) => emitter.emit(event, ...args),
    _membership: membership,
    _emitter: emitter,
    simulateLeave: (nodeId: string) => {
      const entry = membership.get(nodeId);
      if (entry) membership.set(nodeId, { ...entry, status: 'DEAD' });
      emitter.emit('member-left', nodeId);
    },
  };
}

// ---------------------------------------------------------------------------
// Test state adapter
// ---------------------------------------------------------------------------

interface TestState {
  count: number;
}

interface TestUpdate {
  inc: number;
}

const adapter: SharedStateAdapter<TestState, TestUpdate> = {
  createState: () => ({ count: 0 }),
  applyUpdate: (state, update) => ({ count: state.count + update.inc }),
  serialize: (s) => JSON.stringify(s),
  deserialize: (raw) => JSON.parse(raw as string),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const activeSessions: DistributedSession<TestState, TestUpdate>[] = [];

async function makeSession(
  nodeId = 'node-1',
  peers: { id: string; address: string; port: number }[] = [],
  config?: { idleTimeoutMs?: number; placement?: any }
) {
  const cluster = makeCluster(nodeId, peers);
  const registry = EntityRegistryFactory.createMemory(nodeId, { enableTestMode: true });
  const router = new ResourceRouter(nodeId, registry, cluster as any, {
    placement: new LocalPlacement(),
  });
  const session = new DistributedSession<TestState, TestUpdate>(nodeId, router, adapter, config);
  await session.start();
  activeSessions.push(session);
  return { session, cluster, registry, router };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DistributedSession', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    jest.useRealTimers();
    for (const s of activeSessions.splice(0)) {
      await s.stop();
    }
  });

  // 1. join() creates a session locally and returns isLocal: true with initial state
  it('join() creates a session locally and returns isLocal: true with initial state', async () => {
    const { session } = await makeSession();
    const info = await session.join('sess-1');

    expect(info.isLocal).toBe(true);
    expect(info.sessionId).toBe('sess-1');
    expect(info.ownerNodeId).toBe('node-1');
    expect(info.state).toEqual({ count: 0 });
    expect(session.isLocal('sess-1')).toBe(true);
  });

  // 2. join() on the same sessionId returns the existing session (no double-claim)
  it('join() on the same sessionId returns the existing session without double-claiming', async () => {
    const { session } = await makeSession();
    const info1 = await session.join('sess-dup');
    await session.apply('sess-dup', { inc: 5 });

    const info2 = await session.join('sess-dup');
    expect(info2.isLocal).toBe(true);
    expect(info2.state).toEqual({ count: 5 });
  });

  // 3. apply() updates state and resets idle timer
  it('apply() updates state and resets idle timer', async () => {
    const { session } = await makeSession('node-1', [], { idleTimeoutMs: 5000 });
    await session.join('sess-apply');

    jest.advanceTimersByTime(4000);
    const newState = await session.apply('sess-apply', { inc: 3 });

    expect(newState).toEqual({ count: 3 });
    expect(session.getState('sess-apply')).toEqual({ count: 3 });

    jest.advanceTimersByTime(4000);
    expect(session.isLocal('sess-apply')).toBe(true);

    jest.advanceTimersByTime(1100);
    expect(session.isLocal('sess-apply')).toBe(false);
  });

  // 4. apply() on non-local session throws
  it('apply() on non-local session throws', async () => {
    const { session } = await makeSession();
    await expect(session.apply('unknown-sess', { inc: 1 })).rejects.toThrow('unknown-sess is not local');
  });

  // 5. Idle timeout fires: emits 'session:evicted', session is no longer local
  it('idle timeout fires: emits session:evicted and session is no longer local', async () => {
    const { session } = await makeSession('node-1', [], { idleTimeoutMs: 10_000 });
    await session.join('sess-evict');

    const evictedIds: string[] = [];
    session.on('session:evicted', (id: string) => evictedIds.push(id));

    jest.advanceTimersByTime(10_001);

    expect(evictedIds).toEqual(['sess-evict']);
    expect(session.isLocal('sess-evict')).toBe(false);
    expect(session.getState('sess-evict')).toBeNull();
  });

  // 6. leave() releases the session, isLocal becomes false
  it('leave() releases the session, isLocal becomes false', async () => {
    const { session } = await makeSession();
    await session.join('sess-leave');
    expect(session.isLocal('sess-leave')).toBe(true);

    await session.leave('sess-leave');
    expect(session.isLocal('sess-leave')).toBe(false);
    expect(session.getState('sess-leave')).toBeNull();
  });

  // 7. getLocalSessions() returns only local sessions
  it('getLocalSessions() returns only local sessions', async () => {
    const { session } = await makeSession();
    await session.join('sess-a');
    await session.join('sess-b');

    const local = session.getLocalSessions();
    expect(local).toHaveLength(2);
    const ids = local.map((s) => s.sessionId).sort();
    expect(ids).toEqual(['sess-a', 'sess-b']);
  });

  // 8. getState() returns null for unknown session
  it('getState() returns null for unknown session', async () => {
    const { session } = await makeSession();
    expect(session.getState('nonexistent')).toBeNull();
  });

  // 9. Router resource:orphaned event causes DistributedSession to emit session:orphaned
  it("router resource:orphaned event causes DistributedSession to emit 'session:orphaned'", async () => {
    const peers = [{ id: 'node-2', address: '10.0.0.2', port: 7001 }];
    const { session, cluster, registry } = await makeSession('node-1', peers);

    await registry.applyRemoteUpdate({
      entityId: 'sess-remote',
      ownerNodeId: 'node-2',
      version: 1,
      timestamp: Date.now(),
      operation: 'CREATE',
      metadata: {},
    });

    const orphanedIds: string[] = [];
    session.on('session:orphaned', (id: string) => orphanedIds.push(id));

    cluster.simulateLeave('node-2');

    expect(orphanedIds).toEqual(['sess-remote']);
  });

  // 10. stop() releases all sessions
  it('stop() releases all sessions', async () => {
    const cluster = makeCluster('node-1');
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    const router = new ResourceRouter('node-1', registry, cluster as any, {
      placement: new LocalPlacement(),
    });
    const session = new DistributedSession<TestState, TestUpdate>('node-1', router, adapter);
    await session.start();

    await session.join('sess-x');
    await session.join('sess-y');
    expect(session.getLocalSessions()).toHaveLength(2);

    await session.stop();

    expect(router.getOwnedResources()).toHaveLength(0);
  });

  // 11. After idle eviction, another join() can reclaim the session
  it('after idle eviction, another join() can reclaim the session', async () => {
    const { session } = await makeSession('node-1', [], { idleTimeoutMs: 5_000 });
    await session.join('sess-reclaim');

    jest.advanceTimersByTime(5_001);
    expect(session.isLocal('sess-reclaim')).toBe(false);

    const info = await session.join('sess-reclaim');
    expect(info.isLocal).toBe(true);
    expect(info.state).toEqual({ count: 0 });
    expect(session.isLocal('sess-reclaim')).toBe(true);
  });

  // Remote session path: isLocal: false when target node is a peer
  it('join() returns isLocal: false when placement routes to a peer node', async () => {
    const peers = [{ id: 'node-2', address: '10.0.0.2', port: 7001 }];
    const { session } = await makeSession('node-1', peers, {
      placement: { selectNode: (_id: string, _local: string) => 'node-2' },
    });

    const info = await session.join('sess-remote');
    expect(info.isLocal).toBe(false);
    expect(info.ownerNodeId).toBe('node-2');
  });

  // getStats() reflects current counts
  it('getStats() reflects localSessions and pendingEvictions', async () => {
    const { session } = await makeSession('node-1', [], { idleTimeoutMs: 60_000 });
    expect(session.getStats()).toEqual({ localSessions: 0, pendingEvictions: 0 });

    await session.join('sess-stat');
    expect(session.getStats()).toEqual({ localSessions: 1, pendingEvictions: 1 });

    await session.leave('sess-stat');
    expect(session.getStats()).toEqual({ localSessions: 0, pendingEvictions: 0 });
  });

  // session:created event is emitted on local join
  it("emits 'session:created' when a session is created locally", async () => {
    const { session } = await makeSession();
    const created: Array<[string, TestState]> = [];
    session.on('session:created', (id: string, state: TestState) => created.push([id, state]));

    await session.join('sess-emit');
    expect(created).toHaveLength(1);
    expect(created[0][0]).toBe('sess-emit');
    expect(created[0][1]).toEqual({ count: 0 });
  });

  // ownsRouter: false — session.start() does not call router.start()
  it('ownsRouter: false does not call router.start() in session.start()', async () => {
    const cluster = makeCluster('node-1');
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    const router = new ResourceRouter('node-1', registry, cluster as any, {
      placement: new LocalPlacement(),
    });
    // Start the router externally so it is usable
    await router.start();

    const startSpy = jest.spyOn(router, 'start');

    const session = new DistributedSession<TestState, TestUpdate>('node-1', router, adapter, {
      ownsRouter: false,
    });
    activeSessions.push(session);
    await session.start();

    expect(startSpy).not.toHaveBeenCalled();

    startSpy.mockRestore();
    await router.stop();
  });

  // ownsRouter: false — session.stop() does not call router.stop()
  it('ownsRouter: false does not call router.stop() in session.stop()', async () => {
    const cluster = makeCluster('node-1');
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    const router = new ResourceRouter('node-1', registry, cluster as any, {
      placement: new LocalPlacement(),
    });
    await router.start();

    const stopSpy = jest.spyOn(router, 'stop');

    const session = new DistributedSession<TestState, TestUpdate>('node-1', router, adapter, {
      ownsRouter: false,
    });
    await session.start();
    await session.stop();

    expect(stopSpy).not.toHaveBeenCalled();

    stopSpy.mockRestore();
    await router.stop();
  });

  // Default behavior (ownsRouter: true) starts the router on session.start()
  it('default ownsRouter: true calls router.start() on session.start()', async () => {
    const cluster = makeCluster('node-1');
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    const router = new ResourceRouter('node-1', registry, cluster as any, {
      placement: new LocalPlacement(),
    });

    const startSpy = jest.spyOn(router, 'start');

    const session = new DistributedSession<TestState, TestUpdate>('node-1', router, adapter);
    activeSessions.push(session);
    await session.start();

    expect(startSpy).toHaveBeenCalledTimes(1);
    startSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // metrics
  // -------------------------------------------------------------------------

  describe('metrics', () => {
    async function makeMetricsSession() {
      const metrics = new MetricsRegistry('node-1');
      const cluster = makeCluster('node-1', [{ id: 'node-2', address: '10.0.0.2', port: 7001 }]);
      const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
      const router = new ResourceRouter('node-1', registry, cluster as any, {
        placement: new LocalPlacement(),
      });
      const session = new DistributedSession<TestState, TestUpdate>('node-1', router, adapter, {
        idleTimeoutMs: 60_000,
        metrics,
      });
      activeSessions.push(session);
      await session.start();
      return { session, cluster, registry, metrics };
    }

    it('increments session.created.count on join', async () => {
      const { session, metrics } = await makeMetricsSession();
      await session.join('s1');
      expect(metrics.counter('session.created.count').get()).toBe(1);
    });

    it('session.active.gauge reflects active count (increment + decrement cycle)', async () => {
      const { session, metrics } = await makeMetricsSession();
      expect(metrics.gauge('session.active.gauge').get()).toBe(0);
      await session.join('s1');
      expect(metrics.gauge('session.active.gauge').get()).toBe(1);
      await session.join('s2');
      expect(metrics.gauge('session.active.gauge').get()).toBe(2);
      await session.leave('s1');
      expect(metrics.gauge('session.active.gauge').get()).toBe(1);
    });

    it('records session.apply.latency_ms histogram on apply', async () => {
      const { session, metrics } = await makeMetricsSession();
      await session.join('s1');
      await session.apply('s1', { inc: 1 });
      expect(metrics.histogram('session.apply.latency_ms').getCount()).toBe(1);
    });

    it('increments session.evicted.count on idle eviction and updates gauge', async () => {
      const metrics = new MetricsRegistry('node-1');
      const cluster = makeCluster('node-1');
      const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
      const router = new ResourceRouter('node-1', registry, cluster as any, {
        placement: new LocalPlacement(),
      });
      const session = new DistributedSession<TestState, TestUpdate>('node-1', router, adapter, {
        idleTimeoutMs: 5_000,
        metrics,
      });
      activeSessions.push(session);
      await session.start();

      await session.join('s-evict');
      expect(metrics.gauge('session.active.gauge').get()).toBe(1);

      jest.advanceTimersByTime(5_001);
      expect(metrics.counter('session.evicted.count').get()).toBe(1);
      expect(metrics.gauge('session.active.gauge').get()).toBe(0);
    });

    it('increments session.orphaned.count on orphan event', async () => {
      const { session, cluster, registry, metrics } = await makeMetricsSession();
      await registry.applyRemoteUpdate({
        entityId: 'sess-orphan', ownerNodeId: 'node-2', version: 1,
        timestamp: Date.now(), operation: 'CREATE', metadata: {},
      });
      cluster.simulateLeave('node-2');
      expect(metrics.counter('session.orphaned.count').get()).toBe(1);
    });

    it('no metrics errors when metrics is omitted', async () => {
      const { session } = await makeSession();
      await expect(session.join('s-no-metrics')).resolves.toBeDefined();
    });
  });

  // resource:orphaned listener is attached in start(), not constructor
  it('resource:orphaned listener is added in start() not constructor', async () => {
    const cluster = makeCluster('node-1');
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    const router = new ResourceRouter('node-1', registry, cluster as any, {
      placement: new LocalPlacement(),
    });
    await router.start();

    const session = new DistributedSession<TestState, TestUpdate>('node-1', router, adapter, {
      ownsRouter: false,
    });

    // After construction, before start(), no listener should be attached
    expect(router.listenerCount('resource:orphaned')).toBe(0);

    await session.start();
    // After start(), the listener should be attached
    expect(router.listenerCount('resource:orphaned')).toBe(1);

    await session.stop();
    // After stop(), the listener should be removed
    expect(router.listenerCount('resource:orphaned')).toBe(0);

    await router.stop();
  });
});
