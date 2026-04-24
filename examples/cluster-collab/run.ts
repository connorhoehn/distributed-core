/**
 * run.ts — Collaborative Counter Demo
 *
 * This script demonstrates how six distributed-core primitives compose into a
 * working multi-node service. It runs entirely in a single Node.js process using
 * an in-memory PubSub bus (the same pattern as ClusterSimulator in the test suite).
 *
 * What you'll see:
 *   PHASE 1: Three nodes start up, five clients connect
 *   PHASE 2: Each client creates and subscribes to a counter
 *   PHASE 3: Clients apply random updates for a few seconds
 *   PHASE 4: Node B is killed mid-stream
 *   PHASE 5: AutoReclaimPolicy moves Node B's counters to survivors
 *   PHASE 6: Updates keep flowing on the reclaimed counters
 *   PHASE 7: Summary — final state, metrics, event counts
 *
 * Run with:
 *   npx ts-node examples/cluster-collab/run.ts
 */

import { EventEmitter } from 'events';
import { EntityRegistryFactory } from '../../src/cluster/entity/EntityRegistryFactory';
import { EntityRegistrySyncAdapter } from '../../src/cluster/entity/EntityRegistrySyncAdapter';
import { ResourceRouter } from '../../src/routing/ResourceRouter';
import { PubSubMessageMetadata } from '../../src/gateway/pubsub/types';
import { MembershipEntry } from '../../src/cluster/types';
import { CollabNode, SimplePubSub, SimpleClusterManager } from './CollabNode';
import { CounterUpdate } from './types';

// ---------------------------------------------------------------------------
// Timestamp helper — all log lines include elapsed time from script start
// ---------------------------------------------------------------------------

const T0 = Date.now();
function ts(): string {
  const elapsed = ((Date.now() - T0) / 1000).toFixed(2);
  return `[+${elapsed}s]`;
}
function log(msg: string): void {
  process.stdout.write(`${ts()} ${msg}\n`);
}
function section(title: string): void {
  process.stdout.write(`\n${'='.repeat(60)}\n--- ${title} ---\n${'='.repeat(60)}\n`);
}

// ---------------------------------------------------------------------------
// INFRASTRUCTURE: In-process multi-node PubSub bus
//
// Each node gets a "view" onto the shared bus. A node's view only delivers
// messages to/from nodes in its reachable set. When a node is killed, its
// subscriptions are removed and its messages are dropped.
//
// This is a vendored minimal version of the SharedPubSubBus inside ClusterSimulator
// (test/integration/helpers/ClusterSimulator.ts). Vendored here so run.ts has no
// test-directory dependencies and is self-contained.
// ---------------------------------------------------------------------------

interface SubRecord {
  nodeId: string;
  topic: string;
  handler: (topic: string, payload: unknown, meta: PubSubMessageMetadata) => void;
  id: string;
}

class SharedBus {
  private subs: SubRecord[] = [];
  private idCounter = 0;
  private killed = new Set<string>();

  bind(nodeId: string): SimplePubSub {
    const bus = this;
    return {
      subscribe(topic, handler) {
        const id = `${nodeId}-${bus.idCounter++}`;
        bus.subs.push({ nodeId, topic, handler, id });
        return id;
      },
      unsubscribe(id) {
        const i = bus.subs.findIndex(s => s.id === id);
        if (i !== -1) bus.subs.splice(i, 1);
      },
      async publish(topic, payload) {
        if (bus.killed.has(nodeId)) return;
        const meta: PubSubMessageMetadata = {
          publisherNodeId: nodeId,
          messageId: `${nodeId}-${bus.idCounter++}`,
          timestamp: Date.now(),
          topic,
        };
        // Deliver to all alive subscribers on this topic
        for (const sub of [...bus.subs]) {
          if (bus.killed.has(sub.nodeId)) continue;
          if (sub.topic === topic) sub.handler(topic, payload, meta);
        }
      },
    };
  }

  kill(nodeId: string): void {
    this.killed.add(nodeId);
    // Drop all subscriptions for the killed node immediately
    this.subs = this.subs.filter(s => s.nodeId !== nodeId);
  }
}

// ---------------------------------------------------------------------------
// INFRASTRUCTURE: Fake ClusterManager
//
// ResourceRouter needs a ClusterManager to enumerate alive nodes (for placement
// decisions and getAliveNodeIds). This fake satisfies that interface.
// ---------------------------------------------------------------------------

class FakeCluster extends EventEmitter implements SimpleClusterManager {
  readonly localNodeId: string;
  private readonly alive: Map<string, string[]>;  // nodeId -> [all alive nodeIds]
  private readonly allNodeIds: string[];

  constructor(localNodeId: string, allNodeIds: string[]) {
    super();
    this.localNodeId = localNodeId;
    this.allNodeIds = [...allNodeIds];
    this.alive = new Map();
    for (const id of allNodeIds) {
      this.alive.set(id, [...allNodeIds]);
    }
  }

  getMembership(): Map<string, MembershipEntry> {
    const result = new Map<string, MembershipEntry>();
    for (const id of this.allNodeIds) {
      result.set(id, {
        id,
        status: 'ALIVE',
        lastSeen: Date.now(),
        version: 1,
        lastUpdated: Date.now(),
        metadata: { address: '127.0.0.1', port: 7000 },
      } as MembershipEntry);
    }
    return result;
  }

  /** Called externally when we want to simulate a node leaving. */
  notifyNodeLeft(deadNodeId: string): void {
    const idx = this.allNodeIds.indexOf(deadNodeId);
    if (idx !== -1) this.allNodeIds.splice(idx, 1);
    this.emit('member-left', deadNodeId);
  }
}

// ---------------------------------------------------------------------------
// MULTI-NODE SETUP HELPER
// ---------------------------------------------------------------------------

async function buildCluster(nodeIds: string[]): Promise<{
  bus: SharedBus;
  nodes: Map<string, CollabNode>;
  clusters: Map<string, FakeCluster>;
}> {
  const bus = new SharedBus();
  const nodes = new Map<string, CollabNode>();
  const clusters = new Map<string, FakeCluster>();

  for (const nodeId of nodeIds) {
    const pubsub = bus.bind(nodeId);
    const cluster = new FakeCluster(nodeId, nodeIds);
    const node = new CollabNode(nodeId, pubsub, cluster);
    nodes.set(nodeId, node);
    clusters.set(nodeId, cluster);
  }

  // Start all nodes in parallel
  await Promise.all(Array.from(nodes.values()).map(n => n.start()));
  return { bus, nodes, clusters };
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomUpdate(clientId: string): CounterUpdate {
  const r = Math.random();
  if (r < 0.6) return { kind: 'inc', by: Math.ceil(Math.random() * 5), clientId };
  if (r < 0.9) return { kind: 'dec', by: 1, clientId };
  return { kind: 'reset', clientId };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// MAIN DEMO
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // =========================================================================
  // PHASE 1: Start a 3-node cluster
  // =========================================================================
  section('PHASE 1: STARTUP — 3-node cluster');

  const nodeIds = ['node-A', 'node-B', 'node-C'];
  const { bus, nodes, clusters } = await buildCluster(nodeIds);

  for (const nodeId of nodeIds) {
    log(`Node ${nodeId} started. Registry + Sync + Router + Session + StateMgr + AutoReclaim ready.`);
  }

  // Give the sync adapters a tick to settle after startup
  await sleep(20);

  // =========================================================================
  // PHASE 2: Connect 5 clients and create counters
  //
  // We spread clients across nodes to simulate multiple load-balanced gateway
  // instances. Each client creates one counter — so 5 counters total, spread
  // across 3 nodes by the default LocalPlacement strategy.
  // =========================================================================
  section('PHASE 2: CLIENT CONNECT + COUNTER CREATION');

  // Client→Node assignment (which gateway node the client connected to)
  const clientAssignments: Array<{ clientId: string; homeNode: string; counterId: string }> = [
    { clientId: 'alice',   homeNode: 'node-A', counterId: 'counter-alpha' },
    { clientId: 'bob',     homeNode: 'node-B', counterId: 'counter-beta' },
    { clientId: 'carol',   homeNode: 'node-B', counterId: 'counter-gamma' },
    { clientId: 'dave',    homeNode: 'node-C', counterId: 'counter-delta' },
    { clientId: 'eve',     homeNode: 'node-A', counterId: 'counter-epsilon' },
  ];

  for (const { clientId, homeNode, counterId } of clientAssignments) {
    const node = nodes.get(homeNode)!;
    await node.clientJoin(clientId);
    const initialState = await node.subscribeToCounter(clientId, counterId);
    log(`  ${clientId} joined ${homeNode}, subscribed to ${counterId} (initial count: ${initialState.count})`);
  }

  // Give EntityRegistrySyncAdapter time to propagate ownership to all nodes
  await sleep(30);

  log('Counter ownership after propagation:');
  for (const [nodeId, node] of nodes) {
    const stats = node.getStats();
    log(`  ${nodeId}: ${stats.localCounters} local counters, ${stats.connectedClients} clients`);
  }

  // =========================================================================
  // PHASE 3: Random updates for 2 seconds
  //
  // Each client applies 1 update per 200ms. Updates go to the node that owns
  // the counter (applyCounterUpdate throws if the counter isn't local, so we
  // find the owning node first).
  // =========================================================================
  section('PHASE 3: UPDATES FLOWING (2 seconds)');

  let phase3Updates = 0;
  const phase3End = Date.now() + 2000;

  while (Date.now() < phase3End) {
    for (const { clientId, counterId } of clientAssignments) {
      // Find which node currently owns this counter
      let ownerNode: CollabNode | undefined;
      for (const node of nodes.values()) {
        if (node.isLocalCounter(counterId)) {
          ownerNode = node;
          break;
        }
      }

      if (ownerNode === undefined) {
        // Counter not yet placed; skip this tick
        continue;
      }

      const update = randomUpdate(clientId);
      try {
        await ownerNode.applyCounterUpdate(counterId, update);
        phase3Updates++;
      } catch {
        // Counter was mid-reclaim; ignore and retry next tick
      }
    }
    await sleep(100);
  }

  log(`Applied ${phase3Updates} updates across all counters`);

  // Show mid-run state
  for (const { counterId, homeNode } of clientAssignments) {
    const node = nodes.get(homeNode)!;
    // Read from any node — home node may be a follower
    for (const n of nodes.values()) {
      const state = n.getCounter(counterId);
      if (state !== null && n.isLocalCounter(counterId)) {
        log(`  ${counterId} (owner: ${n.nodeId}) count=${state.count} modifiedBy=${state.modifiedBy}`);
        break;
      }
    }
  }

  // =========================================================================
  // PHASE 4: Kill node-B
  //
  // We simulate a hard failure: the shared bus drops node-B's subscriptions,
  // and we notify surviving nodes via the FakeCluster's member-left event.
  // FailureDetectorBridge is NOT used here (it requires the full Transport stack).
  // Instead, we call router.handleNodeLeft() directly — which is what
  // FailureDetectorBridge would call in production.
  // =========================================================================
  section('PHASE 4: NODE FAILURE — killing node-B');

  bus.kill('node-B');

  // Notify surviving nodes that node-B has left
  for (const [nodeId, cluster] of clusters) {
    if (nodeId === 'node-B') continue;
    cluster.notifyNodeLeft('node-B');
    // Also tell the ResourceRouter directly — in production FailureDetectorBridge does this
    const node = nodes.get(nodeId)!;
    node.router.handleNodeLeft('node-B');
  }

  const nodeB = nodes.get('node-B')!;
  log(`node-B killed. It owned: ${nodeB.session.getLocalSessions().map(s => s.sessionId).join(', ') || 'nothing'}`);

  // =========================================================================
  // PHASE 5: AutoReclaimPolicy kicks in
  //
  // After handleNodeLeft(), ResourceRouter emits resource:orphaned for each
  // resource node-B owned. AutoReclaimPolicy on node-A and node-C each hear
  // this, apply their placement strategy, and one of them claims the counter
  // after a short jitter delay.
  // =========================================================================
  section('PHASE 5: AUTO-RECLAIM (waiting up to 1s for jitter to settle)');

  // Wait for reclaim jitter (up to 300ms) plus sync propagation
  await sleep(600);

  log('Ownership after reclaim:');
  for (const [nodeId, node] of nodes) {
    if (nodeId === 'node-B') continue;
    const stats = node.getStats();
    log(`  ${nodeId}: localCounters=${stats.localCounters}  reclaimedCounters=${stats.reclaimedCounters}`);
  }

  // =========================================================================
  // PHASE 6: Updates keep flowing on reclaimed counters
  //
  // We re-run updates to demonstrate that node-B's counters are still alive
  // on whichever node reclaimed them.
  // =========================================================================
  section('PHASE 6: UPDATES POST-FAILURE (1 more second)');

  let phase6Updates = 0;
  const phase6End = Date.now() + 1000;

  while (Date.now() < phase6End) {
    for (const { clientId, counterId } of clientAssignments) {
      // Find the (possibly new) owner
      let ownerNode: CollabNode | undefined;
      for (const [nodeId, node] of nodes) {
        if (nodeId === 'node-B') continue;
        if (node.isLocalCounter(counterId)) {
          ownerNode = node;
          break;
        }
      }
      if (ownerNode === undefined) continue;

      try {
        await ownerNode.applyCounterUpdate(counterId, randomUpdate(clientId));
        phase6Updates++;
      } catch {
        // Reclaim still in flight; skip
      }
    }
    await sleep(100);
  }

  log(`Applied ${phase6Updates} additional updates after node-B failure`);

  // =========================================================================
  // PHASE 7: Summary
  // =========================================================================
  section('PHASE 7: FINAL SUMMARY');

  log('Final counter values:');
  for (const { counterId } of clientAssignments) {
    let found = false;
    for (const [nodeId, node] of nodes) {
      if (nodeId === 'node-B') continue;
      // Check local session (authoritative) first
      const localState = node.getCounter(counterId);
      if (localState !== null && node.isLocalCounter(counterId)) {
        log(`  ${counterId.padEnd(20)} count=${String(localState.count).padStart(4)}  owner=${nodeId}  modifiedBy=${localState.modifiedBy}`);
        found = true;
        break;
      }
    }
    if (!found) {
      // Fall back to any node's snapshot (follower state or recently reclaimed)
      for (const [nodeId, node] of nodes) {
        if (nodeId === 'node-B') continue;
        const snap = node.getCounter(counterId);
        if (snap !== null) {
          log(`  ${counterId.padEnd(20)} count=${String(snap.count).padStart(4)}  (last seen on ${nodeId})  modifiedBy=${snap.modifiedBy}`);
          found = true;
          break;
        }
      }
    }
    if (!found) {
      log(`  ${counterId.padEnd(20)} NOT FOUND (counter not yet reclaimed or evicted)`);
    }
  }

  log('\nPer-node metrics snapshot:');
  for (const [nodeId, node] of nodes) {
    if (nodeId === 'node-B') continue;
    const stats = node.getStats();
    const mSnap = node.metrics.getSnapshot();
    log(`  ${nodeId}:`);
    log(`    localCounters=${stats.localCounters}  reclaimedCounters=${stats.reclaimedCounters}  updatesApplied=${stats.totalUpdatesApplied}`);
    log(`    connectedClients=${stats.connectedClients}`);

    // Print key metrics from MetricsRegistry (all samples are in mSnap.metrics)
    const claimCount = mSnap.metrics.find(m => m.name === 'resource.claim.count');
    const sessionEvicted = mSnap.metrics.find(m => m.name === 'session.evicted.count');
    if (claimCount) log(`    resource.claim.count=${claimCount.value}`);
    if (sessionEvicted) log(`    session.evicted.count=${sessionEvicted.value}`);
  }

  log('\nTotal updates:');
  log(`  Phase 3 (before failure): ${phase3Updates}`);
  log(`  Phase 6 (after failure):  ${phase6Updates}`);
  log(`  Grand total:              ${phase3Updates + phase6Updates}`);

  // =========================================================================
  // TEARDOWN
  // =========================================================================
  section('TEARDOWN');

  // Disconnect all clients from surviving nodes before stopping
  for (const { clientId, homeNode } of clientAssignments) {
    if (homeNode === 'node-B') continue;
    const node = nodes.get(homeNode);
    if (node) {
      await node.clientLeave(clientId).catch(() => {/* already gone */});
    }
  }

  for (const [nodeId, node] of nodes) {
    if (nodeId === 'node-B') continue; // already dead
    await node.stop();
    log(`${nodeId} stopped cleanly`);
  }

  log('\nDemo complete.');
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
