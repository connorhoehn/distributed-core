import { EventEmitter } from 'events';
import { ResourceRouter } from '../../../src/routing/ResourceRouter';
import {
  RebalancePolicy,
  PeerLoadProvider,
  RebalancePolicyConfig,
} from '../../../src/routing/RebalancePolicy';
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

/**
 * Build a peerLoadProvider stub that returns a fixed map. Useful for tests
 * that want to assert the policy's response to a particular cluster shape
 * without needing live peer telemetry.
 */
function staticPeerLoads(
  loads: Record<string, number>
): PeerLoadProvider {
  return async () => new Map(Object.entries(loads));
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
  policyConfig?: RebalancePolicyConfig
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
        maxTransfersPerSecond: 0,
        // Make the cluster-mean guard easy to clear.
        thresholdAboveMean: 0.0,
        peerLoadProvider: staticPeerLoads({
          'node-1': 100, // doesn't matter — overridden by local measurement
          'node-2': 0,
        }),
      }
    );
    await policy.start();

    // Pre-claim a resource locally so there is something to migrate, AND
    // so the local load (count=1) > clusterMean (avg of {1, 0} = 0.5).
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
    await jest.advanceTimersByTimeAsync(50);
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
        thresholdAboveMean: 0.0,
        peerLoadProvider: staticPeerLoads({ 'node-2': 0 }),
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
        thresholdAboveMean: 0.0,
        peerLoadProvider: staticPeerLoads({ 'node-2': 0 }),
      }
    );
    await policy.start();

    await registry.proposeEntity('room-stay-1', {});
    await registry.proposeEntity('room-stay-2', {});

    const transferSpy = jest.spyOn(router, 'transfer');

    const evaluatedPromise = waitForEvent(policy, 'rebalance:evaluated');
    const skipped: Array<[string | null, string]> = [];
    policy.on('rebalance:skipped', (rid: string | null, reason: string) =>
      skipped.push([rid, reason])
    );

    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });

    await jest.advanceTimersByTimeAsync(50);
    const [summary] = await evaluatedPromise;

    expect(transferSpy).not.toHaveBeenCalled();
    expect((summary as { transferred: number }).transferred).toBe(0);
    expect(skipped).toEqual([
      ['room-stay-1', 'already-ideal'],
      ['room-stay-2', 'already-ideal'],
    ]);
  });

  // -------------------------------------------------------------------------
  // 5. Clean stop unsubscribes
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
        thresholdAboveMean: 0.0,
        peerLoadProvider: staticPeerLoads({ 'node-2': 0 }),
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
  // 6. Default strategy is HashPlacement (smoke test)
  // -------------------------------------------------------------------------

  it('uses HashPlacement by default', async () => {
    const { policy } = await makeSetup('node-1');
    expect(policy).toBeInstanceOf(RebalancePolicy);
    expect(
      (policy as unknown as { strategy: unknown }).strategy
    ).toBeInstanceOf(HashPlacement);
  });

  // -------------------------------------------------------------------------
  // 7. start() / stop() idempotent
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

  // -------------------------------------------------------------------------
  // 8. Cluster-mean trigger: rebalance only fires when local > mean
  // -------------------------------------------------------------------------

  it('triggers a rebalance pass only when localLoad exceeds clusterMean by thresholdAboveMean', async () => {
    // Local owns 10, peer owns 0. Mean = 5. Local/mean = 2.0. Threshold 0.20
    // requires ratio > 1.20 — easily clears.
    const { router, cluster, registry, policy } = await makeSetup(
      'node-1',
      [],
      {
        strategy: {
          selectNode: (_id, _local, candidates) =>
            candidates.includes('node-2') ? 'node-2' : _local,
        } satisfies PlacementStrategy,
        jitterMs: 0,
        maxTransfersPerSecond: 0,
        thresholdAboveMean: 0.2,
        peerLoadProvider: staticPeerLoads({ 'node-2': 0 }),
      }
    );
    await policy.start();

    for (let i = 0; i < 10; i++) {
      await registry.proposeEntity(`room-${i}`, {});
    }

    const transferSpy = jest.spyOn(router, 'transfer').mockImplementation(
      async (rid, target) =>
        ({
          resourceId: rid,
          ownerNodeId: target,
          metadata: {},
          claimedAt: Date.now(),
          version: 2,
        }) as ResourceHandle
    );

    const evaluated = waitForEvent(policy, 'rebalance:evaluated');
    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });
    await jest.advanceTimersByTimeAsync(50);
    const [summary] = await evaluated;

    expect((summary as { transferred: number }).transferred).toBe(10);
    expect(transferSpy).toHaveBeenCalledTimes(10);
  });

  // -------------------------------------------------------------------------
  // 9. Asymmetric guard: a node BELOW the mean does not rebalance
  // -------------------------------------------------------------------------

  it('does not rebalance when localLoad is below clusterMean (asymmetric)', async () => {
    // Local owns 1, peer reports 100. Mean = 50.5. Local/mean << 1 — node
    // is "underloaded" and should never shed work.
    const { router, cluster, registry, policy } = await makeSetup(
      'node-1',
      [],
      {
        strategy: {
          selectNode: (_id, _local, candidates) =>
            candidates.includes('node-2') ? 'node-2' : _local,
        } satisfies PlacementStrategy,
        jitterMs: 0,
        maxTransfersPerSecond: 0,
        thresholdAboveMean: 0.2,
        peerLoadProvider: staticPeerLoads({ 'node-2': 100 }),
      }
    );
    await policy.start();

    await registry.proposeEntity('room-only', {});

    const transferSpy = jest.spyOn(router, 'transfer');
    const skipped: Array<[string | null, string]> = [];
    policy.on('rebalance:skipped', (rid: string | null, reason: string) =>
      skipped.push([rid, reason])
    );

    const evaluated = waitForEvent(policy, 'rebalance:evaluated');
    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });
    await jest.advanceTimersByTimeAsync(50);
    await evaluated;

    expect(transferSpy).not.toHaveBeenCalled();
    expect(skipped).toEqual([[null, 'below-threshold']]);
  });

  // -------------------------------------------------------------------------
  // 10. Default thresholdAboveMean is 0.20 — borderline cases respect it
  // -------------------------------------------------------------------------

  it('respects the default 20% threshold above mean', async () => {
    // Local owns 11, peer reports 10. Mean = 10.5. ratio = 11/10.5 ≈ 1.0476.
    // That's below 1 + 0.20 = 1.20 — so it should NOT trigger by default.
    const { router, cluster, registry, policy } = await makeSetup(
      'node-1',
      [],
      {
        strategy: {
          selectNode: (_id, _local, candidates) =>
            candidates.includes('node-2') ? 'node-2' : _local,
        } satisfies PlacementStrategy,
        jitterMs: 0,
        maxTransfersPerSecond: 0,
        // Default thresholdAboveMean (0.2) — explicitly NOT overridden.
        peerLoadProvider: staticPeerLoads({ 'node-2': 10 }),
      }
    );
    await policy.start();

    for (let i = 0; i < 11; i++) {
      await registry.proposeEntity(`room-${i}`, {});
    }

    const transferSpy = jest.spyOn(router, 'transfer');
    const evaluated = waitForEvent(policy, 'rebalance:evaluated');
    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });
    await jest.advanceTimersByTimeAsync(50);
    const [summary] = await evaluated;

    expect(transferSpy).not.toHaveBeenCalled();
    expect((summary as { transferred: number }).transferred).toBe(0);
    expect((summary as { reason?: string }).reason).toBe('below-threshold');
  });

  // -------------------------------------------------------------------------
  // 11. P95 dampening: a single spike does not trigger a rebalance
  // -------------------------------------------------------------------------

  it('dampens a single spike via P95 over the dampening window', async () => {
    // Strategy: drive 9 prior trigger fires with localLoad=0 (no resources
    // owned), then claim a burst of resources right before the 10th fire.
    // The instantaneous ratio will be huge, but P95 over the 60s window is
    // dominated by the prior zeros — guard should reject as 'dampened'.
    let loadOverride: number | null = null;
    const { router, cluster, policy } = await makeSetup('node-1', [], {
      strategy: {
        selectNode: (_id, _local, candidates) =>
          candidates.includes('node-2') ? 'node-2' : _local,
      } satisfies PlacementStrategy,
      jitterMs: 0,
      maxTransfersPerSecond: 0,
      thresholdAboveMean: 0.2,
      dampeningWindowMs: 60_000,
      dampeningPercentile: 0.95,
      // loadFn returns whatever loadOverride is set to. Bypasses needing
      // to actually claim resources for the dampening test.
      loadFn: () => (loadOverride !== null ? loadOverride : 0),
      peerLoadProvider: staticPeerLoads({ 'node-2': 1 }),
    });
    await policy.start();

    // Inject a single fake "owned" resource via the registry mock so that
    // loadFn is actually called. We claim a single trivial entity.
    await (router as any).registry.proposeEntity('probe', {});

    const transferSpy = jest.spyOn(router, 'transfer');
    const skippedEvents: Array<[string | null, string]> = [];
    policy.on('rebalance:skipped', (rid: string | null, reason: string) =>
      skippedEvents.push([rid, reason])
    );

    // 9 prior fires with load=0. Each one runs through evaluate(); since
    // localLoad=0 is BELOW the cluster mean (peer=1, so mean=0.5), each
    // pass skips for 'below-threshold' but ALSO appends a 0-sample to
    // the dampening window.
    loadOverride = 0;
    for (let i = 0; i < 9; i++) {
      cluster.simulateJoin({
        id: `node-warmup-${i}`,
        address: '10.0.0.99',
        port: 7099,
      });
      await jest.advanceTimersByTimeAsync(50);
    }

    // 10th fire: spike to 1000.
    loadOverride = 1000;
    skippedEvents.length = 0;
    const evaluated = waitForEvent(policy, 'rebalance:evaluated');
    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });
    await jest.advanceTimersByTimeAsync(50);
    const [summary] = await evaluated;

    // Instantaneous load (1000) >> mean — clears the instantaneous gate.
    // But P95 over the window includes nine 0-samples + one 1000-sample,
    // so P95 sits much closer to 0 than 1000, failing the dampened gate.
    expect(transferSpy).not.toHaveBeenCalled();
    expect((summary as { reason?: string }).reason).toBe('dampened');
    expect(skippedEvents).toContainEqual([null, 'dampened']);
  });

  // -------------------------------------------------------------------------
  // 12. Custom loadFn is honored
  // -------------------------------------------------------------------------

  it('honors a caller-supplied loadFn (e.g. egress bps, pipeline runs)', async () => {
    // Local owns 2 resources but each weighs 50 (e.g. egress bps).
    // Total localLoad = 100. Peer reports 10. Mean = 55. Ratio ≈ 1.82,
    // clears the 1.20 gate. Should rebalance both.
    const loadFn = jest.fn((_rid: string) => 50);
    const { router, cluster, registry, policy } = await makeSetup(
      'node-1',
      [],
      {
        strategy: {
          selectNode: (_id, _local, candidates) =>
            candidates.includes('node-2') ? 'node-2' : _local,
        } satisfies PlacementStrategy,
        jitterMs: 0,
        maxTransfersPerSecond: 0,
        thresholdAboveMean: 0.2,
        loadFn,
        peerLoadProvider: staticPeerLoads({ 'node-2': 10 }),
      }
    );
    await policy.start();

    await registry.proposeEntity('hot-room-A', {});
    await registry.proposeEntity('hot-room-B', {});

    const transferSpy = jest.spyOn(router, 'transfer').mockImplementation(
      async (rid, target) =>
        ({
          resourceId: rid,
          ownerNodeId: target,
          metadata: {},
          claimedAt: Date.now(),
          version: 2,
        }) as ResourceHandle
    );

    const evaluated = waitForEvent(policy, 'rebalance:evaluated');
    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });
    await jest.advanceTimersByTimeAsync(50);
    await evaluated;

    expect(loadFn).toHaveBeenCalledWith('hot-room-A');
    expect(loadFn).toHaveBeenCalledWith('hot-room-B');
    expect(transferSpy).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 13. Missing peerLoadProvider degrades to a no-op + warning
  // -------------------------------------------------------------------------

  it('no-ops with peer-load-unavailable when peerLoadProvider is not configured', async () => {
    const { router, cluster, registry, policy } = await makeSetup(
      'node-1',
      [],
      {
        strategy: {
          selectNode: (_id, _local, candidates) =>
            candidates.includes('node-2') ? 'node-2' : _local,
        } satisfies PlacementStrategy,
        jitterMs: 0,
        maxTransfersPerSecond: 0,
        thresholdAboveMean: 0.2,
        // peerLoadProvider: undefined — degraded mode.
      }
    );
    await policy.start();

    for (let i = 0; i < 5; i++) {
      await registry.proposeEntity(`room-${i}`, {});
    }

    const transferSpy = jest.spyOn(router, 'transfer');
    const skipped: Array<[string | null, string]> = [];
    policy.on('rebalance:skipped', (rid: string | null, reason: string) =>
      skipped.push([rid, reason])
    );

    const evaluated = waitForEvent(policy, 'rebalance:evaluated');
    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });
    await jest.advanceTimersByTimeAsync(50);
    const [summary] = await evaluated;

    expect(transferSpy).not.toHaveBeenCalled();
    expect((summary as { reason?: string }).reason).toBe(
      'peer-load-unavailable'
    );
    expect(skipped).toEqual([[null, 'peer-load-unavailable']]);
  });

  // -------------------------------------------------------------------------
  // 14. Provider reporting only the local node also degrades cleanly
  // -------------------------------------------------------------------------

  it('no-ops when peerLoadProvider returns only the local node', async () => {
    const { router, cluster, registry, policy } = await makeSetup(
      'node-1',
      [],
      {
        strategy: {
          selectNode: (_id, _local, candidates) =>
            candidates.includes('node-2') ? 'node-2' : _local,
        } satisfies PlacementStrategy,
        jitterMs: 0,
        maxTransfersPerSecond: 0,
        thresholdAboveMean: 0.2,
        peerLoadProvider: staticPeerLoads({ 'node-1': 7 }),
      }
    );
    await policy.start();

    await registry.proposeEntity('room-only', {});

    const transferSpy = jest.spyOn(router, 'transfer');
    const evaluated = waitForEvent(policy, 'rebalance:evaluated');
    cluster.simulateJoin({ id: 'node-2', address: '10.0.0.2', port: 7001 });
    await jest.advanceTimersByTimeAsync(50);
    const [summary] = await evaluated;

    expect(transferSpy).not.toHaveBeenCalled();
    expect((summary as { reason?: string }).reason).toBe(
      'peer-load-unavailable'
    );
  });
});
