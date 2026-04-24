/**
 * entity-sync.integration.test.ts
 *
 * Tests EntityRegistrySyncAdapter in a multi-node cluster where each node has
 * its own EntityRegistry connected via a shared in-memory PubSub bus.
 *
 * Scenarios:
 *  - Claim on node A propagates to B and C
 *  - Partitioned node's claims do NOT reach the far side
 *  - After heal, previously invisible claims become visible
 */

import { ClusterSimulator } from '../helpers/ClusterSimulator';

jest.setTimeout(15000);

describe('EntityRegistrySyncAdapter — multi-node integration', () => {
  let sim: ClusterSimulator;

  beforeEach(async () => {
    sim = new ClusterSimulator([
      { nodeId: 'node-a', address: '10.0.0.1', port: 7001 },
      { nodeId: 'node-b', address: '10.0.0.2', port: 7002 },
      { nodeId: 'node-c', address: '10.0.0.3', port: 7003 },
    ]);
    await sim.startAll();
  });

  afterEach(async () => {
    await sim.stopAll();
  });

  it('claim on node A propagates to node B and node C', async () => {
    const nodeA = sim.node('node-a');

    await nodeA.registry.proposeEntity('resource-1', { owner: 'node-a' });

    await sim.settle(100);

    const nodeB = sim.node('node-b');
    const nodeC = sim.node('node-c');

    expect(nodeB.registry.getEntityHost('resource-1')).toBe('node-a');
    expect(nodeC.registry.getEntityHost('resource-1')).toBe('node-a');
  });

  it('each node can independently claim separate resources and all nodes see all', async () => {
    const nodeA = sim.node('node-a');
    const nodeB = sim.node('node-b');
    const nodeC = sim.node('node-c');

    await nodeA.registry.proposeEntity('res-a');
    await nodeB.registry.proposeEntity('res-b');
    await nodeC.registry.proposeEntity('res-c');

    await sim.settle(100);

    // Each node should see all 3 resources
    for (const node of sim.nodes()) {
      expect(node.registry.getEntityHost('res-a')).toBe('node-a');
      expect(node.registry.getEntityHost('res-b')).toBe('node-b');
      expect(node.registry.getEntityHost('res-c')).toBe('node-c');
    }
  });

  it('partitioned node A: claims do NOT reach B and C', async () => {
    // Partition A away from B and C
    await sim.partition(['node-a'], ['node-b', 'node-c']);

    const nodeA = sim.node('node-a');
    await nodeA.registry.proposeEntity('resource-2', { owner: 'node-a' });

    await sim.settle(100);

    const nodeB = sim.node('node-b');
    const nodeC = sim.node('node-c');

    // B and C must NOT see resource-2 (A is partitioned from them)
    expect(nodeB.registry.getEntityHost('resource-2')).toBeNull();
    expect(nodeC.registry.getEntityHost('resource-2')).toBeNull();
  });

  it('after heal, claims can propagate to previously partitioned nodes', async () => {
    // Partition A from B and C
    await sim.partition(['node-a'], ['node-b', 'node-c']);

    const nodeA = sim.node('node-a');
    const nodeB = sim.node('node-b');
    const nodeC = sim.node('node-c');

    // Claim a resource on A while partitioned
    await nodeA.registry.proposeEntity('resource-3', { owner: 'node-a' });

    await sim.settle(50);

    // Not visible to B and C during partition
    expect(nodeB.registry.getEntityHost('resource-3')).toBeNull();
    expect(nodeC.registry.getEntityHost('resource-3')).toBeNull();

    // Heal the partition
    await sim.heal();

    // To re-propagate: release and reclaim resource-3 on A, which fires a DELETE then CREATE.
    // The CREATE will be synced to all now-reachable nodes.
    await nodeA.registry.releaseEntity('resource-3');
    await nodeA.registry.proposeEntity('resource-3', { owner: 'node-a', healed: true });

    await sim.settle(100);

    // Now B and C should see resource-3 as owned by A
    expect(nodeB.registry.getEntityHost('resource-3')).toBe('node-a');
    expect(nodeC.registry.getEntityHost('resource-3')).toBe('node-a');
  });

  it('release on node A propagates a DELETE to B and C', async () => {
    const nodeA = sim.node('node-a');
    await nodeA.registry.proposeEntity('resource-del');

    await sim.settle(100);

    const nodeB = sim.node('node-b');
    expect(nodeB.registry.getEntityHost('resource-del')).toBe('node-a');

    await nodeA.registry.releaseEntity('resource-del');

    await sim.settle(100);

    expect(nodeB.registry.getEntityHost('resource-del')).toBeNull();
    expect(sim.node('node-c').registry.getEntityHost('resource-del')).toBeNull();
  });
});
