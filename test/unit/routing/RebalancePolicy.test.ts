import { EventEmitter } from 'events';
import { ResourceRouter } from '../../../src/routing/ResourceRouter';
import { RebalancePolicy } from '../../../src/routing/RebalancePolicy';
import {
  HashPlacement,
  LocalPlacement,
} from '../../../src/routing/PlacementStrategy';
import { EntityRegistryFactory } from '../../../src/cluster/entity/EntityRegistryFactory';
import {
  PlacementStrategy,
  ResourceHandle,
} from '../../../src/routing/types';
import { MembershipEntry, NodeInfo } from '../../../src/cluster/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForEvent(
  emitter: NodeJS.EventEmitter,
  event: string
): Promise<unknown[]> {
  return new Promise((resolve) => {
    emitter.once(event, (...args) => resolve(args));
  });
}

// ---------------------------------------------------------------------------
// Cluster stub (matches the AutoReclaimPolicy/ResourceRouter test pattern)
// ---------------------------------------------------------------------------

function makeCluster(
  localNodeId: string,
  peers: { id: string; address: string; port: number }[] = []
) {
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
    getLocalNodeInfo: () => ({
      id: localNodeId,
      status: 'ALIVE',
      lastSeen: Date.now(),
      version: 1,
    }),
    on: (event: string, handler: (...args: any[]) => void) =>
      emitter.on(event, handler),
    off: (event: string, handler: (...args: any[]) => void) =>
      emitter.off(event, handler),
    emit: (event: string, ...args: any[]) => emitter.emit(event, ...args),
    _membership: membership,
    _emitter: emitter,
    simulateJoin: (peer: { id: string; address: string; port: number }) => {
      membership.set(peer.id, {
        id: peer.id,
        status: 'ALIVE',
        lastSeen: Date.now(),
        version: 1,
        lastUpdated: Date.now(),
        metadata: { address: peer.address, port: peer.port },
      } as MembershipEntry);
      const info: NodeInfo = {
        id: peer.id,
        status: 'ALIVE',
        lastSeen: Date.now(),
        version: 1,
        metadata: { address: peer.address, port: peer.port },
      };
      emitter.emit('member-joined', info);
    },
  };
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

const activeRouters: ResourceRouter[] = [];
const activePolicies: RebalancePolicy[] = [];

async function makeSetup(
  localNodeId = 'node-1',
  peers: { id: string; address: string; port: number }[] = [],
  policyConfig?: ConstructorParameters<typeof RebalancePolicy>[1]
) {
  const cluster = makeCluster(localNodeId, peers);
  const registry = EntityRegistryFactory.createMemory(localNodeId, {
    enableTestMode: true,
  });
  const router = new ResourceRouter(localNodeId, registry, cluster as any);
  await router.start();
  activeRouters.push(router);

  const policy = new RebalancePolicy(router, policyConfig);
  activePolicies.push(policy);

  return { router, cluster, registry, policy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RebalancePolicy', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();

    for (const p of activePolicies.splice(0)) {
      await p.stop();
    }
    for (const r of activeRouters.splice(0)) {
      await r.stop();
    }
  });

  // -------------------------------------------------------------------------
  // 1. Trigger fires on member-joined
  // -------------------------------------------------------------------------

  it('schedules a rebalance pass when a new member joins', async () => {
    const { cluster, policy } = await makeSetup('node-1', [], {
      strategy: new LocalPlacement(),
      jitterMs: 1000,
      targetLoadDelta: 0,
    });
    await policy.start();

    const scheduled = jest.fn();
    policy.on('rebalance:scheduled', scheduled);

    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });

    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it('does not schedule when a different trigger is configured', async () => {
    const { cluster, policy } = await makeSetup('node-1', [], {
      strategy: new LocalPlacement(),
      trigger: 'member-left',
      jitterMs: 1000,
    });
    await policy.start();

    const scheduled = jest.fn();
    policy.on('rebalance:scheduled', scheduled);

    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });

    expect(scheduled).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Jitter is applied (fake timers)
  // -------------------------------------------------------------------------

  it('waits jitterMs * random() before evaluating', async () => {
    const { router, cluster, registry, policy } = await makeSetup(
      'node-1',
      [],
      {
        // Force an actual transfer: strategy chooses node-2 once it's alive.
        strategy: {
          selectNode: (_id, _local, candidates) =>
            candidates.includes('node-2') ? 'node-2' : _local,
        } satisfies PlacementStrategy,
        jitterMs: 4000,
        targetLoadDelta: 0,
        maxTransfersPerSecond: 0,
      }
    );
    await policy.start();

    // Pre-claim a resource locally so there is something to migrate.
    await registry.proposeEntity('room-jitter', {});

    // Pin Math.random so we can predict the delay.
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // delay = 2000

    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });

    const transferSpy = jest.spyOn(router, 'transfer').mockResolvedValue({
      resourceId: 'room-jitter',
      ownerNodeId: 'node-2',
      metadata: {},
      claimedAt: Date.now(),
      version: 2,
    } as ResourceHandle);

    // Before the jitter window elapses, no transfer should have been issued.
    await jest.advanceTimersByTimeAsync(1999);
    expect(transferSpy).not.toHaveBeenCalled();

    // Crossing the 2000ms threshold should trigger evaluation.
    await jest.advanceTimersByTimeAsync(2);
    expect(transferSpy).toHaveBeenCalledWith('room-jitter', 'node-2');
  });

  // -------------------------------------------------------------------------
  // 3. Throttle is honored
  // -------------------------------------------------------------------------

  it('honors maxTransfersPerSecond by spacing out transfers', async () => {
    const { router, cluster, registry, policy } = await makeSetup(
      'node-1',
      [],
      {
        strategy: {
          selectNode: (_id, _local, candidates) =>
            candidates.includes('node-2') ? 'node-2' : _local,
        } satisfies PlacementStrategy,
        jitterMs: 0,
        maxTransfersPerSecond: 2,
        // Negative threshold disables the load-delta gate so we exclusively
        // exercise the throttle path here.
        targetLoadDelta: -Infinity,
      }
    );
    await policy.start();

    // Claim 5 resources locally.
    for (let i = 0; i < 5; i++) {
      await registry.proposeEntity(`room-throttle-${i}`, {});
    }

    const transferTimes: number[] = [];
    jest.spyOn(router, 'transfer').mockImplementation(async (rid, target) => {
      transferTimes.push(Date.now());
      return {
        resourceId: rid,
        ownerNodeId: target,
        metadata: {},
        claimedAt: Date.now(),
        version: 2,
      } as ResourceHandle;
    });

    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });

    // Drain the entire throttled queue. With limit=2/sec and 5 transfers,
    // the longest possible spread is well under 10 seconds.
    for (let i = 0; i < 200; i++) {
      await jest.advanceTimersByTimeAsync(50);
      if (transferTimes.length === 5) break;
    }

    expect(transferTimes.length).toBe(5);
    // First two should be in the same throttle window (no wait).
    expect(transferTimes[1] - transferTimes[0]).toBeLessThan(50);
    // Third should be at least ~1000ms after the first.
    expect(transferTimes[2] - transferTimes[0]).toBeGreaterThanOrEqual(1000);
    // Fifth should be at least ~2000ms after the first (rate-limited).
    expect(transferTimes[4] - transferTimes[0]).toBeGreaterThanOrEqual(2000);
  });

  // -------------------------------------------------------------------------
  // 4. No-op when ideal owner equals local
  // -------------------------------------------------------------------------

  it('does not transfer when the placement strategy returns the local node', async () => {
    const { router, cluster, registry, policy } = await makeSetup(
      'node-1',
      [],
      {
        strategy: new LocalPlacement(), // always returns local
        jitterMs: 0,
        maxTransfersPerSecond: 0,
        targetLoadDelta: 0,
      }
    );
    await policy.start();

    await registry.proposeEntity('room-stay-1', {});
    await registry.proposeEntity('room-stay-2', {});

    const transferSpy = jest.spyOn(router, 'transfer');

    const evaluatedPromise = waitForEvent(policy, 'rebalance:evaluated');
    const skipped: Array<[string, string]> = [];
    policy.on('rebalance:skipped', (rid: string, reason: string) =>
      skipped.push([rid, reason])
    );

    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });

    await jest.advanceTimersByTimeAsync(0);
    const [summary] = await evaluatedPromise;

    expect(transferSpy).not.toHaveBeenCalled();
    expect((summary as { transferred: number }).transferred).toBe(0);
    expect(skipped).toEqual([
      ['room-stay-1', 'already-ideal'],
      ['room-stay-2', 'already-ideal'],
    ]);
  });

  // -------------------------------------------------------------------------
  // 5. No-op when load delta below threshold
  // -------------------------------------------------------------------------

  it('skips transfer when load delta is below targetLoadDelta', async () => {
    // Plant the joining node already in membership so we can pre-seed it
    // with resources, then "join" it via the event.
    const peer = { id: 'node-2', address: '10.0.0.2', port: 7001 };

    const { router, cluster, registry, policy } = await makeSetup(
      'node-1',
      [peer],
      {
        // Strategy says ideal = node-2 — but we'll see the load gate stop it.
        strategy: {
          selectNode: () => 'node-2',
        } satisfies PlacementStrategy,
        jitterMs: 0,
        maxTransfersPerSecond: 0,
        targetLoadDelta: 0.5, // require >=50% delta
      }
    );
    await policy.start();

    // Local owns 4, node-2 owns 3. delta = (4-3)/4 = 0.25 < 0.5 -> skip.
    for (let i = 0; i < 4; i++) {
      await registry.proposeEntity(`local-${i}`, {});
    }
    for (let i = 0; i < 3; i++) {
      await registry.applyRemoteUpdate({
        entityId: `remote-${i}`,
        ownerNodeId: 'node-2',
        version: 1,
        timestamp: Date.now(),
        operation: 'CREATE',
        metadata: {},
      });
    }

    const transferSpy = jest.spyOn(router, 'transfer');
    const skipped: Array<[string, string]> = [];
    policy.on('rebalance:skipped', (rid: string, reason: string) =>
      skipped.push([rid, reason])
    );

    const evaluatedPromise = waitForEvent(policy, 'rebalance:evaluated');
    cluster.simulateJoin(peer);

    await jest.advanceTimersByTimeAsync(0);
    await evaluatedPromise;

    expect(transferSpy).not.toHaveBeenCalled();
    expect(skipped.length).toBe(4);
    expect(skipped.every(([, reason]) => reason === 'below-load-delta')).toBe(
      true
    );
  });

  // -------------------------------------------------------------------------
  // 6. Clean stop unsubscribes
  // -------------------------------------------------------------------------

  it('stop() unsubscribes from the trigger and clears pending timers', async () => {
    const { router, cluster, registry, policy } = await makeSetup(
      'node-1',
      [],
      {
        strategy: {
          selectNode: (_id, _local, candidates) =>
            candidates.includes('node-2') ? 'node-2' : _local,
        } satisfies PlacementStrategy,
        jitterMs: 5000,
        maxTransfersPerSecond: 0,
        targetLoadDelta: 0,
      }
    );
    await policy.start();
    await registry.proposeEntity('room-stop', {});

    const transferSpy = jest.spyOn(router, 'transfer');
    const scheduled = jest.fn();
    policy.on('rebalance:scheduled', scheduled);

    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });
    expect(scheduled).toHaveBeenCalledTimes(1);

    // Stop before the jitter window elapses.
    await policy.stop();
    expect(policy.isStarted()).toBe(false);

    // Run any pending timers; nothing should fire now.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(transferSpy).not.toHaveBeenCalled();

    // Subsequent member-joined events should be ignored.
    cluster.simulateJoin({ id: 'node-3', address: '10.0.0.3', port: 7002 });
    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 7. Default strategy is HashPlacement (smoke test)
  // -------------------------------------------------------------------------

  it('uses HashPlacement by default', async () => {
    const { policy } = await makeSetup('node-1');
    expect(policy).toBeInstanceOf(RebalancePolicy);
    // Default strategy is exercised in the join flow indirectly; this guards
    // against accidental default change.
    expect(
      (policy as unknown as { strategy: unknown }).strategy
    ).toBeInstanceOf(HashPlacement);
  });

  // -------------------------------------------------------------------------
  // 8. start() / stop() idempotent
  // -------------------------------------------------------------------------

  it('start() and stop() are idempotent', async () => {
    const { policy } = await makeSetup('node-1');
    await policy.start();
    await policy.start();
    expect(policy.isStarted()).toBe(true);
    await policy.stop();
    await policy.stop();
    expect(policy.isStarted()).toBe(false);
  });
});
