/**
 * benchmarks/rateLimiter.bench.ts
 *
 * Benchmarks RateLimiter.check() throughput (pure CPU — token-bucket math).
 *
 * Scenarios:
 *   - Single key, always allowed  (high limit, never exhausted)
 *   - Single key, always rejected (limit=0 after first call)
 *   - 1 000 distinct keys (Map lookup + per-bucket refill)
 *
 * Run directly:  npx ts-node benchmarks/rateLimiter.bench.ts [--iterations N]
 */

import { RateLimiter } from '../src/common/RateLimiter';
import { bench, printHeader, printResult, printSeparator, parseIterations } from './harness';

async function main(): Promise<void> {
  const iterations = parseIterations(100_000);

  console.log('\n=== RateLimiter Benchmarks ===');
  printHeader();

  // --- single key, always allowed ---
  {
    // 1M requests per second → never throttled at bench throughput
    const limiter = new RateLimiter({ maxRequests: 1_000_000, windowMs: 1_000, burstLimit: 1_000_000 });

    const result = await bench(
      'RateLimiter.check() [single key, always allowed]',
      () => {
        limiter.check('user-1');
      },
      { warmup: 1_000, iterations },
    );
    printResult(result);
  }

  // --- single key, always rejected ---
  {
    // 0 requests per window → always rejected after first token consumed
    const limiter = new RateLimiter({ maxRequests: 0, windowMs: 1_000, burstLimit: 0 });

    const result = await bench(
      'RateLimiter.check() [single key, always rejected]',
      () => {
        limiter.check('user-1');
      },
      { warmup: 1_000, iterations },
    );
    printResult(result);
  }

  // --- 1 000 distinct keys ---
  {
    const limiter = new RateLimiter({ maxRequests: 1_000_000, windowMs: 1_000, burstLimit: 1_000_000 });
    let seq = 0;
    const KEY_COUNT = 1_000;

    const result = await bench(
      'RateLimiter.check() [1000 distinct keys]',
      () => {
        limiter.check(`user-${seq++ % KEY_COUNT}`);
      },
      { warmup: 1_000, iterations },
    );
    printResult(result);
  }

  // --- 10 000 distinct keys (Map growth) ---
  {
    const limiter = new RateLimiter({ maxRequests: 1_000_000, windowMs: 1_000, burstLimit: 1_000_000 });
    let seq = 0;
    const KEY_COUNT = 10_000;

    const result = await bench(
      'RateLimiter.check() [10000 distinct keys]',
      () => {
        limiter.check(`user-${seq++ % KEY_COUNT}`);
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
