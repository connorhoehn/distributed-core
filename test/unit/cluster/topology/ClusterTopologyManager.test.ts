/**
 * Tests for ClusterTopologyManager — audit fix H1 (listener leak).
 *
 * The core regression: start() used fresh .bind(this) calls while stop()
 * created NEW .bind(this) closures, so removeListener was a no-op and every
 * start→stop cycle leaked three listeners onto the cluster EventEmitter.
 *
 * Fix: bound handlers are stored as private readonly instance properties in
 * the constructor and reused in both start() and stop().
 */

import { EventEmitter } from 'events';
import { ClusterTopologyManager } from '../../../../src/cluster/topology/ClusterTopologyManager';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

/** A fake ClusterManager that only needs EventEmitter + membership.getAllMembers(). */
function makeCluster(): EventEmitter & { membership: { getAllMembers: () => [] }; hashRing: { getNode: (id: string) => null } } {
  const ee = new EventEmitter() as any;
  ee.membership = { getAllMembers: () => [] };
  ee.hashRing = { getNode: (_id: string) => null };
  return ee;
}

/** Minimal StateAggregator stub — collectClusterState never resolves in these tests. */
function makeAggregator() {
  return {
    collectClusterState: jest.fn().mockResolvedValue({
      clusterHealth: {},
      nodeStates: new Map(),
      aggregatedServices: [],
      aggregatedMetrics: {},
      consistencyScore: 1,
      partitionInfo: { isPartitioned: false, partitionCount: 0, largestPartitionSize: 0, unreachableNodes: [] },
      timestamp: Date.now(),
    }),
  };
}

/** Minimal MetricsTracker stub. */
function makeMetricsTracker() {
  return {
    getCurrentMetrics: jest.fn().mockResolvedValue(null),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClusterTopologyManager — listener leak fix (audit H1)', () => {
  it('start→stop cycled 10× leaves member:joined listenerCount at 0', async () => {
    const cluster = makeCluster();
    const aggregator = makeAggregator();
    const tracker = makeMetricsTracker();

    const manager = new ClusterTopologyManager(
      cluster as any,
      aggregator as any,
      tracker as any,
      // Very long update interval so the periodic timer never fires during this test.
      { updateIntervalMs: 999_999 },
    );

    for (let i = 0; i < 10; i++) {
      await manager.start();
      await manager.stop();
    }

    expect(cluster.listenerCount('member:joined')).toBe(0);
    expect(cluster.listenerCount('member:left')).toBe(0);
    expect(cluster.listenerCount('member:updated')).toBe(0);
  });

  it('after a single start→stop the cluster emitter has no dangling listeners', async () => {
    const cluster = makeCluster();
    const manager = new ClusterTopologyManager(
      cluster as any,
      makeAggregator() as any,
      makeMetricsTracker() as any,
      { updateIntervalMs: 999_999 },
    );

    await manager.start();
    expect(cluster.listenerCount('member:joined')).toBe(1);

    await manager.stop();
    expect(cluster.listenerCount('member:joined')).toBe(0);
  });

  it('stop() before start() does not throw', async () => {
    const cluster = makeCluster();
    const manager = new ClusterTopologyManager(
      cluster as any,
      makeAggregator() as any,
      makeMetricsTracker() as any,
    );

    // Should not throw even though start() was never called.
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(cluster.listenerCount('member:joined')).toBe(0);
  });
});
