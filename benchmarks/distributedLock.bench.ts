/**
 * benchmarks/distributedLock.bench.ts
 *
 * Benchmarks DistributedLock tryAcquire + release cycle, both uncontended
 * (single node, fresh registry) and 2-node contention (two locks contend
 * on the same key — one wins, one retries via a separate key to avoid
 * measuring retry-sleep overhead in the throughput number).
 *
 * Run directly:  npx ts-node benchmarks/distributedLock.bench.ts [--iterations N]
 */

import { DistributedLock } from '../src/cluster/locks/DistributedLock';
import { InMemoryEntityRegistry } from '../src/cluster/entity/InMemoryEntityRegistry';
import { bench, printHeader, printResult, printSeparator, parseIterations } from './harness';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const iterations = parseIterations(10_000);

  console.log('\n=== DistributedLock Benchmarks ===');
  printHeader();

  // --- uncontended tryAcquire + release ---
  {
    const registry = new InMemoryEntityRegistry('node-a', { enableTestMode: true });
    await registry.start();
    const lock = new DistributedLock(registry as any, 'node-a', {
      defaultTtlMs: 60_000,
    });

    let counter = 0;

    const result = await bench(
      'DistributedLock tryAcquire+release [uncontended]',
      async () => {
        const lockId = `bench-lock-${counter++}`;
        const handle = await lock.tryAcquire(lockId, { ttlMs: 60_000 });
        if (handle) await lock.release(handle);
      },
      { warmup: 200, iterations },
    );
    printResult(result);
    await registry.stop();
  }

  // --- re-acquire same key (previous release + new acquire) ---
  // Uses a single slot that is acquired and released in sequence.
  {
    const registry = new InMemoryEntityRegistry('node-b', { enableTestMode: true });
    await registry.start();
    const lock = new DistributedLock(registry as any, 'node-b', {
      defaultTtlMs: 60_000,
    });

    const LOCK_ID = 'shared-bench-lock';
    // Acquire once to warm up the key
    const warmHandle = await lock.tryAcquire(LOCK_ID, { ttlMs: 60_000 });
    if (warmHandle) await lock.release(warmHandle);

    const result = await bench(
      'DistributedLock tryAcquire+release [single key, sequential]',
      async () => {
        const handle = await lock.tryAcquire(LOCK_ID, { ttlMs: 60_000 });
        if (handle) await lock.release(handle);
      },
      { warmup: 200, iterations },
    );
    printResult(result);
    await registry.stop();
  }

  // --- 2-node contention simulation ---
  // Two DistributedLock instances share an InMemoryEntityRegistry (simulating
  // shared distributed state). They compete on the same key in sequence;
  // the loser immediately sees a null handle (no retry sleep) so we measure
  // the overhead of the contended path, not the retry backoff.
  {
    const registry = new InMemoryEntityRegistry('node-c', { enableTestMode: true });
    await registry.start();

    const lockA = new DistributedLock(registry as any, 'node-c', { defaultTtlMs: 60_000 });
    const lockB = new DistributedLock(registry as any, 'node-d', { defaultTtlMs: 60_000 });

    const CONTENDED_KEY = 'contended-lock';
    let toggle = true;

    const result = await bench(
      'DistributedLock tryAcquire [2-node contention]',
      async () => {
        // Alternate which node acquires so both paths are measured
        const winner = toggle ? lockA : lockB;
        const loser  = toggle ? lockB : lockA;
        toggle = !toggle;

        const handle = await winner.tryAcquire(CONTENDED_KEY, { ttlMs: 60_000 });
        // Measure contended attempt on loser (should return null)
        await loser.tryAcquire(CONTENDED_KEY, { ttlMs: 60_000 });
        if (handle) await winner.release(handle);
      },
      { warmup: 200, iterations: Math.min(iterations, 10_000) },
    );
    printResult(result);
    await registry.stop();
  }

  printSeparator();
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export { main };
