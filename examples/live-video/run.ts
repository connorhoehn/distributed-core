/**
 * run.ts — Live Video Stub Demo
 *
 * This script stress-tests the library's abstractions with a workload that is
 * the opposite of cluster-collab: exclusive room ownership, high-frequency
 * stats, and hard failover where every participant in a room must reconnect
 * when the owning node dies.
 *
 * Phases:
 *   PHASE 1: Start a 3-node cluster, elect a room controller
 *   PHASE 2: Create 10 rooms distributed across nodes
 *   PHASE 3: 50 clients join random rooms
 *   PHASE 4: 5 seconds of simulated streaming at 100 Hz per client
 *   PHASE 5: Kill node-B — rooms reclaimed by survivors
 *   PHASE 6: Verify participants reconnect (allowReconnect: true)
 *   PHASE 7: Summary — rooms, participants, stats, backpressure drops
 *
 * NOT a real SFU. Packets are setTimeout timers. No video is produced.
 * The value is composition testing: do the abstractions hold under load?
 *
 * Run with:
 *   npx ts-node examples/live-video/run.ts
 */

import { EventEmitter } from 'events';
import { PubSubMessageMetadata } from '../../src/gateway/pubsub/types';
import { MembershipEntry } from '../../src/cluster/types';
import { LiveVideoNode, SimplePubSub, SimpleClusterManager } from './LiveVideoNode';

// ---------------------------------------------------------------------------
// Timing helper
// ---------------------------------------------------------------------------

const T0 = Date.now();
function ts(): string {
  return `[+${((Date.now() - T0) / 1000).toFixed(2)}s]`;
}
function log(msg: string): void {
  process.stdout.write(`${ts()} ${msg}\n`);
}
function section(title: string): void {
  process.stdout.write(`\n${'='.repeat(64)}\n--- ${title} ---\n${'='.repeat(64)}\n`);
}
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// In-process SharedBus — same pattern as cluster-collab/run.ts.
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
        bus.subs = bus.subs.filter(s => s.id !== id);
      },
      async publish(topic, payload) {
        if (bus.killed.has(nodeId)) return;
        const meta: PubSubMessageMetadata = {
          publisherNodeId: nodeId,
          messageId: `${nodeId}-${bus.idCounter++}`,
          timestamp: Date.now(),
          topic,
        };
        for (const sub of [...bus.subs]) {
          if (bus.killed.has(sub.nodeId)) continue;
          if (sub.topic === topic) sub.handler(topic, payload, meta);
        }
      },
    };
  }

  kill(nodeId: string): void {
    this.killed.add(nodeId);
    this.subs = this.subs.filter(s => s.nodeId !== nodeId);
  }
}

// ---------------------------------------------------------------------------
// FakeCluster — satisfies SimpleClusterManager without the Transport stack.
// ---------------------------------------------------------------------------

class FakeCluster extends EventEmitter implements SimpleClusterManager {
  private readonly alive: string[];

  constructor(private readonly localNodeId: string, allNodeIds: string[]) {
    super();
    this.alive = [...allNodeIds];
  }

  getMembership(): Map<string, MembershipEntry> {
    const result = new Map<string, MembershipEntry>();
    for (const id of this.alive) {
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

  notifyNodeLeft(deadNodeId: string): void {
    const idx = this.alive.indexOf(deadNodeId);
    if (idx !== -1) this.alive.splice(idx, 1);
    this.emit('member-left', deadNodeId);
  }
}

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------------------------------------------------------------------------
// Main demo
// ---------------------------------------------------------------------------

async function main(): Promise<void> {

  // =========================================================================
  // PHASE 1: Start a 3-node cluster
  // =========================================================================
  section('PHASE 1: STARTUP — 3-node cluster');

  const nodeIds = ['node-A', 'node-B', 'node-C'];
  const bus = new SharedBus();
  const nodes = new Map<string, LiveVideoNode>();
  const clusters = new Map<string, FakeCluster>();

  for (const nodeId of nodeIds) {
    const pubsub = bus.bind(nodeId);
    const cluster = new FakeCluster(nodeId, nodeIds);
    const node = new LiveVideoNode(nodeId, pubsub, cluster);
    nodes.set(nodeId, node);
    clusters.set(nodeId, cluster);
  }

  await Promise.all(Array.from(nodes.values()).map(n => n.start()));

  log('All 3 nodes started. Waiting for leader election to settle...');
  // Leader election has a 3s renewal interval; wait for first cycle.
  await sleep(200);

  let controller = 'none';
  for (const [nid, node] of nodes) {
    if (node.election.isLeader()) {
      controller = nid;
      break;
    }
  }
  log(`Room controller elected: ${controller}`);

  // =========================================================================
  // PHASE 2: Create 10 rooms across the 3 nodes
  //
  // Rooms are created on the local node (LocalPlacement default). We spread
  // them manually — 4 on node-A, 3 on node-B, 3 on node-C — to ensure
  // node-B's failure forces failover of real rooms.
  // =========================================================================
  section('PHASE 2: CREATE 10 ROOMS');

  const roomAssignments: Array<{ roomId: string; ownerNodeId: string }> = [
    { roomId: 'room-01', ownerNodeId: 'node-A' },
    { roomId: 'room-02', ownerNodeId: 'node-A' },
    { roomId: 'room-03', ownerNodeId: 'node-A' },
    { roomId: 'room-04', ownerNodeId: 'node-A' },
    { roomId: 'room-05', ownerNodeId: 'node-B' },
    { roomId: 'room-06', ownerNodeId: 'node-B' },
    { roomId: 'room-07', ownerNodeId: 'node-B' },
    { roomId: 'room-08', ownerNodeId: 'node-C' },
    { roomId: 'room-09', ownerNodeId: 'node-C' },
    { roomId: 'room-10', ownerNodeId: 'node-C' },
  ];

  for (const { roomId, ownerNodeId } of roomAssignments) {
    const node = nodes.get(ownerNodeId)!;
    await node.createRoom(roomId);
    log(`  ${roomId} created on ${ownerNodeId} (transcoder: ${node.transcoderLock.isTranscoding(roomId) ? 'YES' : 'no'})`);
  }

  await sleep(30); // allow entity-sync to propagate

  log('\nRoom distribution after entity-sync:');
  for (const [nid, node] of nodes) {
    log(`  ${nid}: ${node.listLocalRooms().length} local rooms`);
  }

  // =========================================================================
  // PHASE 3: 50 clients join random rooms
  //
  // Each client connects to the node that owns their room. In a real
  // deployment the WebRTC client would connect to whatever node the DNS
  // load balancer sends them to; the SFU assignment is separate from the
  // WebSocket gateway assignment. We keep it simple: client connects directly
  // to the room owner.
  // =========================================================================
  section('PHASE 3: 50 CLIENTS JOIN RANDOM ROOMS');

  interface ClientRecord {
    clientId: string;
    roomId: string;
    ownerNodeId: string;
  }
  const clients: ClientRecord[] = [];

  for (let i = 1; i <= 50; i++) {
    const clientId = `client-${String(i).padStart(3, '0')}`;
    const { roomId, ownerNodeId } = randomChoice(roomAssignments);
    await nodes.get(ownerNodeId)!.joinRoom(roomId, clientId);
    clients.push({ clientId, roomId, ownerNodeId });
  }

  log(`${clients.length} clients joined across ${roomAssignments.length} rooms`);
  for (const [nid, node] of nodes) {
    const stats = node.getStats();
    log(`  ${nid}: ${stats.totalParticipants} participants connected`);
  }

  // =========================================================================
  // PHASE 4: 5 seconds of simulated streaming at 100 Hz per client
  //
  // At 100 Hz with 50 clients that is 5,000 packets/second hitting the
  // BackpressureController queues. We drive them via tight loop + setImmediate
  // rather than 5,000 nested setTimeouts to keep the demo fast.
  //
  // Total target: ~25,000 packets over 5 seconds (5 ticks × 1,000ms ÷ 10ms × 50).
  // In practice we'll emit somewhat fewer due to event-loop scheduling jitter.
  // =========================================================================
  section('PHASE 4: STREAMING (5 seconds, 100 Hz per client)');

  let totalStatsSent = 0;
  const streamEnd = Date.now() + 5_000;

  // Process tick-by-tick so we don't stack up thousands of microtasks.
  while (Date.now() < streamEnd) {
    for (const { clientId, roomId, ownerNodeId } of clients) {
      const node = nodes.get(ownerNodeId);
      if (node === undefined) continue; // node was killed
      node.recordStats(
        roomId,
        clientId,
        randomInt(500, 4000),  // Kbps
        Math.random() * 0.05,  // up to 5% packet loss
      );
      totalStatsSent++;
    }
    // Yield to the event loop every tick so timers and I/O can run.
    await new Promise<void>(resolve => setImmediate(resolve));
    // 10ms between rounds → 100 Hz
    await sleep(10);
  }

  log(`Sent ${totalStatsSent.toLocaleString()} stats packets over 5 seconds`);
  for (const [nid, node] of nodes) {
    const s = node.firehose.getStats();
    log(`  ${nid}: observed=${s.observed.toLocaleString()} dropped=${s.dropped}`);
  }

  // =========================================================================
  // PHASE 5: Kill node-B — hard failure, rooms orphaned
  // =========================================================================
  section('PHASE 5: NODE FAILURE — killing node-B');

  bus.kill('node-B');

  for (const [nid, cluster] of clusters) {
    if (nid === 'node-B') continue;
    cluster.notifyNodeLeft('node-B');
    nodes.get(nid)!.handleNodeLeft('node-B');
  }

  const nodeB = nodes.get('node-B')!;
  const nodeBRooms = nodeB.listLocalRooms().map(r => r.roomId).join(', ');
  log(`node-B killed. It owned: [${nodeBRooms}]`);
  log('Waiting for AutoReclaimPolicy jitter (up to 700ms)...');

  await sleep(700);

  log('\nOwnership after reclaim:');
  for (const [nid, node] of nodes) {
    if (nid === 'node-B') continue;
    const stats = node.getStats();
    log(`  ${nid}: localRooms=${stats.localRooms}  reclaimedRooms=${node['reclaimedRooms']}`);
  }

  // =========================================================================
  // PHASE 6: Verify participants reconnect after failover
  //
  // Clients whose ownerNodeId was node-B now need a new home. We simulate
  // the reconnect: each affected client re-joins on a surviving node. The
  // ConnectionRegistry (allowReconnect:true) absorbs the duplicate clientId
  // without throwing.
  // =========================================================================
  section('PHASE 6: PARTICIPANT RECONNECT after failover');

  const survivorIds = nodeIds.filter(id => id !== 'node-B');
  let reconnectCount = 0;
  let reconnectErrors = 0;

  for (const client of clients) {
    if (client.ownerNodeId !== 'node-B') continue; // only displaced clients
    const survivor = randomChoice(survivorIds);
    try {
      await nodes.get(survivor)!.joinRoom(client.roomId, client.clientId);
      client.ownerNodeId = survivor; // track new home
      reconnectCount++;
    } catch (err) {
      // Room might not be fully reclaimed yet; count as error
      reconnectErrors++;
    }
  }

  log(`Reconnected ${reconnectCount} participants to surviving nodes`);
  if (reconnectErrors > 0) {
    log(`  ${reconnectErrors} reconnect(s) failed (rooms still mid-reclaim)`);
  }

  // =========================================================================
  // PHASE 7: Summary
  // =========================================================================
  section('PHASE 7: FINAL SUMMARY');

  log('Final room locations (authoritative owners):');
  for (const { roomId } of roomAssignments) {
    let ownerNode: LiveVideoNode | undefined;
    for (const [nid, node] of nodes) {
      if (nid === 'node-B') continue;
      if (node.isLocalRoom(roomId)) { ownerNode = node; break; }
    }
    const state = ownerNode?.getRoom(roomId);
    const ownerTag = ownerNode ? ownerNode.nodeId : 'ORPHANED';
    const participants = state ? state.participants.size : '?';
    const transcoder = state?.transcoderLocked ? 'YES' : 'no';
    log(`  ${roomId.padEnd(10)} owner=${ownerTag.padEnd(8)} participants=${String(participants).padStart(2)}  transcoder=${transcoder}`);
  }

  log('\nPer-node stats snapshot:');
  for (const [nid, node] of nodes) {
    if (nid === 'node-B') continue;
    const stats = node.getStats();
    const firehose = node.firehose.getStats();
    log(`  ${nid}:`);
    log(`    localRooms=${stats.localRooms}  participants=${stats.totalParticipants}  controller=${stats.isRoomController}`);
    log(`    statsObserved=${firehose.observed.toLocaleString()}  statsDropped=${firehose.dropped}  transcoderLocks=${stats.transcoderLocksHeld}`);
  }

  const totalObserved = Array.from(nodes.values())
    .filter((_, i) => nodeIds[i] !== 'node-B')
    .reduce((sum, n) => sum + n.firehose.getStats().observed, 0);
  const totalDropped = Array.from(nodes.values())
    .filter((_, i) => nodeIds[i] !== 'node-B')
    .reduce((sum, n) => sum + n.firehose.getStats().dropped, 0);

  log('\nGlobal stats:');
  log(`  Stats packets sent (pre-kill):   ${totalStatsSent.toLocaleString()}`);
  log(`  Stats packets flushed (all nodes): ${totalObserved.toLocaleString()}`);
  log(`  Stats packets dropped (backpressure): ${totalDropped}`);
  log(`  Participant reconnects post-failover: ${reconnectCount}`);

  // =========================================================================
  // TEARDOWN
  // =========================================================================
  section('TEARDOWN');

  // Leave all rooms on surviving nodes before stopping
  for (const { clientId, roomId, ownerNodeId } of clients) {
    if (ownerNodeId === 'node-B') continue;
    await nodes.get(ownerNodeId)?.leaveRoom(roomId, clientId).catch(() => {});
  }

  for (const [nid, node] of nodes) {
    if (nid === 'node-B') continue;
    await node.stop();
    log(`${nid} stopped cleanly`);
  }

  log('\nDemo complete.');
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
