import { EventEmitter } from 'events';
import { ResourceRouter } from '../../../src/routing/ResourceRouter';
import { AutoReclaimPolicy } from '../../../src/routing/AutoReclaimPolicy';
import { HashPlacement, LocalPlacement } from '../../../src/routing/PlacementStrategy';
import { EntityRegistryFactory } from '../../../src/cluster/entity/EntityRegistryFactory';
import { PlacementStrategy, ResourceHandle } from '../../../src/routing/types';
import { MembershipEntry } from '../../../src/cluster/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForEvent(emitter: NodeJS.EventEmitter, event: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    emitter.once(event, (...args) => resolve(args));
  });
}

// ---------------------------------------------------------------------------
// Cluster stub (matches ResourceRouter.test.ts)
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
// Setup helpers
// ---------------------------------------------------------------------------

const activeRouters: ResourceRouter[] = [];
const activePolicies: AutoReclaimPolicy[] = [];

async function makeSetup(
  localNodeId = 'node-1',
  peers: { id: string; address: string; port: number }[] = [],
  policyConfig?: ConstructorParameters<typeof AutoReclaimPolicy>[1]
) {
  const cluster = makeCluster(localNodeId, peers);
  const registry = EntityRegistryFactory.createMemory(localNodeId, { enableTestMode: true });
  const router = new ResourceRouter(localNodeId, registry, cluster as any);
  await router.start();
  activeRouters.push(router);

  const policy = new AutoReclaimPolicy(router, policyConfig);
  activePolicies.push(policy);

  return { router, cluster, registry, policy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutoReclaimPolicy', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();

    for (const p of activePolicies.splice(0)) {
      p.stop();
    }
    for (const r of activeRouters.splice(0)) {
      await r.stop();
    }
  });

  // -------------------------------------------------------------------------
  // 1. Skips when strategy picks another node
  // -------------------------------------------------------------------------

  it('emits reclaim:skipped when the strategy selects a different node', async () => {
    const otherNode = { id: 'node-2', address: '10.0.0.2', port: 7001 };
    const { cluster, registry, policy } = await makeSetup('node-1', [otherNode], {
      strategy: {
        selectNode: () => 'node-2',
      } satisfies PlacementStrategy,
      jitterMs: 0,
    });

    policy.start();

    const skipped = jest.fn();
    const attempted = jest.fn();
    policy.on('reclaim:skipped', skipped);
    policy.on('reclaim:attempted', attempted);

    await registry.applyRemoteUpdate({
      entityId: 'room-a', ownerNodeId: 'node-2', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });

    cluster.simulateLeave('node-2');

    expect(skipped).toHaveBeenCalledWith('room-a', 'strategy-chose-other');
    expect(attempted).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Claims after jitter when strategy picks this node
  // -------------------------------------------------------------------------

  it('emits reclaim:succeeded when claim succeeds after jitter', async () => {
    const { cluster, registry, policy } = await makeSetup('node-1', [
      { id: 'node-2', address: '10.0.0.2', port: 7001 },
    ], {
      strategy: new LocalPlacement(),
      jitterMs: 500,
    });

    policy.start();

    const attempted = jest.fn();
    policy.on('reclaim:attempted', attempted);

    await registry.applyRemoteUpdate({
      entityId: 'room-b', ownerNodeId: 'node-2', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });

    const succeededPromise = waitForEvent(policy, 'reclaim:succeeded');
    cluster.simulateLeave('node-2');

    expect(attempted).toHaveBeenCalledWith('room-b');

    jest.advanceTimersByTime(600);
    const [handle] = await succeededPromise;

    expect((handle as ResourceHandle).resourceId).toBe('room-b');
    expect((handle as ResourceHandle).ownerNodeId).toBe('node-1');
  });

  // -------------------------------------------------------------------------
  // 3. Emits reclaim:failed when claim throws (another node beat us)
  // -------------------------------------------------------------------------

  it('emits reclaim:failed when claim throws', async () => {
    const { router, cluster, registry, policy } = await makeSetup('node-1', [
      { id: 'node-2', address: '10.0.0.2', port: 7001 },
    ], {
      strategy: new LocalPlacement(),
      jitterMs: 0,
      maxClaimAttempts: 1,
    });

    policy.start();

    jest.spyOn(router, 'claim').mockRejectedValue(new Error('conflict: already claimed'));

    await registry.applyRemoteUpdate({
      entityId: 'room-c', ownerNodeId: 'node-2', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });

    const failedPromise = waitForEvent(policy, 'reclaim:failed');
    cluster.simulateLeave('node-2');

    jest.advanceTimersByTime(10);
    const [resourceId, err] = await failedPromise;

    expect(resourceId).toBe('room-c');
    expect(err).toBeInstanceOf(Error);
  });

  // -------------------------------------------------------------------------
  // 4. Skips with 'already-claimed' if resource has a current owner
  // -------------------------------------------------------------------------

  it('emits reclaim:skipped with already-claimed if resource is owned when timer fires', async () => {
    const { router, cluster, registry, policy } = await makeSetup('node-1', [
      { id: 'node-2', address: '10.0.0.2', port: 7001 },
      { id: 'node-3', address: '10.0.0.3', port: 7002 },
    ], {
      strategy: new LocalPlacement(),
      jitterMs: 500,
    });

    policy.start();

    const succeeded = jest.fn();
    policy.on('reclaim:succeeded', succeeded);

    await registry.applyRemoteUpdate({
      entityId: 'room-d', ownerNodeId: 'node-2', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });

    // node-3 wins the race before our timer fires
    jest.spyOn(router, 'route').mockResolvedValue({
      nodeId: 'node-3', address: '10.0.0.3', port: 7002, isLocal: false,
    });
    jest.spyOn(router, 'getAliveNodeIds').mockReturnValue(['node-1', 'node-3']);

    const skippedPromise = waitForEvent(policy, 'reclaim:skipped');
    cluster.simulateLeave('node-2');

    jest.advanceTimersByTime(600);
    const [resourceId, reason] = await skippedPromise;

    expect(resourceId).toBe('room-d');
    expect(reason).toBe('already-claimed');
    expect(succeeded).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. stop() cancels pending timers
  // -------------------------------------------------------------------------

  it('stop() cancels pending timers so no claim attempt is made', async () => {
    const { router, cluster, registry, policy } = await makeSetup('node-1', [
      { id: 'node-2', address: '10.0.0.2', port: 7001 },
    ], {
      strategy: new LocalPlacement(),
      jitterMs: 500,
    });

    policy.start();

    const claimSpy = jest.spyOn(router, 'claim');

    await registry.applyRemoteUpdate({
      entityId: 'room-e', ownerNodeId: 'node-2', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });

    cluster.simulateLeave('node-2');
    policy.stop();

    await jest.runAllTimersAsync();

    expect(claimSpy).not.toHaveBeenCalled();
    expect(policy.isStarted()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. Multiple orphan events schedule independent timers
  // -------------------------------------------------------------------------

  it('handles multiple orphaned resources independently', async () => {
    const { cluster, registry, policy } = await makeSetup('node-1', [
      { id: 'node-2', address: '10.0.0.2', port: 7001 },
    ], {
      strategy: new LocalPlacement(),
      jitterMs: 500,
    });

    policy.start();

    await registry.applyRemoteUpdate({
      entityId: 'room-f1', ownerNodeId: 'node-2', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });
    await registry.applyRemoteUpdate({
      entityId: 'room-f2', ownerNodeId: 'node-2', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });

    const results: string[] = [];
    const done = new Promise<void>((resolve) => {
      policy.on('reclaim:succeeded', (h: ResourceHandle) => {
        results.push(h.resourceId);
        if (results.length === 2) resolve();
      });
    });

    cluster.simulateLeave('node-2');
    jest.advanceTimersByTime(600);

    await done;

    expect(results.sort()).toEqual(['room-f1', 'room-f2']);
  });

  // -------------------------------------------------------------------------
  // 7. jitterMs: 0 causes immediate claim attempt
  // -------------------------------------------------------------------------

  it('jitterMs 0 fires immediately (within same tick batch)', async () => {
    const { cluster, registry, policy } = await makeSetup('node-1', [
      { id: 'node-2', address: '10.0.0.2', port: 7001 },
    ], {
      strategy: new LocalPlacement(),
      jitterMs: 0,
    });

    policy.start();

    await registry.applyRemoteUpdate({
      entityId: 'room-g', ownerNodeId: 'node-2', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });

    const succeededPromise = waitForEvent(policy, 'reclaim:succeeded');
    cluster.simulateLeave('node-2');

    jest.advanceTimersByTime(0);
    const [handle] = await succeededPromise;

    expect((handle as ResourceHandle).resourceId).toBe('room-g');
  });

  // -------------------------------------------------------------------------
  // 8. Custom PlacementStrategy (HashPlacement) is honored
  // -------------------------------------------------------------------------

  it('honors a custom HashPlacement strategy', async () => {
    // Use 3 nodes: node-2 (the dying one) + node-3 (survivor). After node-2 leaves,
    // alive set = [node-1, node-3]. Find a resourceId that HashPlacement maps to
    // node-3 so the reclaim is skipped on node-1.
    const hashStrategy = new HashPlacement();
    const localId = 'node-1';
    const dyingId = 'node-2';
    const survivorId = 'node-3';

    const { cluster, registry, policy } = await makeSetup(localId, [
      { id: dyingId, address: '10.0.0.2', port: 7001 },
      { id: survivorId, address: '10.0.0.3', port: 7002 },
    ], {
      strategy: hashStrategy,
      jitterMs: 0,
    });

    policy.start();

    const skipped = jest.fn();
    const succeeded = jest.fn();
    policy.on('reclaim:skipped', skipped);
    policy.on('reclaim:succeeded', succeeded);

    // Alive after node-2 leaves: [node-1, node-3]
    const aliveAfterLeave = [localId, survivorId];
    let resourceForSurvivor: string | null = null;

    for (let i = 0; i < 200; i++) {
      const rid = `hash-res-${i}`;
      if (hashStrategy.selectNode(rid, localId, aliveAfterLeave) === survivorId) {
        resourceForSurvivor = rid;
        break;
      }
    }

    expect(resourceForSurvivor).not.toBeNull();

    await registry.applyRemoteUpdate({
      entityId: resourceForSurvivor!, ownerNodeId: dyingId, version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });
    cluster.simulateLeave(dyingId);

    expect(skipped).toHaveBeenCalledWith(resourceForSurvivor, 'strategy-chose-other');
    expect(succeeded).not.toHaveBeenCalled();
  });
});
