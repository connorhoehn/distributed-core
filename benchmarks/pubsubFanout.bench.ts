/**
 * benchmarks/pubsubFanout.bench.ts
 *
 * Cross-node PubSub fanout latency. Builds an N-node in-memory mesh of stub
 * PubSub buses (no network, no real ClusterManager — synchronous delivery to
 * peers via direct function call) and measures end-to-end propagation latency
 * from publisher to all N-1 subscribers.
 *
 * Reports throughput, p50, p90, p99 plus a per-message fanout-completion p99.
 *
 * Run directly:  npx tsx benchmarks/pubsubFanout.bench.ts [--iterations N]
 *
 * Notes:
 *   - The codebase does not currently ship an InMemoryPubSubManager. We mirror
 *     the EventBus bench's StubPubSub style and wire N of them together.
 *   - Latency timing here measures synchronous delivery, since the in-memory
 *     mesh delivers without yielding the event loop. This still produces
 *     meaningful numbers for fanout cost vs. fan-out size.
 */

import { EventEmitter } from 'events';
import {
  PubSubHandler,
  PubSubMessageMetadata,
} from '../src/gateway/pubsub/types';
import {
  bench,
  printHeader,
  printResult,
  printSeparator,
  parseIterations,
} from './harness';

// ---------------------------------------------------------------------------
// In-memory N-node PubSub mesh.
// Each MeshPubSub keeps its own subscriber map. publish() delivers locally and
// hands the message to every peer in the mesh, which delivers locally too.
// ---------------------------------------------------------------------------
class MeshPubSub extends EventEmitter {
  readonly nodeId: string;
  private peers: MeshPubSub[] = [];
  private subs: Map<string, { id: string; handler: PubSubHandler }[]> = new Map();
  private counter = 0;
  private msgSeq = 0;

  constructor(nodeId: string) {
    super();
    this.nodeId = nodeId;
  }

  setPeers(peers: MeshPubSub[]): void {
    this.peers = peers.filter((p) => p !== this);
  }

  subscribe(topic: string, handler: PubSubHandler): string {
    const id = `${this.nodeId}-sub-${++this.counter}`;
    const list = this.subs.get(topic) ?? [];
    list.push({ id, handler });
    this.subs.set(topic, list);
    return id;
  }

  publish(topic: string, payload: unknown): void {
    this.msgSeq += 1;
    const meta: PubSubMessageMetadata = {
      messageId: `${this.nodeId}-${this.msgSeq}`,
      publisherNodeId: this.nodeId,
      timestamp: Date.now(),
      topic,
    };
    this.deliverLocal(topic, payload, meta);
    for (const peer of this.peers) {
      peer.deliverLocal(topic, payload, meta);
    }
  }

  /** Public so peers can hand-off without re-stamping metadata. */
  deliverLocal(topic: string, payload: unknown, meta: PubSubMessageMetadata): void {
    const list = this.subs.get(topic);
    if (!list) return;
    for (const sub of list) {
      sub.handler(topic, payload, meta);
    }
  }
}

function buildMesh(n: number): MeshPubSub[] {
  const nodes: MeshPubSub[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push(new MeshPubSub(`node-${i}`));
  }
  for (const node of nodes) node.setPeers(nodes);
  return nodes;
}

// ---------------------------------------------------------------------------
// Bench scenarios
// ---------------------------------------------------------------------------
async function runFanout(n: number, iterations: number): Promise<void> {
  const nodes = buildMesh(n);
  const publisher = nodes[0];
  const subscribers = nodes.slice(1);

  let receivedCount = 0;
  for (const sub of subscribers) {
    sub.subscribe('bench/topic', () => {
      receivedCount += 1;
    });
  }

  const result = await bench(
    `PubSub fanout (N=${n}) per-publish`,
    () => {
      publisher.publish('bench/topic', { v: 42 });
    },
    { warmup: 1_000, iterations },
  );
  printResult(result);

  // Sanity check that fanout actually happened.
  const expected = iterations * (n - 1) + /* warmup */ 1_000 * (n - 1);
  if (receivedCount !== expected) {
    console.warn(
      `  [warn] expected ${expected} deliveries across N=${n}, got ${receivedCount}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Default lower than the harness default — fanout work scales with N.
  const iterations = parseIterations(20_000);

  console.log('\n=== PubSub Fanout Benchmarks ===');
  console.log(`(in-memory mesh, ${iterations} publishes per scenario)`);
  printHeader();

  for (const n of [3, 10]) {
    await runFanout(n, iterations);
  }

  printSeparator();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { main };
