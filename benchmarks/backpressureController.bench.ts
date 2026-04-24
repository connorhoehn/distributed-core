/**
 * benchmarks/backpressureController.bench.ts
 *
 * Benchmarks BackpressureController.enqueue() throughput at three queue depths:
 *   - low   (queue size 1 000, testing the happy path)
 *   - medium (queue size 100, forces occasional drop-oldest evictions)
 *   - high  (queue size 1, maximally contended — every enqueue evicts)
 *
 * Run directly:  npx ts-node benchmarks/backpressureController.bench.ts [--iterations N]
 */

import { BackpressureController } from '../src/gateway/backpressure/BackpressureController';
import { bench, printHeader, printResult, printSeparator, parseIterations } from './harness';

// Flush handler is a no-op — we measure enqueue throughput, not flush I/O.
const NOOP_FLUSH = async (_key: string, _items: unknown[]): Promise<void> => {};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const iterations = parseIterations(100_000);

  console.log('\n=== BackpressureController Benchmarks ===');
  printHeader();

  const scenarios: Array<{ label: string; maxQueueSize: number }> = [
    { label: 'BackpressureController.enqueue() [depth=1000]', maxQueueSize: 1_000 },
    { label: 'BackpressureController.enqueue() [depth=100, drop-oldest]', maxQueueSize: 100 },
    { label: 'BackpressureController.enqueue() [depth=1, max-eviction]', maxQueueSize: 1 },
  ];

  for (const { label, maxQueueSize } of scenarios) {
    const ctrl = new BackpressureController<{ seq: number }>(NOOP_FLUSH, {
      maxQueueSize,
      strategy: 'drop-oldest',
    });

    let seq = 0;

    const result = await bench(
      label,
      () => {
        ctrl.enqueue('bench-key', { seq: seq++ });
      },
      { warmup: 1_000, iterations },
    );
    printResult(result);
  }

  // --- multi-key fan-out ---
  // Each enqueue uses a different key; tests Map lookup + insertion overhead.
  {
    const ctrl = new BackpressureController<{ seq: number }>(NOOP_FLUSH, {
      maxQueueSize: 100,
      strategy: 'drop-oldest',
    });

    let seq = 0;
    const KEY_COUNT = 1_000;

    const result = await bench(
      'BackpressureController.enqueue() [1000 keys]',
      () => {
        const key = `key-${seq % KEY_COUNT}`;
        ctrl.enqueue(key, { seq: seq++ });
      },
      { warmup: 1_000, iterations },
    );
    printResult(result);
  }

  printSeparator();
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export { main };
