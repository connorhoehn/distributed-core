# distributed-core Benchmarks

Single-process micro-benchmarks that establish throughput and latency baselines
for the core primitives. Not part of the test suite — Jest never sees these files.

## Running

```bash
# Run all benchmarks
npm run bench

# Run a single benchmark
npm run bench:one benchmarks/rateLimiter.bench.ts

# Override iteration count (default varies per primitive)
npm run bench -- --iterations 50000
npm run bench:one benchmarks/resourceRouter.bench.ts -- --iterations 20000
```

## Output format

Each row reports:

| Column      | Meaning                                             |
|-------------|-----------------------------------------------------|
| Benchmark   | Scenario name                                       |
| Throughput  | Operations per second (M/s, K/s, or /s)            |
| p50         | Median per-op latency in microseconds (or ms)       |
| p90         | 90th-percentile latency                             |
| p99         | 99th-percentile latency                             |

Latencies are measured with `process.hrtime.bigint()` at nanosecond resolution
and stored in a pre-allocated `Float64Array` — no GC pressure from collection.

## Primitives covered

| File                              | Default iterations |
|-----------------------------------|--------------------|
| `resourceRouter.bench.ts`         | 100 000            |
| `distributedLock.bench.ts`        | 10 000             |
| `eventBus.bench.ts`               | 100 000 (no WAL), 10 000 (WAL) |
| `backpressureController.bench.ts` | 100 000            |
| `rateLimiter.bench.ts`            | 100 000            |
| `metricsRegistry.bench.ts`        | 100 000            |

## Caveats

- **Single-process only.** All benchmarks run in one Node.js process. There is
  no actual network I/O — transport and cluster dependencies are stubbed out.
  Distributed scenarios (e.g., two-node lock contention) are simulated by
  sharing an in-memory registry between two lock instances.

- **No JIT warmup guarantee.** V8's JIT compiler continues to optimise during
  the warmup phase (default 1 000 iterations). Numbers stabilise quickly for
  hot loops but may vary slightly across runs.

- **OS scheduling noise.** p99 in particular can spike due to GC pauses, OS
  timer interrupts, or CPU frequency scaling. Run on a quiet machine and average
  several runs for stable baselines.

- **WAL benchmarks are I/O bound.** The `EventBus [WAL]` scenarios write to a
  temp file. Results depend heavily on storage class (SSD vs. HDD vs. RAM-disk).

- **No cross-run assertions.** These benchmarks do not assert that numbers stay
  within a budget. The goal is to record baselines so regressions can be spotted
  by comparing runs, not by CI gates.

## Adding a new benchmark

1. Create `benchmarks/<primitive>.bench.ts`.
2. Import `bench`, `printHeader`, `printResult`, `printSeparator` from `./harness`.
3. End the file with the `require.main === module` guard so it is directly runnable.
4. Add `import { main as run<Primitive> } from './<primitive>.bench'` in `run-all.ts`.
