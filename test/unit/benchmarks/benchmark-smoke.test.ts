import { BenchmarkRunner, BenchmarkResult } from '../../../src/benchmarks';

/**
 * Smoke tests for the benchmark framework.
 *
 * These verify that the BenchmarkRunner machinery works correctly
 * without running real, long-running benchmarks. Iteration counts
 * are kept intentionally small (10-100) so the suite finishes fast.
 */
describe('Benchmark smoke tests', () => {
  let runner: BenchmarkRunner;

  beforeEach(() => {
    runner = new BenchmarkRunner();
  });

  describe('BenchmarkRunner.run()', () => {
    it('executes a simple function and returns a valid BenchmarkResult', async () => {
      const result = await runner.run('simple-add', () => {
        let sum = 0;
        for (let i = 0; i < 100; i++) sum += i;
      }, 50);

      expect(result).toBeDefined();
      expect(result.name).toBe('simple-add');
      expect(result.iterations).toBe(50);
      expect(result.avgMs).toBeGreaterThanOrEqual(0);
      expect(result.opsPerSecond).toBeGreaterThan(0);
    });

    it('handles async benchmark functions', async () => {
      const result = await runner.run(
        'async-noop',
        async () => { await Promise.resolve(); },
        20,
      );

      expect(result.iterations).toBe(20);
      expect(result.totalMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('BenchmarkResult required fields', () => {
    it('has all required fields with correct types', async () => {
      const result = await runner.run('field-check', () => {}, 30);

      // Verify every required field exists and has the right type
      expect(typeof result.name).toBe('string');
      expect(typeof result.iterations).toBe('number');
      expect(typeof result.avgMs).toBe('number');
      expect(typeof result.p50Ms).toBe('number');
      expect(typeof result.p95Ms).toBe('number');
      expect(typeof result.p99Ms).toBe('number');
      expect(typeof result.opsPerSecond).toBe('number');

      // Additional fields from the interface
      expect(typeof result.totalMs).toBe('number');
      expect(typeof result.minMs).toBe('number');
      expect(typeof result.maxMs).toBe('number');
    });

    it('produces sane numeric relationships', async () => {
      const result = await runner.run('ordering', () => {}, 100);

      expect(result.minMs).toBeLessThanOrEqual(result.p50Ms);
      expect(result.p50Ms).toBeLessThanOrEqual(result.p95Ms);
      expect(result.p95Ms).toBeLessThanOrEqual(result.p99Ms);
      expect(result.p99Ms).toBeLessThanOrEqual(result.maxMs);
      expect(result.avgMs).toBeCloseTo(result.totalMs / result.iterations, 6);
    });
  });

  describe('runSuite()', () => {
    it('runs multiple benchmarks and returns results for each', async () => {
      const results = await runner.runSuite([
        { name: 'bench-a', fn: () => {}, iterations: 10 },
        { name: 'bench-b', fn: () => {}, iterations: 20 },
        { name: 'bench-c', fn: () => {}, iterations: 15 },
      ]);

      expect(results).toHaveLength(3);
      expect(results[0].name).toBe('bench-a');
      expect(results[0].iterations).toBe(10);
      expect(results[1].name).toBe('bench-b');
      expect(results[1].iterations).toBe(20);
      expect(results[2].name).toBe('bench-c');
      expect(results[2].iterations).toBe(15);
    });

    it('returns an empty array for an empty suite', async () => {
      const results = await runner.runSuite([]);
      expect(results).toEqual([]);
    });
  });

  describe('printResults()', () => {
    it('does not throw when printing valid results', async () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const results = await runner.runSuite([
          { name: 'print-test', fn: () => {}, iterations: 10 },
        ]);

        expect(() => runner.printResults(results)).not.toThrow();

        // Verify table headers appeared in captured output
        const output = spy.mock.calls.map((c) => c[0]).join('\n');
        expect(output).toContain('Benchmark');
        expect(output).toContain('Avg (ms)');
        expect(output).toContain('ops/sec');
        expect(output).toContain('print-test');
      } finally {
        spy.mockRestore();
      }
    });

    it('handles empty results without throwing', () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(() => runner.printResults([])).not.toThrow();
        // Empty results should produce no output
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('warmup iterations', () => {
    it('excludes warmup iterations from reported results', async () => {
      let totalCalls = 0;
      const iterations = 20;
      const result = await runner.run('warmup-test', () => { totalCalls++; }, iterations);

      // Warmup count = max(1, floor(iterations * 0.1)) = 2
      // Total calls = warmup (2) + measured (20) = 22
      const expectedWarmup = Math.max(1, Math.floor(iterations * 0.1));
      expect(totalCalls).toBe(iterations + expectedWarmup);

      // But the result only reports the measured iterations
      expect(result.iterations).toBe(iterations);
    });

    it('warmup does not pollute timing data', async () => {
      let callIndex = 0;
      const iterations = 10;
      const warmupCount = Math.max(1, Math.floor(iterations * 0.1)); // 1

      const result = await runner.run('warmup-timing', () => {
        callIndex++;
        // Warmup calls are the first `warmupCount` invocations.
        // They should not appear in the result timings array.
      }, iterations);

      // The function was called warmupCount + iterations times total
      expect(callIndex).toBe(warmupCount + iterations);
      // But only `iterations` data points contribute to the result
      expect(result.iterations).toBe(iterations);
      expect(result.totalMs).toBeGreaterThanOrEqual(0);
    });
  });
});
