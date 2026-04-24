import { EventEmitter } from 'events';
import { SharedStateManager } from '../../../../src/gateway/state/SharedStateManager';
import { SharedStateAdapter } from '../../../../src/gateway/state/types';
import { DistributedSession } from '../../../../src/cluster/sessions/DistributedSession';
import { ResourceRouter } from '../../../../src/routing/ResourceRouter';
import { EntityRegistryFactory } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { LocalPlacement } from '../../../../src/routing/PlacementStrategy';
import { InMemorySnapshotVersionStore } from '../../../../src/persistence/snapshot/InMemorySnapshotVersionStore';
import { MembershipEntry } from '../../../../src/cluster/types';
import { PubSubMessageMetadata } from '../../../../src/gateway/pubsub/types';

// ---------------------------------------------------------------------------
// Counter adapter
// ---------------------------------------------------------------------------

interface CounterState { count: number }
interface CounterUpdate { inc: number }

const adapter: SharedStateAdapter<CounterState, CounterUpdate> = {
  createState: () => ({ count: 0 }),
  applyUpdate: (s, u) => ({ count: s.count + u.inc }),
  serialize: (s) => JSON.stringify(s),
  deserialize: (raw) => JSON.parse(raw as string),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCluster(localNodeId: string) {
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
  return {
    getMembership: () => membership,
    getLocalNodeInfo: () => ({ id: localNodeId }),
    on: (e: string, h: (...a: any[]) => void) => emitter.on(e, h),
    off: (e: string, h: (...a: any[]) => void) => emitter.off(e, h),
    emit: (e: string, ...a: any[]) => emitter.emit(e, ...a),
  };
}

function makeMockPubSub(localNodeId = 'node-1') {
  type Handler = (topic: string, payload: unknown, meta: PubSubMessageMetadata) => void;
  const topicHandlers = new Map<string, Map<string, Handler>>();
  let counter = 0;

  const deliver = (topic: string, payload: unknown, sourceNodeId: string) => {
    const meta: PubSubMessageMetadata = {
      messageId: `msg-${++counter}`,
      publisherNodeId: sourceNodeId,
      timestamp: Date.now(),
      topic,
    };
    const subs = topicHandlers.get(topic);
    if (!subs) return;
    for (const handler of subs.values()) {
      handler(topic, payload, meta);
    }
  };

  const mock = {
    localNodeId,
    subscribe: jest.fn((topic: string, handler: Handler) => {
      const id = `sub-${++counter}`;
      let subs = topicHandlers.get(topic);
      if (!subs) { subs = new Map(); topicHandlers.set(topic, subs); }
      subs.set(id, handler);
      return id;
    }),
    unsubscribe: jest.fn((id: string) => {
      for (const subs of topicHandlers.values()) subs.delete(id);
      return true;
    }),
    publish: jest.fn(async (topic: string, payload: unknown) => {
      deliver(topic, payload, localNodeId);
    }),
    _deliver: deliver,
  };
  return mock;
}

async function makeSetup(nodeId = 'node-1') {
  const cluster = makeCluster(nodeId);
  const registry = EntityRegistryFactory.createMemory(nodeId, { enableTestMode: true });
  const router = new ResourceRouter(nodeId, registry, cluster as any, {
    placement: new LocalPlacement(),
  });
  const session = new DistributedSession<CounterState, CounterUpdate>(nodeId, router, adapter, {
    ownsRouter: true,
  });
  return { session, router, cluster };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SharedStateManager', () => {
  const activeSessions: DistributedSession<any, any>[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    jest.useRealTimers();
    for (const s of activeSessions.splice(0)) {
      await s.stop().catch(() => {});
    }
  });

  // 1. subscribe() returns initial state from adapter for a new channel
  it('subscribe() returns initial state from adapter for a new channel', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub();
    const mgr = new SharedStateManager(session, pubsub as any, adapter);
    await mgr.start();

    const state = await mgr.subscribe('client-1', 'ch-1');
    expect(state).toEqual({ count: 0 });
  });

  // 2. subscribe() hydrates from snapshotStore if a persisted snapshot exists
  it('subscribe() hydrates from snapshotStore if a persisted snapshot exists', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub();
    const snapshotStore = new InMemorySnapshotVersionStore<CounterState>();
    await snapshotStore.store('ch-hydrate', { count: 42 });

    const mgr = new SharedStateManager(session, pubsub as any, adapter, { snapshotStore });
    await mgr.start();

    const state = await mgr.subscribe('client-1', 'ch-hydrate');
    expect(state).toEqual({ count: 42 });
  });

  // 3. applyUpdate() modifies state, publishes to pubsub, schedules debounced snapshot
  it('applyUpdate() modifies state, publishes to pubsub, and schedules debounced snapshot', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub();
    const snapshotStore = new InMemorySnapshotVersionStore<CounterState>();
    const storeSpy = jest.spyOn(snapshotStore, 'store');

    const mgr = new SharedStateManager(session, pubsub as any, adapter, {
      snapshotStore,
      snapshotDebounceMs: 100,
    });
    await mgr.start();
    await mgr.subscribe('client-1', 'ch-1');
    await mgr.applyUpdate('ch-1', { inc: 5 });

    expect(pubsub.publish).toHaveBeenCalledWith(
      'shared-state:ch-1',
      expect.objectContaining({ update: { inc: 5 } })
    );
    expect(storeSpy).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(100);
    expect(storeSpy).toHaveBeenCalledWith('ch-1', { count: 5 }, { type: 'auto' });

    const snap = await mgr.getSnapshot('ch-1');
    expect(snap).toEqual({ count: 5 });
  });

  // 4. Second subscribe() to same channel returns the same state
  it('second subscribe() to same channel returns the same (updated) state', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub();
    const mgr = new SharedStateManager(session, pubsub as any, adapter);
    await mgr.start();

    await mgr.subscribe('client-1', 'ch-1');
    await mgr.applyUpdate('ch-1', { inc: 3 });
    const state2 = await mgr.subscribe('client-2', 'ch-1');

    expect(state2).toEqual({ count: 3 });
  });

  // 5. unsubscribe() of last client releases the session
  it('unsubscribe() of the last client releases the session on this node', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub();
    const mgr = new SharedStateManager(session, pubsub as any, adapter);
    await mgr.start();

    await mgr.subscribe('client-1', 'ch-1');
    expect(session.isLocal('ch-1')).toBe(true);

    await mgr.unsubscribe('client-1', 'ch-1');
    expect(session.isLocal('ch-1')).toBe(false);
  });

  // 6. onClientDisconnect() unsubscribes from all that client's channels
  it('onClientDisconnect() unsubscribes from all channels for that client', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub();
    const mgr = new SharedStateManager(session, pubsub as any, adapter);
    await mgr.start();

    await mgr.subscribe('client-1', 'ch-1');
    await mgr.subscribe('client-1', 'ch-2');
    expect(session.isLocal('ch-1')).toBe(true);
    expect(session.isLocal('ch-2')).toBe(true);

    await mgr.onClientDisconnect('client-1');
    expect(session.isLocal('ch-1')).toBe(false);
    expect(session.isLocal('ch-2')).toBe(false);
  });

  // 7. Cross-node incoming update updates follower state and emits 'state:updated'
  it('cross-node pubsub message updates follower state and emits state:updated', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub('node-1');
    const mgr = new SharedStateManager(session, pubsub as any, adapter);
    await mgr.start();

    await mgr.subscribe('client-1', 'ch-follower');

    await session.leave('ch-follower');

    const updates: Array<[string, CounterState]> = [];
    mgr.on('state:updated', (channelId: string, state: CounterState) => {
      updates.push([channelId, state]);
    });

    pubsub._deliver('shared-state:ch-follower', { update: { inc: 7 } }, 'node-2');

    expect(updates).toHaveLength(1);
    expect(updates[0][0]).toBe('ch-follower');
    expect(updates[0][1]).toEqual({ count: 7 });
  });

  // 8. Own published updates are NOT re-applied (loop prevention)
  it('own published updates are not re-applied (loop prevention)', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub('node-1');
    const mgr = new SharedStateManager(session, pubsub as any, adapter);
    await mgr.start();

    await mgr.subscribe('client-1', 'ch-1');
    await mgr.applyUpdate('ch-1', { inc: 1 });

    const snap = await mgr.getSnapshot('ch-1');
    expect(snap).toEqual({ count: 1 });
  });

  // 9. getSnapshot() returns latest state for local or follower channels
  it('getSnapshot() returns latest local state', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub();
    const mgr = new SharedStateManager(session, pubsub as any, adapter);
    await mgr.start();

    await mgr.subscribe('client-1', 'ch-1');
    await mgr.applyUpdate('ch-1', { inc: 10 });
    expect(await mgr.getSnapshot('ch-1')).toEqual({ count: 10 });
  });

  it('getSnapshot() returns follower state for non-local channels', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub('node-1');
    const mgr = new SharedStateManager(session, pubsub as any, adapter);
    await mgr.start();

    await mgr.subscribe('client-1', 'ch-follower');
    await session.leave('ch-follower');

    pubsub._deliver('shared-state:ch-follower', { update: { inc: 3 } }, 'node-2');

    expect(await mgr.getSnapshot('ch-follower')).toEqual({ count: 3 });
  });

  it('getSnapshot() returns null for unknown channels', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub();
    const mgr = new SharedStateManager(session, pubsub as any, adapter);
    await mgr.start();

    expect(await mgr.getSnapshot('nonexistent')).toBeNull();
  });

  // 10. applyUpdate on non-local channel throws
  it('applyUpdate() throws when channel is not owned by this node', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub();
    const mgr = new SharedStateManager(session, pubsub as any, adapter);
    await mgr.start();

    await expect(mgr.applyUpdate('not-owned', { inc: 1 })).rejects.toThrow(
      'channel is not owned by this node'
    );
  });

  // 11. stop() persists all active channels to the snapshot store
  it('stop() persists all active local channels to snapshot store', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub();
    const snapshotStore = new InMemorySnapshotVersionStore<CounterState>();
    const storeSpy = jest.spyOn(snapshotStore, 'store');

    const mgr = new SharedStateManager(session, pubsub as any, adapter, { snapshotStore });
    await mgr.start();

    await mgr.subscribe('client-1', 'ch-a');
    await mgr.applyUpdate('ch-a', { inc: 2 });
    await mgr.subscribe('client-2', 'ch-b');
    await mgr.applyUpdate('ch-b', { inc: 5 });

    await mgr.stop();

    expect(storeSpy).toHaveBeenCalledWith('ch-a', { count: 2 }, { type: 'checkpoint' });
    expect(storeSpy).toHaveBeenCalledWith('ch-b', { count: 5 }, { type: 'checkpoint' });
  });

  // onClientDisconnect is a no-op for unknown clients
  it('onClientDisconnect() is a no-op for unknown clients', async () => {
    const { session } = await makeSetup();
    activeSessions.push(session);
    const pubsub = makeMockPubSub();
    const mgr = new SharedStateManager(session, pubsub as any, adapter);
    await mgr.start();

    await expect(mgr.onClientDisconnect('ghost')).resolves.not.toThrow();
  });
});
