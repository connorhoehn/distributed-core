import { BenchmarkRunner, BenchmarkResult } from '../../../src/benchmarks';

describe('BenchmarkRunner', () => {
  let runner: BenchmarkRunner;

  beforeEach(() => {
    runner = new BenchmarkRunner();
  });

  it('should return correct iteration count', async () => {
    const result = await runner.run('noop', () => {}, 50);
    expect(result.iterations).toBe(50);
  });

  it('should populate all result fields', async () => {
    const result = await runner.run('noop', () => {}, 20);
    const keys: (keyof BenchmarkResult)[] = [
      'name', 'iterations', 'totalMs', 'avgMs',
      'minMs', 'maxMs', 'p50Ms', 'p95Ms', 'p99Ms', 'opsPerSecond',
    ];
    for (const key of keys) {
      expect(result[key]).toBeDefined();
    }
  });

  it('should have min <= p50 <= p95 <= p99 <= max', async () => {
    const result = await runner.run('noop', () => {}, 100);
    expect(result.minMs).toBeLessThanOrEqual(result.p50Ms);
    expect(result.p50Ms).toBeLessThanOrEqual(result.p95Ms);
    expect(result.p95Ms).toBeLessThanOrEqual(result.p99Ms);
    expect(result.p99Ms).toBeLessThanOrEqual(result.maxMs);
  });

  it('should have avg approximately equal to totalMs / iterations', async () => {
    const result = await runner.run('noop', () => {}, 100);
    expect(result.avgMs).toBeCloseTo(result.totalMs / result.iterations, 6);
  });

  it('should compute positive ops/sec', async () => {
    const result = await runner.run('noop', () => {}, 50);
    expect(result.opsPerSecond).toBeGreaterThan(0);
  });

  it('should handle async functions', async () => {
    const result = await runner.run(
      'async-delay',
      () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
      10,
    );
    // Each iteration is at least ~1ms, so total should be >= 10ms
    expect(result.totalMs).toBeGreaterThanOrEqual(5);
    expect(result.iterations).toBe(10);
  });

  it('should execute warmup iterations (not counted in results)', async () => {
    let callCount = 0;
    await runner.run('counter', () => { callCount++; }, 20);
    // warmup = max(1, floor(20 * 0.1)) = 2, measured = 20 => total = 22
    expect(callCount).toBe(22);
  });

  describe('runSuite', () => {
    it('should run multiple benchmarks and return all results', async () => {
      const results = await runner.runSuite([
        { name: 'a', fn: () => {}, iterations: 10 },
        { name: 'b', fn: () => {}, iterations: 15 },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('a');
      expect(results[0].iterations).toBe(10);
      expect(results[1].name).toBe('b');
      expect(results[1].iterations).toBe(15);
    });
  });

  describe('printResults', () => {
    it('should print without errors', async () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const results = await runner.runSuite([
        { name: 'fast', fn: () => {}, iterations: 10 },
      ]);
      runner.printResults(results);
      expect(spy).toHaveBeenCalled();
      // Verify header is present in output
      const output = spy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Benchmark');
      expect(output).toContain('ops/sec');
      spy.mockRestore();
    });

    it('should handle empty results without error', () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      runner.printResults([]);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
