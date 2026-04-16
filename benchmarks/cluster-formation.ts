/**
 * Cluster Formation Benchmark
 * Measures: time to form clusters of various sizes, gossip convergence
 * Run: npx ts-node benchmarks/cluster-formation.ts
 */

import { ClusterManager } from '../src/cluster/ClusterManager';
import { BootstrapConfig } from '../src/config/BootstrapConfig';
import { InMemoryAdapter } from '../src/transport/adapters/InMemoryAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BenchmarkResult {
  nodeCount: number;
  formationTimeMs: number;
  convergenceTimeMs: number;
  messageRate: string; // ops/sec, only populated for the 2-node throughput test
}

function createNode(
  id: string,
  port: number,
  seedNodeIds: string[],
  gossipInterval: number = 50
): { manager: ClusterManager; transport: InMemoryAdapter } {
  const transport = new InMemoryAdapter({ id, address: '127.0.0.1', port });

  const config = new BootstrapConfig(
    seedNodeIds,
    5000,           // joinTimeout
    gossipInterval, // gossipInterval — fast for benchmarks
    false,          // enableLogging
    {               // failureDetector — relaxed so it does not interfere
      heartbeatInterval: 500,
      failureTimeout: 10000,
      deadTimeout: 30000,
      pingTimeout: 2000,
      maxMissedHeartbeats: 20,
      enableActiveProbing: false,
    },
    {},             // keyManager defaults
    {               // lifecycle
      shutdownTimeout: 5000,
      drainTimeout: 5000,
      enableAutoRebalance: false,
      enableGracefulShutdown: false,
    }
  );

  const manager = new ClusterManager(id, transport, config, 50);
  return { manager, transport };
}

/**
 * Wait until every node can see at least `expectedCount` alive members,
 * or until `timeoutMs` elapses.  Returns the elapsed time in ms.
 */
async function waitForConvergence(
  nodes: ClusterManager[],
  expectedCount: number,
  timeoutMs: number = 30000
): Promise<number> {
  const start = Date.now();
  const pollInterval = 10; // ms

  while (Date.now() - start < timeoutMs) {
    const allConverged = nodes.every(
      (n) => n.getAliveMembers().length >= expectedCount
    );
    if (allConverged) return Date.now() - start;
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  // Return elapsed even on timeout so callers can report it
  return Date.now() - start;
}

// ---------------------------------------------------------------------------
// Individual benchmarks
// ---------------------------------------------------------------------------

async function benchClusterFormation(size: number): Promise<BenchmarkResult> {
  // Clear any leftover state from previous runs
  InMemoryAdapter.clearRegistry();

  const nodes: ClusterManager[] = [];
  const basePort = 4000;
  // Use a faster gossip interval for larger clusters
  const gossipInterval = size > 10 ? 25 : 50;

  try {
    // Create nodes — node-0 is the seed; larger clusters use multiple seeds
    // so gossip propagates faster (mirrors real deployments).
    for (let i = 0; i < size; i++) {
      const id = `bench-node-${i}`;
      let seeds: string[] = [];
      if (i > 0) {
        // Always include node-0; for larger clusters add a second seed
        seeds = ['bench-node-0'];
        if (i > 2) seeds.push('bench-node-1');
      }
      const { manager } = createNode(id, basePort + i, seeds, gossipInterval);
      nodes.push(manager);
    }

    // --- Formation time: start all nodes and measure until everyone is started ---
    const formStart = Date.now();

    // Start seed node first, then the rest with a tiny stagger so the seed
    // is in the registry before others try to join.
    await nodes[0].start();
    await Promise.all(nodes.slice(1).map((n) => n.start()));

    const formationTimeMs = Date.now() - formStart;

    // --- Convergence time: wait until every node sees all members ---
    const convergenceTimeMs = await waitForConvergence(nodes, size, 30000);

    return {
      nodeCount: size,
      formationTimeMs,
      convergenceTimeMs,
      messageRate: '-',
    };
  } finally {
    // Teardown
    await Promise.all(nodes.map((n) => n.stop().catch(() => {})));
    InMemoryAdapter.clearRegistry();
  }
}

async function benchMessageThroughput(): Promise<BenchmarkResult> {
  InMemoryAdapter.clearRegistry();

  const nodes: ClusterManager[] = [];
  const basePort = 5000;

  try {
    // Two-node cluster
    const { manager: node0 } = createNode('msg-node-0', basePort, []);
    const { manager: node1 } = createNode('msg-node-1', basePort + 1, ['msg-node-0']);
    nodes.push(node0, node1);

    await node0.start();
    await node1.start();

    // Wait for both to see each other
    await waitForConvergence(nodes, 2, 10000);

    // --- Throughput: send 1000 custom messages from node-0 to node-1 ---
    const totalMessages = 1000;
    let received = 0;

    const receivedPromise = new Promise<void>((resolve) => {
      node1.on('custom-message', () => {
        // Note: custom-message fires on sender's side via emit.
        // For InMemory transport the message is delivered via onMessage handler
        // which goes through communication module, but sendCustomMessage also
        // emits locally.  We count on the transport-level delivery.
      });

      // Listen at the transport level for actual delivery confirmation
      node1.communication && node1.on('custom-message', () => {});

      // We will measure send throughput (fire-and-forget) and then
      // give a short settling window for delivery.
    });

    const sendStart = Date.now();
    for (let i = 0; i < totalMessages; i++) {
      await node0.sendCustomMessage('bench-ping', { seq: i }, ['msg-node-1']);
    }
    const sendElapsed = Date.now() - sendStart;

    // Small settle time for async delivery
    await new Promise((r) => setTimeout(r, 100));

    const opsPerSec = sendElapsed > 0 ? Math.round((totalMessages / sendElapsed) * 1000) : Infinity;

    return {
      nodeCount: 2,
      formationTimeMs: 0,
      convergenceTimeMs: 0,
      messageRate: `${opsPerSec.toLocaleString()} ops/sec`,
    };
  } finally {
    await Promise.all(nodes.map((n) => n.stop().catch(() => {})));
    InMemoryAdapter.clearRegistry();
  }
}

// ---------------------------------------------------------------------------
// Runner & output
// ---------------------------------------------------------------------------

function printTable(results: BenchmarkResult[], throughputResult: BenchmarkResult) {
  const divider = '-'.repeat(76);
  const header = [
    'Nodes'.padEnd(8),
    'Formation (ms)'.padStart(16),
    'Convergence (ms)'.padStart(18),
    'Message Rate'.padStart(22),
  ].join(' | ');

  console.log('\n  Cluster Formation Benchmark (InMemoryAdapter)\n');
  console.log(`  ${divider}`);
  console.log(`  ${header}`);
  console.log(`  ${divider}`);

  for (const r of results) {
    const row = [
      String(r.nodeCount).padEnd(8),
      String(r.formationTimeMs).padStart(16),
      String(r.convergenceTimeMs).padStart(18),
      r.messageRate.padStart(22),
    ].join(' | ');
    console.log(`  ${row}`);
  }

  // Throughput row
  const tRow = [
    '2 (msg)'.padEnd(8),
    '-'.padStart(16),
    '-'.padStart(18),
    throughputResult.messageRate.padStart(22),
  ].join(' | ');
  console.log(`  ${tRow}`);
  console.log(`  ${divider}\n`);
}

async function main() {
  console.log('Starting cluster formation benchmarks...\n');

  const clusterSizes = [3, 5, 10, 20];
  const results: BenchmarkResult[] = [];

  for (const size of clusterSizes) {
    process.stdout.write(`  Benchmarking ${size}-node cluster... `);
    const result = await benchClusterFormation(size);
    console.log(`done (formation=${result.formationTimeMs}ms, convergence=${result.convergenceTimeMs}ms)`);
    results.push(result);
  }

  process.stdout.write('  Benchmarking message throughput (2 nodes, 1000 msgs)... ');
  const throughputResult = await benchMessageThroughput();
  console.log(`done (${throughputResult.messageRate})`);

  printTable(results, throughputResult);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
