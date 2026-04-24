/**
 * benchmarks/resourceRouter.bench.ts
 *
 * Benchmarks ResourceRouter claim / route / release throughput using an
 * InMemoryEntityRegistry and a minimal ClusterManager stub.
 *
 * Run directly:  npx ts-node benchmarks/resourceRouter.bench.ts [--iterations N]
 */

import { EventEmitter } from 'events';
import { ResourceRouter } from '../src/routing/ResourceRouter';
import { InMemoryEntityRegistry } from '../src/cluster/entity/InMemoryEntityRegistry';
import { bench, printHeader, printResult, printSeparator, parseIterations } from './harness';

// ---------------------------------------------------------------------------
// Minimal ClusterManager stub — only the methods ResourceRouter actually calls
// ---------------------------------------------------------------------------
class StubCluster extends EventEmitter {
  private readonly _membership: Map<string, { id: string; status: string; metadata?: Record<string, unknown> }>;

  constructor(aliveNodeIds: string[]) {
    super();
    this._membership = new Map(
      aliveNodeIds.map((id) => [id, { id, status: 'ALIVE', metadata: { address: '127.0.0.1', port: 9000 } }]),
    );
  }

  getMembership(): Map<string, { id: string; status: string; metadata?: Record<string, unknown> }> {
    return this._membership;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const iterations = parseIterations(100_000);
  const nodeId = 'bench-node-1';

  console.log('\n=== ResourceRouter Benchmarks ===');
  printHeader();

  // --- claim() ---
  {
    let resourceCounter = 0;
    const registry = new InMemoryEntityRegistry(nodeId, { enableTestMode: true });
    const cluster = new StubCluster([nodeId]);
    const router = new ResourceRouter(nodeId, registry as any, cluster as any);
    await router.start();

    const result = await bench(
      'ResourceRouter.claim()',
      async () => {
        const id = `r-${resourceCounter++}`;
        await router.claim(id);
      },
      { warmup: 500, iterations },
    );
    printResult(result);
    await router.stop();
  }

  // --- route() local hit ---
  {
    const registry = new InMemoryEntityRegistry(nodeId, { enableTestMode: true });
    const cluster = new StubCluster([nodeId]);
    const router = new ResourceRouter(nodeId, registry as any, cluster as any);
    await router.start();

    // Pre-claim a single resource to route to
    await router.claim('bench-resource');

    const result = await bench(
      'ResourceRouter.route() [local hit]',
      async () => {
        await router.route('bench-resource');
      },
      { warmup: 1_000, iterations },
    );
    printResult(result);
    await router.stop();
  }

  // --- route() miss ---
  {
    const registry = new InMemoryEntityRegistry(nodeId, { enableTestMode: true });
    const cluster = new StubCluster([nodeId]);
    const router = new ResourceRouter(nodeId, registry as any, cluster as any);
    await router.start();

    const result = await bench(
      'ResourceRouter.route() [miss]',
      async () => {
        await router.route('no-such-resource');
      },
      { warmup: 1_000, iterations },
    );
    printResult(result);
    await router.stop();
  }

  // --- claim + release cycle ---
  {
    let counter = 0;
    const registry = new InMemoryEntityRegistry(nodeId, { enableTestMode: true });
    const cluster = new StubCluster([nodeId]);
    const router = new ResourceRouter(nodeId, registry as any, cluster as any);
    await router.start();

    const result = await bench(
      'ResourceRouter claim+release cycle',
      async () => {
        const id = `rr-${counter++}`;
        await router.claim(id);
        await router.release(id);
      },
      { warmup: 500, iterations: Math.min(iterations, 50_000) },
    );
    printResult(result);
    await router.stop();
  }

  printSeparator();
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export { main };
