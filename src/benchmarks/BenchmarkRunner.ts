import { performance } from 'perf_hooks';

export interface BenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  opsPerSecond: number;
}

const DEFAULT_ITERATIONS = 1000;
const WARMUP_RATIO = 0.1;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export class BenchmarkRunner {
  /**
   * Run a single benchmark, returning timing statistics.
   *
   * A warmup phase of ~10 % of iterations is executed first and its
   * results are discarded so that JIT compilation and caches are primed
   * before the measured phase begins.
   */
  async run(
    name: string,
    fn: () => Promise<void> | void,
    iterations: number = DEFAULT_ITERATIONS,
  ): Promise<BenchmarkResult> {
    const warmupCount = Math.max(1, Math.floor(iterations * WARMUP_RATIO));

    // Warmup phase -- results discarded
    for (let i = 0; i < warmupCount; i++) {
      await fn();
    }

    // Measured phase
    const timings: number[] = new Array(iterations);
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await fn();
      timings[i] = performance.now() - start;
    }

    const sorted = timings.slice().sort((a, b) => a - b);
    const totalMs = timings.reduce((sum, t) => sum + t, 0);

    return {
      name,
      iterations,
      totalMs,
      avgMs: totalMs / iterations,
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      opsPerSecond: iterations / (totalMs / 1000),
    };
  }

  /**
   * Run multiple benchmarks sequentially and return all results.
   */
  async runSuite(
    benchmarks: Array<{ name: string; fn: () => Promise<void> | void; iterations?: number }>,
  ): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = [];
    for (const b of benchmarks) {
      results.push(await this.run(b.name, b.fn, b.iterations));
    }
    return results;
  }

  /**
   * Print a formatted results table to stdout with aligned columns.
   */
  printResults(results: BenchmarkResult[]): void {
    if (results.length === 0) return;

    const headers = [
      'Benchmark',
      'Iterations',
      'Total (ms)',
      'Avg (ms)',
      'Min (ms)',
      'Max (ms)',
      'p50 (ms)',
      'p95 (ms)',
      'p99 (ms)',
      'ops/sec',
    ];

    const rows = results.map((r) => [
      r.name,
      r.iterations.toString(),
      r.totalMs.toFixed(2),
      r.avgMs.toFixed(4),
      r.minMs.toFixed(4),
      r.maxMs.toFixed(4),
      r.p50Ms.toFixed(4),
      r.p95Ms.toFixed(4),
      r.p99Ms.toFixed(4),
      r.opsPerSecond.toFixed(0),
    ]);

    // Compute column widths
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((row) => row[i].length)),
    );

    const pad = (s: string, w: number) => s.padEnd(w);
    const sep = widths.map((w) => '-'.repeat(w)).join('  ');

    const headerLine = headers.map((h, i) => pad(h, widths[i])).join('  ');

    console.log('');
    console.log(headerLine);
    console.log(sep);
    for (const row of rows) {
      console.log(row.map((cell, i) => pad(cell, widths[i])).join('  '));
    }
    console.log('');
  }
}
