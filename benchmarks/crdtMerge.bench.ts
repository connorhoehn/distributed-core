/**
 * benchmarks/crdtMerge.bench.ts
 *
 * Throughput of CrdtEntityRegistry.applyRemoteUpdate() at varying registry
 * populations. Pre-fills the registry with K live entities, then drives J
 * remote merges (mix of UPDATE and CREATE for unseen ids) and reports
 * ops/sec at each K.
 *
 * Run directly:  npx tsx benchmarks/crdtMerge.bench.ts [--iterations N]
 *
 * Notes:
 *   - Uses the registry's default-args constructor (tombstoneTTLMs = Infinity)
 *     so we are insulated from the in-flight tombstone-TTL change in
 *     CrdtEntityRegistry.
 */

import { CrdtEntityRegistry } from '../src/cluster/entity/CrdtEntityRegistry';
import { EntityUpdate } from '../src/persistence/wal/types';
import {
  bench,
  printHeader,
  printResult,
  printSeparator,
  parseIterations,
} from './harness';

const REMOTE_NODE = 'node-remote';

async function preloadRegistry(
  registry: CrdtEntityRegistry,
  count: number,
): Promise<void> {
  // Seed via remote CREATE updates rather than proposeEntity() so the records
  // are owned by REMOTE_NODE — keeping subsequent UPDATE merges valid (the
  // registry's local mutation API would otherwise reject foreign ownership).
  for (let i = 0; i < count; i++) {
    const update: EntityUpdate = {
      entityId: `entity-${i}`,
      ownerNodeId: REMOTE_NODE,
      version: i + 1,
      timestamp: Date.now(),
      operation: 'CREATE',
      metadata: { seed: true },
    };
    await registry.applyRemoteUpdate(update);
  }
}

async function runMergeBench(k: number, j: number): Promise<void> {
  const registry = new CrdtEntityRegistry('node-local');
  await registry.start();

  await preloadRegistry(registry, k);

  // Pre-build the J updates so we don't measure object allocation.
  // Use ascending versions so each one strictly wins LWW.
  const updates: EntityUpdate[] = new Array(j);
  let nextVersion = k + 1;
  for (let i = 0; i < j; i++) {
    // 80% UPDATE existing entity, 20% CREATE new entity
    if (k > 0 && i % 5 !== 0) {
      const target = i % k;
      updates[i] = {
        entityId: `entity-${target}`,
        ownerNodeId: REMOTE_NODE,
        version: nextVersion++,
        timestamp: Date.now(),
        operation: 'UPDATE',
        metadata: { tick: i },
      };
    } else {
      updates[i] = {
        entityId: `entity-new-${i}`,
        ownerNodeId: REMOTE_NODE,
        version: nextVersion++,
        timestamp: Date.now(),
        operation: 'CREATE',
        metadata: { tick: i },
      };
    }
  }

  let cursor = 0;
  const result = await bench(
    `CrdtEntityRegistry.applyRemoteUpdate (K=${k.toLocaleString()})`,
    async () => {
      // Cycle through the prebuilt update list. We measure the merge cost,
      // accepting that some updates after wraparound are lower-version (they
      // become no-ops via LWW); this still exercises the full code path.
      const u = updates[cursor++ % j];
      await registry.applyRemoteUpdate(u);
    },
    { warmup: 1_000, iterations: j },
  );
  printResult(result);

  await registry.stop();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // J = number of merges to time per K size. Override via --iterations.
  const j = parseIterations(20_000);

  console.log('\n=== CRDT Merge Benchmarks ===');
  console.log(`(applyRemoteUpdate, ${j} merges per scenario)`);
  printHeader();

  for (const k of [100, 1_000, 10_000]) {
    await runMergeBench(k, j);
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
