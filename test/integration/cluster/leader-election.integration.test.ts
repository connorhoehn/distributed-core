/**
 * leader-election.integration.test.ts
 *
 * Tests ClusterLeaderElection with a 5-node cluster where each node has its
 * own EntityRegistry connected via a shared in-memory PubSub bus (via the
 * EntityRegistrySyncAdapter). Uses real timers with short lease/renew durations.
 *
 * Scenarios:
 *  - Exactly one leader among 5 nodes
 *  - Kill the leader; a new one is elected within leaseDurationMs
 *  - Non-leader can getLeaderRoute() and see the correct leader address
 */

import { EventEmitter } from 'events';
import { ClusterSimulator } from '../helpers/ClusterSimulator';
import { EntityRegistryFactory } from '../../../src/cluster/entity/EntityRegistryFactory';
import { ResourceRouter } from '../../../src/routing/ResourceRouter';
import { DistributedLock } from '../../../src/cluster/locks/DistributedLock';
import { ClusterLeaderElection } from '../../../src/cluster/locks/ClusterLeaderElection';
import { MembershipEntry } from '../../../src/cluster/types';

jest.setTimeout(15000);

// Short timings to keep the test fast
const LEASE_MS = 400;
const RENEW_MS = 100;

describe('ClusterLeaderElection — multi-node integration', () => {
  let sim: ClusterSimulator;
  let elections: ClusterLeaderElection[];

  beforeEach(() => {
    sim = new ClusterSimulator([
      { nodeId: 'n1', address: '10.0.0.1', port: 7001 },
      { nodeId: 'n2', address: '10.0.0.2', port: 7002 },
      { nodeId: 'n3', address: '10.0.0.3', port: 7003 },
      { nodeId: 'n4', address: '10.0.0.4', port: 7004 },
      { nodeId: 'n5', address: '10.0.0.5', port: 7005 },
    ]);
    elections = [];
  });

  afterEach(async () => {
    for (const election of elections) {
      try { await election.stop(); } catch { /* ignore */ }
    }
    await sim.stopAll();
  });

  function makeElectionForNode(nodeId: string): ClusterLeaderElection {
    const node = sim.node(nodeId);
    // Each node uses its OWN registry for the lock (sync adapter keeps them in sync)
    const lock = new DistributedLock(node.registry, nodeId, {
      defaultTtlMs: LEASE_MS,
      acquireTimeoutMs: 200,
      retryIntervalMs: 20,
    });

    // The router for the election also uses the same shared registry
    const election = new ClusterLeaderElection(
      'group-x',
      nodeId,
      lock,
      node.router,
      { leaseDurationMs: LEASE_MS, renewIntervalMs: RENEW_MS }
    );
    return election;
  }

  it('exactly one node becomes leader among 5 nodes', async () => {
    await sim.startAll();

    // Start all elections
    for (const node of sim.nodes()) {
      const election = makeElectionForNode(node.nodeId);
      elections.push(election);
      await election.start();
    }

    // Let elections settle
    await sim.settle(200);

    const leaders = elections.filter((e) => e.isLeader());
    expect(leaders).toHaveLength(1);
  });

  it('after killing the leader, a new leader is elected within leaseDurationMs + renewIntervalMs', async () => {
    await sim.startAll();

    for (const node of sim.nodes()) {
      const election = makeElectionForNode(node.nodeId);
      elections.push(election);
      await election.start();
    }

    await sim.settle(200);

    // Find the current leader
    const leaderIdx = elections.findIndex((e) => e.isLeader());
    expect(leaderIdx).toBeGreaterThanOrEqual(0);
    const leaderNodeId = sim.nodes()[leaderIdx].nodeId;

    // Kill the leader node
    await sim.killNode(leaderNodeId);

    // Remove the killed election from tracking (it's dead)
    const killedElection = elections[leaderIdx];
    try { await killedElection.stop(); } catch { /* ignore */ }
    elections.splice(leaderIdx, 1);

    // Simulate what FailureDetectorBridge would do: remove the orphaned lock entity
    // from all surviving nodes' registries so they can re-acquire the leader lock.
    // In production this is handled by FailureDetectorBridge + AutoReclaimPolicy.
    const lockEntityId = `election:group-x`;
    for (const survivingNode of sim.nodes()) {
      const entity = survivingNode.registry.getEntity(lockEntityId);
      if (entity !== null && entity.ownerNodeId === leaderNodeId) {
        await survivingNode.registry.applyRemoteUpdate({
          entityId: lockEntityId,
          ownerNodeId: leaderNodeId,
          version: entity.version + 1000,
          timestamp: Date.now(),
          operation: 'DELETE',
          metadata: {},
        });
      }
    }

    // Wait for the renew cycle to pick up the free slot
    await sim.settle(RENEW_MS * 3 + 200);

    const newLeaders = elections.filter((e) => e.isLeader());
    expect(newLeaders).toHaveLength(1);
    expect(newLeaders[0]).not.toBe(killedElection);
  });

  it('non-leader can getLeaderRoute() and get the leader node address', async () => {
    await sim.startAll();

    for (const node of sim.nodes()) {
      const election = makeElectionForNode(node.nodeId);
      elections.push(election);
      await election.start();
    }

    await sim.settle(200);

    const leaderIdx = elections.findIndex((e) => e.isLeader());
    expect(leaderIdx).toBeGreaterThanOrEqual(0);

    // Pick a non-leader
    const nonLeaderIdx = elections.findIndex((_, i) => i !== leaderIdx);
    const nonLeader = elections[nonLeaderIdx];

    // getLeaderRoute() on a non-leader should return the leader's route
    const route = await nonLeader.getLeaderRoute();
    expect(route).not.toBeNull();
    expect(route!.isLocal).toBe(false);
    expect(route!.nodeId).toBe(sim.nodes()[leaderIdx].nodeId);
  });

  it('getLeaderId() returns the leader nodeId on the leader and null on others', async () => {
    await sim.startAll();

    for (const node of sim.nodes()) {
      const election = makeElectionForNode(node.nodeId);
      elections.push(election);
      await election.start();
    }

    await sim.settle(200);

    const leaderElection = elections.find((e) => e.isLeader());
    expect(leaderElection).toBeDefined();
    expect(leaderElection!.getLeaderId()).not.toBeNull();

    const nonLeaders = elections.filter((e) => !e.isLeader());
    for (const nl of nonLeaders) {
      // Non-leaders don't know their own nodeId is leader
      expect(nl.getLeaderId()).toBeNull();
    }
  });
});
