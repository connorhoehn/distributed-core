/**
 * benchmarks/run-all.ts
 *
 * Runs every benchmark file in sequence and prints a summary table.
 *
 * Usage:
 *   npm run bench
 *   npx ts-node benchmarks/run-all.ts
 *   npx ts-node benchmarks/run-all.ts --iterations 50000
 */

import { main as runResourceRouter } from './resourceRouter.bench';
import { main as runDistributedLock } from './distributedLock.bench';
import { main as runEventBus } from './eventBus.bench';
import { main as runBackpressure } from './backpressureController.bench';
import { main as runRateLimiter } from './rateLimiter.bench';
import { main as runMetrics } from './metricsRegistry.bench';
import { main as runPubSubFanout } from './pubsubFanout.bench';
import { main as runCrdtMerge } from './crdtMerge.bench';

interface SuiteEntry {
  name: string;
  run: () => Promise<void>;
}

const SUITES: SuiteEntry[] = [
  { name: 'ResourceRouter',          run: runResourceRouter },
  { name: 'DistributedLock',         run: runDistributedLock },
  { name: 'EventBus',                run: runEventBus },
  { name: 'BackpressureController',  run: runBackpressure },
  { name: 'RateLimiter',             run: runRateLimiter },
  { name: 'MetricsRegistry',         run: runMetrics },
  { name: 'PubSubFanout',            run: runPubSubFanout },
  { name: 'CrdtMerge',               run: runCrdtMerge },
];

async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   distributed-core benchmark suite       ║');
  console.log('╚══════════════════════════════════════════╝');

  const wallStart = Date.now();
  const results: { name: string; ok: boolean; durationMs: number }[] = [];

  for (const suite of SUITES) {
    const t0 = Date.now();
    try {
      await suite.run();
      results.push({ name: suite.name, ok: true, durationMs: Date.now() - t0 });
    } catch (err) {
      console.error(`\nERROR in ${suite.name}:`, err);
      results.push({ name: suite.name, ok: false, durationMs: Date.now() - t0 });
    }
  }

  const totalMs = Date.now() - wallStart;

  console.log('\n════════════════ Suite Summary ════════════════');
  for (const r of results) {
    const status = r.ok ? 'OK  ' : 'FAIL';
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    console.log(`  [${status}]  ${r.name.padEnd(28)} ${dur.padStart(6)}`);
  }
  console.log('───────────────────────────────────────────────');
  console.log(`  Total wall time: ${(totalMs / 1000).toFixed(1)}s`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} suite(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
