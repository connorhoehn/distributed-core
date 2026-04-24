/**
 * benchmarks/metricsRegistry.bench.ts
 *
 * Benchmarks MetricsRegistry counter().inc() and histogram().observe()
 * throughput. These are hot paths in every other primitive, so establishing
 * a baseline here is useful for attribution when other benchmarks show
 * unexpected overhead.
 *
 * Scenarios:
 *   - counter.inc()  — same metric, same labels (Map lookup + integer add)
 *   - counter.inc()  — 100 distinct label combinations (label-key fan-out)
 *   - histogram.observe() — single metric (ring-buffer write)
 *   - MetricsRegistry.getSnapshot() — full snapshot over 50 metrics
 *
 * Run directly:  npx ts-node benchmarks/metricsRegistry.bench.ts [--iterations N]
 */

import { MetricsRegistry, Counter, Histogram } from '../src/monitoring/metrics/MetricsRegistry';
import { bench, printHeader, printResult, printSeparator, parseIterations } from './harness';

async function main(): Promise<void> {
  const iterations = parseIterations(100_000);

  console.log('\n=== MetricsRegistry Benchmarks ===');
  printHeader();

  // Pre-warm a registry with 50 metrics (realistic-ish production size)
  const registry = new MetricsRegistry('bench-node');

  // --- counter.inc() — single metric cached reference ---
  {
    const counter = registry.counter('requests.total');

    const result = await bench(
      'Counter.inc() [cached reference]',
      () => {
        counter.inc();
      },
      { warmup: 1_000, iterations },
    );
    printResult(result);
  }

  // --- counter lookup + inc via registry ---
  {
    const result = await bench(
      'MetricsRegistry.counter().inc() [lookup + inc]',
      () => {
        registry.counter('requests.total').inc();
      },
      { warmup: 1_000, iterations },
    );
    printResult(result);
  }

  // --- counter.inc() — 100 distinct label sets ---
  {
    const STATUS_CODES = ['200', '201', '400', '404', '500'];
    const ROUTES = Array.from({ length: 20 }, (_, i) => `/api/v1/resource/${i}`);
    let seq = 0;

    const result = await bench(
      'MetricsRegistry.counter().inc() [100 label combos]',
      () => {
        const status = STATUS_CODES[seq % STATUS_CODES.length];
        const route  = ROUTES[seq % ROUTES.length];
        seq++;
        registry.counter('http.requests', { status, route }).inc();
      },
      { warmup: 1_000, iterations },
    );
    printResult(result);
  }

  // --- histogram.observe() — cached reference ---
  {
    const histogram = registry.histogram('request.latency_ms', {}, 2_000);

    const result = await bench(
      'Histogram.observe() [cached reference]',
      () => {
        histogram.observe(Math.random() * 100);
      },
      { warmup: 1_000, iterations },
    );
    printResult(result);
  }

  // --- getSnapshot() — 50 registered metrics ---
  {
    // Populate 50 metrics (counters + histograms mix)
    const snap = new MetricsRegistry('snap-node');
    for (let i = 0; i < 25; i++) {
      const c = snap.counter(`metric.counter.${i}`);
      c.inc(i);
    }
    for (let i = 0; i < 25; i++) {
      const h = snap.histogram(`metric.histogram.${i}`, {}, 500);
      for (let j = 0; j < 100; j++) h.observe(Math.random() * 200);
    }

    const result = await bench(
      'MetricsRegistry.getSnapshot() [50 metrics]',
      () => {
        snap.getSnapshot();
      },
      { warmup: 200, iterations: Math.min(iterations, 10_000) },
    );
    printResult(result);
  }

  printSeparator();
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export { main };
