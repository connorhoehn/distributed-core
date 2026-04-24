/**
 * benchmarks/harness.ts
 *
 * Lightweight benchmark harness. No external dependencies — uses
 * process.hrtime.bigint() for nanosecond-resolution timing and a
 * pre-allocated Float64Array for zero-GC latency collection.
 */

export interface BenchResult {
  name: string;
  iterations: number;
  durationMs: number;
  opsPerSec: number;
  p50Us: number; // microseconds
  p90Us: number;
  p99Us: number;
}

export interface BenchOpts {
  warmup?: number;     // default 1 000
  iterations?: number; // default 100 000
}

/**
 * Run a benchmark.
 *
 * @param name       Display name for the result row
 * @param op         The operation under test (sync or async). Returning a
 *                   Promise is detected automatically.
 * @param opts       warmup / iterations overrides
 */
export async function bench(
  name: string,
  op: () => Promise<void> | void,
  opts?: BenchOpts,
): Promise<BenchResult> {
  const warmupN = opts?.warmup ?? 1_000;
  const measureN = opts?.iterations ?? 100_000;

  // --- warmup ---
  for (let i = 0; i < warmupN; i++) {
    const result = op();
    if (result !== undefined) await result;
  }

  // --- measure ---
  const latencies = new Float64Array(measureN);
  const t0 = process.hrtime.bigint();

  for (let i = 0; i < measureN; i++) {
    const start = process.hrtime.bigint();
    const result = op();
    if (result !== undefined) await result;
    // Convert nanoseconds → microseconds as a float
    latencies[i] = Number(process.hrtime.bigint() - start) / 1_000;
  }

  const durationNs = Number(process.hrtime.bigint() - t0);
  const durationMs = durationNs / 1_000_000;
  const opsPerSec = Math.round(measureN / (durationNs / 1e9));

  // Sort a copy for percentile computation (avoid mutating the raw array)
  const sorted = latencies.slice().sort();

  const p = (pct: number): number => {
    const idx = Math.max(0, Math.ceil((pct / 100) * measureN) - 1);
    return Math.round(sorted[idx] * 100) / 100; // two decimal places
  };

  return {
    name,
    iterations: measureN,
    durationMs: Math.round(durationMs * 10) / 10,
    opsPerSec,
    p50Us: p(50),
    p90Us: p(90),
    p99Us: p(99),
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers (used by each bench file and run-all.ts)
// ---------------------------------------------------------------------------

const COL_NAME = 38;
const COL_OPS  = 14;
const COL_LAT  = 10;

function pad(s: string, n: number, right = false): string {
  return right ? s.padStart(n) : s.padEnd(n);
}

function fmtOps(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M/s`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K/s`;
  return `${n}/s`;
}

function fmtUs(us: number): string {
  if (us >= 1_000) return `${(us / 1_000).toFixed(2)}ms`;
  return `${us.toFixed(1)}μs`;
}

export function printHeader(): void {
  const line =
    pad('Benchmark', COL_NAME) +
    pad('Throughput', COL_OPS, true) +
    pad('p50', COL_LAT, true) +
    pad('p90', COL_LAT, true) +
    pad('p99', COL_LAT, true);
  console.log(line);
  console.log('─'.repeat(line.length));
}

export function printResult(r: BenchResult): void {
  console.log(
    pad(r.name, COL_NAME) +
    pad(fmtOps(r.opsPerSec), COL_OPS, true) +
    pad(fmtUs(r.p50Us), COL_LAT, true) +
    pad(fmtUs(r.p90Us), COL_LAT, true) +
    pad(fmtUs(r.p99Us), COL_LAT, true),
  );
}

export function printSeparator(label?: string): void {
  if (label) {
    console.log(`\n${label}`);
  } else {
    console.log('');
  }
}

/** Parse optional --iterations N from argv */
export function parseIterations(defaultN: number): number {
  const idx = process.argv.indexOf('--iterations');
  if (idx !== -1 && idx + 1 < process.argv.length) {
    const n = parseInt(process.argv[idx + 1], 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return defaultN;
}
