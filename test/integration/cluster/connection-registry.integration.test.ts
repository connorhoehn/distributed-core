/**
 * connection-registry.integration.test.ts
 *
 * Tests ConnectionRegistry + FailureDetectorBridge across 3 nodes.
 *
 * Each node:
 *  - Has its own EntityRegistry
 *  - Connected via the shared in-memory PubSub bus (EntityRegistrySyncAdapter)
 *  - Runs a ConnectionRegistry on top of the shared registry
 *
 * Scenarios:
 *  - Each node registers a connection; after settle all nodes see all 3
 *  - A fake FailureDetector fires node-failed for node A
 *    => node B's registry no longer shows conn-1 (owned by A)
 */

import { EventEmitter } from 'events';
import { ClusterSimulator } from '../helpers/ClusterSimulator';
import { ConnectionRegistry } from '../../../src/connections/ConnectionRegistry';
import { FailureDetectorBridge } from '../../../src/cluster/failure/FailureDetectorBridge';

jest.setTimeout(15000);

// ---------------------------------------------------------------------------
// Fake FailureDetector (only needs to emit 'node-failed')
// ---------------------------------------------------------------------------

class FakeFailureDetector extends EventEmitter {
  simulateFailure(nodeId: string): void {
    this.emit('node-failed', nodeId, 'test-failure');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConnectionRegistry — multi-node integration', () => {
  let sim: ClusterSimulator;
  let connRegistries: ConnectionRegistry[];
  let bridges: FailureDetectorBridge[];
  let detectors: FakeFailureDetector[];

  beforeEach(async () => {
    sim = new ClusterSimulator([
      { nodeId: 'node-a', address: '10.0.0.1', port: 7001 },
      { nodeId: 'node-b', address: '10.0.0.2', port: 7002 },
      { nodeId: 'node-c', address: '10.0.0.3', port: 7003 },
    ]);
    await sim.startAll();

    // Create a ConnectionRegistry per node (they share the same registry that's
    // synced via EntityRegistrySyncAdapter)
    connRegistries = sim.nodes().map((node) =>
      new ConnectionRegistry(node.registry, node.nodeId)
    );

    // Start connection registries (they call registry.start() internally,
    // but the registry is already started — that's fine since InMemoryEntityRegistry
    // is idempotent on start)
    await Promise.all(connRegistries.map((cr) => cr.start()));

    // Create a failure detector + bridge for each node
    detectors = sim.nodes().map(() => new FakeFailureDetector());
    bridges = sim.nodes().map((node, i) =>
      new FailureDetectorBridge(detectors[i] as any, {
        connectionRegistry: connRegistries[i],
      })
    );
    bridges.forEach((b) => b.start());
  });

  afterEach(async () => {
    bridges.forEach((b) => b.stop());
    // ConnectionRegistry.stop() calls registry.stop(), which may conflict with
    // the ClusterSimulator's stopAll(). Skip the explicit stop here and let
    // sim.stopAll() clean up.
    await sim.stopAll();
  });

  it('each node registers a connection and all nodes see all 3 after settle', async () => {
    const [crA, crB, crC] = connRegistries;
    const [nodeA, nodeB, nodeC] = sim.nodes();

    await crA.register('conn-1', { owner: nodeA.nodeId });
    await crB.register('conn-2', { owner: nodeB.nodeId });
    await crC.register('conn-3', { owner: nodeC.nodeId });

    // Wait for entity sync to propagate
    await sim.settle(200);

    // Each node should see all 3 connections
    for (const cr of connRegistries) {
      const all = cr.getAllConnections();
      const ids = all.map((c) => c.connectionId);
      expect(ids).toContain('conn-1');
      expect(ids).toContain('conn-2');
      expect(ids).toContain('conn-3');
    }
  });

  it("local connections are owned by the registering node", async () => {
    const [crA] = connRegistries;
    await crA.register('conn-local', { type: 'ws' });

    const local = crA.getLocalConnections();
    expect(local).toHaveLength(1);
    expect(local[0].connectionId).toBe('conn-local');
    expect(local[0].nodeId).toBe('node-a');
  });

  it('FailureDetectorBridge fires node-failed for node A; node B removes conn-1', async () => {
    const [crA, crB] = connRegistries;
    const [nodeA] = sim.nodes();

    await crA.register('conn-1', { owner: nodeA.nodeId });

    // Let it propagate to node B
    await sim.settle(200);

    expect(crB.getAllConnections().map((c) => c.connectionId)).toContain('conn-1');

    // Simulate node A failure detected on node B
    detectors[1].simulateFailure('node-a');

    // FailureDetectorBridge calls handleRemoteNodeFailure which uses applyRemoteUpdate
    // Give it a tick to process
    await new Promise<void>((r) => setImmediate(r));

    // conn-1 should no longer be in node B's registry
    const remaining = crB.getAllConnections().map((c) => c.connectionId);
    expect(remaining).not.toContain('conn-1');
  });

  it('locate() returns the owning nodeId after cross-node propagation', async () => {
    const [crA, crB] = connRegistries;
    await crA.register('conn-locate', { type: 'http' });

    await sim.settle(200);

    // Node B can locate conn-locate (owned by A)
    const owner = crB.locate('conn-locate');
    expect(owner).toBe('node-a');
  });

  it('unregistering a connection propagates removal to other nodes', async () => {
    const [crA, crB] = connRegistries;
    await crA.register('conn-del');

    await sim.settle(200);
    expect(crB.getAllConnections().map((c) => c.connectionId)).toContain('conn-del');

    await crA.unregister('conn-del');

    await sim.settle(200);
    expect(crB.getAllConnections().map((c) => c.connectionId)).not.toContain('conn-del');
  });

  it('getStats reflects local and total connections', async () => {
    const [crA, crB] = connRegistries;
    await crA.register('s-conn-1');
    await crA.register('s-conn-2');
    await crB.register('s-conn-3');

    await sim.settle(200);

    const statsA = crA.getStats();
    expect(statsA.local).toBe(2); // A owns 2
    expect(statsA.total).toBe(3); // All 3 visible

    const statsB = crB.getStats();
    expect(statsB.local).toBe(1); // B owns 1
    expect(statsB.total).toBe(3); // All 3 visible
  });
});
