import { MetricsRegistry, RegistrySnapshot } from '../../../src/monitoring/metrics/MetricsRegistry';
import {
  formatPrometheus,
  PrometheusHttpExporter,
} from '../../../src/monitoring/metrics/PrometheusExporter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptySnapshot(): RegistrySnapshot {
  return { timestamp: 1700000000000, nodeId: 'test', metrics: [] };
}

// ---------------------------------------------------------------------------
// 1. Counter formatting
// ---------------------------------------------------------------------------

describe('formatPrometheus — counter', () => {
  it('mangles dots to underscores in the metric name', () => {
    const registry = new MetricsRegistry('node-1');
    registry.counter('resource.claim.count', { result: 'success' }).inc(42);
    const output = formatPrometheus(registry.getSnapshot());
    expect(output).toContain('resource_claim_count');
    expect(output).not.toContain('resource.claim.count');
  });

  it('preserves label key/value pairs', () => {
    const registry = new MetricsRegistry('node-1');
    registry.counter('http.requests', { method: 'GET', status: '200' }).inc(7);
    const output = formatPrometheus(registry.getSnapshot());
    expect(output).toContain('method="GET"');
    expect(output).toContain('status="200"');
  });

  it('includes the correct value', () => {
    const registry = new MetricsRegistry('node-1');
    registry.counter('events.total').inc(99);
    const output = formatPrometheus(registry.getSnapshot());
    // Counter line should look like:  events_total 99 <timestamp>
    expect(output).toMatch(/events_total\s+99\s+\d+/);
  });

  it('emits # TYPE counter', () => {
    const registry = new MetricsRegistry('node-1');
    registry.counter('reqs').inc(1);
    const output = formatPrometheus(registry.getSnapshot());
    expect(output).toContain('# TYPE reqs counter');
  });
});

// ---------------------------------------------------------------------------
// 2. Gauge formatting
// ---------------------------------------------------------------------------

describe('formatPrometheus — gauge', () => {
  it('mangles dots and preserves labels', () => {
    const registry = new MetricsRegistry('node-1');
    registry.gauge('session.active.connections', { region: 'us-east' }).set(15);
    const output = formatPrometheus(registry.getSnapshot());
    expect(output).toContain('session_active_connections');
    expect(output).toContain('region="us-east"');
  });

  it('includes the correct value', () => {
    const registry = new MetricsRegistry('node-1');
    registry.gauge('queue.depth').set(33);
    const output = formatPrometheus(registry.getSnapshot());
    expect(output).toMatch(/queue_depth\s+33\s+\d+/);
  });

  it('emits # TYPE gauge', () => {
    const registry = new MetricsRegistry('node-1');
    registry.gauge('workers').set(4);
    const output = formatPrometheus(registry.getSnapshot());
    expect(output).toContain('# TYPE workers gauge');
  });
});

// ---------------------------------------------------------------------------
// 3. Histogram formatting
// ---------------------------------------------------------------------------

describe('formatPrometheus — histogram', () => {
  function buildHistogramOutput(): string {
    const registry = new MetricsRegistry('node-1');
    const h = registry.histogram('session.apply.latency.ms');
    for (let i = 0; i < 30; i++) h.observe(i % 11); // values 0-10, sum = 30 * (0+1+…+10)/11 ≈ approx
    return formatPrometheus(registry.getSnapshot());
  }

  it('emits _bucket series', () => {
    const output = buildHistogramOutput();
    expect(output).toContain('session_apply_latency_ms_bucket');
  });

  it('emits _sum series', () => {
    const output = buildHistogramOutput();
    expect(output).toContain('session_apply_latency_ms_sum');
  });

  it('emits _count series', () => {
    const output = buildHistogramOutput();
    expect(output).toContain('session_apply_latency_ms_count');
  });

  it('includes le labels on buckets', () => {
    const output = buildHistogramOutput();
    expect(output).toContain('le="');
  });

  it('includes +Inf bucket', () => {
    const output = buildHistogramOutput();
    expect(output).toContain('le="+Inf"');
  });

  it('bucket values are non-decreasing (cumulative)', () => {
    const registry = new MetricsRegistry('node-1');
    const h = registry.histogram('latency', {}, 500);
    for (let i = 1; i <= 100; i++) h.observe(i);
    const output = formatPrometheus(registry.getSnapshot(), {
      histogramBuckets: [10, 50, 100, Infinity],
    });

    const bucketLines = output
      .split('\n')
      .filter((l) => l.includes('latency_bucket'));

    const counts = bucketLines.map((line) => {
      const m = line.match(/\}\s+([\d.]+)/);
      return m ? parseFloat(m[1]) : NaN;
    });

    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
  });

  it('emits # TYPE histogram', () => {
    const output = buildHistogramOutput();
    expect(output).toContain('# TYPE session_apply_latency_ms histogram');
  });
});

// ---------------------------------------------------------------------------
// 4. Custom bucket override
// ---------------------------------------------------------------------------

describe('formatPrometheus — custom buckets', () => {
  it('uses provided buckets instead of defaults', () => {
    const registry = new MetricsRegistry('node-1');
    const h = registry.histogram('custom.latency');
    h.observe(3);
    h.observe(7);
    const output = formatPrometheus(registry.getSnapshot(), {
      histogramBuckets: [5, 10],
    });

    expect(output).toContain('le="5"');
    expect(output).toContain('le="10"');
    expect(output).toContain('le="+Inf"');
    // Default bucket like 0.5 / 2.5 should NOT appear.
    expect(output).not.toContain('le="0.5"');
    expect(output).not.toContain('le="2.5"');
  });

  it('automatically appends +Inf if missing from custom buckets', () => {
    const registry = new MetricsRegistry('node-1');
    registry.histogram('lat').observe(1);
    const output = formatPrometheus(registry.getSnapshot(), {
      histogramBuckets: [1, 5, 10], // no Infinity
    });
    expect(output).toContain('le="+Inf"');
  });
});

// ---------------------------------------------------------------------------
// 5. Empty registry
// ---------------------------------------------------------------------------

describe('formatPrometheus — empty registry', () => {
  it('returns empty string for empty snapshot', () => {
    const output = formatPrometheus(makeEmptySnapshot());
    expect(output).toBe('');
  });

  it('does not contain malformed # TYPE or # HELP lines', () => {
    const output = formatPrometheus(makeEmptySnapshot());
    expect(output).not.toContain('# TYPE');
    expect(output).not.toContain('# HELP');
  });
});

// ---------------------------------------------------------------------------
// 6. helpText override
// ---------------------------------------------------------------------------

describe('formatPrometheus — helpText option', () => {
  it('emits # HELP line when helpText is provided', () => {
    const registry = new MetricsRegistry('node-1');
    registry.counter('foo').inc(1);
    const output = formatPrometheus(registry.getSnapshot(), {
      helpText: { foo: 'The foo metric' },
    });
    expect(output).toContain('# HELP foo The foo metric');
  });

  it('does not emit # HELP when not provided', () => {
    const registry = new MetricsRegistry('node-1');
    registry.counter('bar').inc(1);
    const output = formatPrometheus(registry.getSnapshot());
    expect(output).not.toContain('# HELP bar');
  });

  it('mangles metric name in # HELP line too', () => {
    const registry = new MetricsRegistry('node-1');
    registry.counter('resource.claim.count').inc(1);
    const output = formatPrometheus(registry.getSnapshot(), {
      helpText: { 'resource.claim.count': 'Total resource claim attempts' },
    });
    expect(output).toContain('# HELP resource_claim_count Total resource claim attempts');
  });
});

// ---------------------------------------------------------------------------
// HTTP exporter helpers
// ---------------------------------------------------------------------------

async function getMetrics(port: number, path = '/metrics'): Promise<{ status: number; body: string; contentType: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.text();
  return {
    status: res.status,
    body,
    contentType: res.headers.get('content-type'),
  };
}

// ---------------------------------------------------------------------------
// 7. HTTP exporter: start / fetch / content-type / body
// ---------------------------------------------------------------------------

describe('PrometheusHttpExporter — basic HTTP', () => {
  let exporter: PrometheusHttpExporter;

  afterEach(async () => {
    if (exporter?.isStarted()) await exporter.stop();
  });

  it('returns 200 with correct Content-Type and formatted body', async () => {
    const registry = new MetricsRegistry('node-1');
    registry.counter('reqs').inc(5);
    exporter = new PrometheusHttpExporter(registry, { port: 0 });
    await exporter.start();

    const { status, body, contentType } = await getMetrics(exporter.port);

    expect(status).toBe(200);
    expect(contentType).toMatch(/text\/plain/);
    expect(contentType).toContain('version=0.0.4');
    expect(body).toContain('reqs');
    expect(body).toContain('# TYPE reqs counter');
  });

  it('isStarted() returns true after start', async () => {
    const registry = new MetricsRegistry('node-1');
    exporter = new PrometheusHttpExporter(registry, { port: 0 });
    expect(exporter.isStarted()).toBe(false);
    await exporter.start();
    expect(exporter.isStarted()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. HTTP exporter: stop closes port
// ---------------------------------------------------------------------------

describe('PrometheusHttpExporter — stop', () => {
  it('closes the port; subsequent requests fail to connect', async () => {
    const registry = new MetricsRegistry('node-1');
    const exporter = new PrometheusHttpExporter(registry, { port: 0 });
    await exporter.start();
    const { port } = exporter;

    await exporter.stop();
    expect(exporter.isStarted()).toBe(false);

    await expect(
      fetch(`http://127.0.0.1:${port}/metrics`),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9. port: 0 → picks a free port; port property exposes it
// ---------------------------------------------------------------------------

describe('PrometheusHttpExporter — port: 0', () => {
  let exporter: PrometheusHttpExporter;

  afterEach(async () => {
    if (exporter?.isStarted()) await exporter.stop();
  });

  it('assigns a non-zero port when port: 0 is given', async () => {
    const registry = new MetricsRegistry('node-1');
    exporter = new PrometheusHttpExporter(registry, { port: 0 });
    await exporter.start();
    expect(exporter.port).toBeGreaterThan(0);
  });

  it('port property matches the actual listening port', async () => {
    const registry = new MetricsRegistry('node-1');
    exporter = new PrometheusHttpExporter(registry, { port: 0 });
    await exporter.start();

    const { status } = await getMetrics(exporter.port);
    expect(status).toBe(200);
  });

  it('calling start() a second time is a no-op (idempotent)', async () => {
    const registry = new MetricsRegistry('node-1');
    exporter = new PrometheusHttpExporter(registry, { port: 0 });
    await exporter.start();
    const firstPort = exporter.port;
    await exporter.start(); // should not throw or re-bind
    expect(exporter.port).toBe(firstPort);
  });
});

// ---------------------------------------------------------------------------
// 10. Non-/metrics path → 404
// ---------------------------------------------------------------------------

describe('PrometheusHttpExporter — 404 for unknown paths', () => {
  let exporter: PrometheusHttpExporter;

  afterEach(async () => {
    if (exporter?.isStarted()) await exporter.stop();
  });

  it('returns 404 for paths other than /metrics', async () => {
    const registry = new MetricsRegistry('node-1');
    exporter = new PrometheusHttpExporter(registry, { port: 0 });
    await exporter.start();

    const { status: s1 } = await getMetrics(exporter.port, '/');
    expect(s1).toBe(404);

    const { status: s2 } = await getMetrics(exporter.port, '/health');
    expect(s2).toBe(404);

    const { status: s3 } = await getMetrics(exporter.port, '/metrics/extra');
    expect(s3).toBe(404);
  });

  it('respects custom path option', async () => {
    const registry = new MetricsRegistry('node-1');
    exporter = new PrometheusHttpExporter(registry, { port: 0, path: '/custom/metrics' });
    await exporter.start();

    const { status: ok } = await getMetrics(exporter.port, '/custom/metrics');
    expect(ok).toBe(200);

    const { status: notFound } = await getMetrics(exporter.port, '/metrics');
    expect(notFound).toBe(404);
  });
});
