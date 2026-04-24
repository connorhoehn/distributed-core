import {
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  HistogramSnapshot,
} from '../../../src/monitoring/metrics/MetricsRegistry';

describe('namespace and defaultLabels', () => {
  it('1. no options → existing behavior unchanged', () => {
    const registry = new MetricsRegistry('node-1');
    const c = registry.counter('req.count');
    c.inc(3);
    const snap = registry.getSnapshot();
    const sample = snap.metrics.find((m) => m.name === 'req.count');
    expect(sample).toBeDefined();
    expect(sample?.value).toBe(3);
  });

  it('2. namespace: "acme" → snapshot name is "acme.req.count"', () => {
    const registry = new MetricsRegistry('node-1', { namespace: 'acme' });
    const c = registry.counter('req.count');
    c.inc(1);
    const snap = registry.getSnapshot();
    const sample = snap.metrics.find((m) => m.name === 'acme.req.count');
    expect(sample).toBeDefined();
    expect(sample?.value).toBe(1);
  });

  it('3. defaultLabels applied when counter called with no labels', () => {
    const registry = new MetricsRegistry('node-1', { defaultLabels: { tenant: 'acme' } });
    registry.counter('req.count');
    const snap = registry.getSnapshot();
    const sample = snap.metrics.find((m) => m.name === 'req.count');
    expect(sample?.labels).toEqual({ tenant: 'acme' });
  });

  it('4. explicit label overrides default when keys collide', () => {
    const registry = new MetricsRegistry('node-1', { defaultLabels: { tenant: 'acme', region: 'us-east' } });
    registry.counter('req.count', { tenant: 'beta' });
    const snap = registry.getSnapshot();
    const sample = snap.metrics.find((m) => m.name === 'req.count');
    expect(sample?.labels).toEqual({ tenant: 'beta', region: 'us-east' });
  });

  it('5. child("svc-a") prefixes both namespaces → "acme.svc-a.req.count"', () => {
    const parent = new MetricsRegistry('node-1', { namespace: 'acme' });
    const child = parent.child('svc-a');
    child.counter('req.count').inc(1);
    const snap = parent.getSnapshot();
    const sample = snap.metrics.find((m) => m.name === 'acme.svc-a.req.count');
    expect(sample).toBeDefined();
    expect(sample?.value).toBe(1);
  });

  it('6. child labels merge: parent {tenant} + child {svc} → both present', () => {
    const parent = new MetricsRegistry('node-1', { defaultLabels: { tenant: 'acme' } });
    const child = parent.child(undefined, { svc: 'auth' });
    child.counter('req.count');
    const snap = parent.getSnapshot();
    const sample = snap.metrics.find((m) => m.name === 'req.count');
    expect(sample?.labels).toEqual({ tenant: 'acme', svc: 'auth' });
  });

  it('7. child and parent share the underlying store', () => {
    const parent = new MetricsRegistry('node-1', { namespace: 'acme' });
    const child = parent.child('svc-a');
    child.counter('req.count').inc(5);
    const parentSnap = parent.getSnapshot();
    const sample = parentSnap.metrics.find((m) => m.name === 'acme.svc-a.req.count');
    expect(sample?.value).toBe(5);
  });

  it('8. reset() on parent clears child metrics too (shared store)', () => {
    const parent = new MetricsRegistry('node-1', { namespace: 'acme' });
    const child = parent.child('svc-a');
    const c = child.counter('req.count');
    c.inc(10);
    parent.reset();
    expect(c.get()).toBe(0);
  });

  it('9. getMetricNames() returns the namespaced names', () => {
    const registry = new MetricsRegistry('node-1', { namespace: 'acme' });
    registry.counter('req.count');
    registry.gauge('active');
    const names = registry.getMetricNames();
    expect(names).toContain('acme.req.count');
    expect(names).toContain('acme.active');
    expect(names).not.toContain('req.count');
    expect(names).not.toContain('active');
  });
});

describe('Counter', () => {
  it('inc() defaults to 1 and accumulates', () => {
    const c = new Counter();
    c.inc();
    expect(c.get()).toBe(1);
    c.inc();
    expect(c.get()).toBe(2);
  });

  it('inc(n) adds n', () => {
    const c = new Counter();
    c.inc(5);
    expect(c.get()).toBe(5);
    c.inc(3);
    expect(c.get()).toBe(8);
  });

  it('reset() zeroes the counter', () => {
    const c = new Counter();
    c.inc(10);
    c.reset();
    expect(c.get()).toBe(0);
  });
});

describe('MetricsRegistry — Counter idempotency', () => {
  it('same name+labels returns the same Counter instance', () => {
    const registry = new MetricsRegistry('node-1');
    const a = registry.counter('requests', { method: 'GET' });
    const b = registry.counter('requests', { method: 'GET' });
    expect(a).toBe(b);
  });
});

describe('Gauge', () => {
  it('set/inc/dec/get work correctly', () => {
    const g = new Gauge();
    g.set(10);
    expect(g.get()).toBe(10);
    g.inc(5);
    expect(g.get()).toBe(15);
    g.dec(3);
    expect(g.get()).toBe(12);
    g.inc();
    expect(g.get()).toBe(13);
    g.dec();
    expect(g.get()).toBe(12);
  });
});

describe('Histogram', () => {
  it('observe multiple values; getSnapshot() has correct count/sum/mean', () => {
    const h = new Histogram();
    h.observe(10);
    h.observe(20);
    h.observe(30);
    const snap = h.getSnapshot();
    expect(snap.count).toBe(3);
    expect(snap.sum).toBe(60);
    expect(snap.mean).toBeCloseTo(20);
  });

  it('p50/p90/p99 are correct for [1..10]', () => {
    const h = new Histogram();
    for (let i = 1; i <= 10; i++) h.observe(i);
    const snap = h.getSnapshot();

    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const pct = (p: number) =>
      sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];

    expect(snap.p50).toBe(pct(50));
    expect(snap.p90).toBe(pct(90));
    expect(snap.p99).toBe(pct(99));
  });

  it('reset() clears all observations', () => {
    const h = new Histogram();
    h.observe(5);
    h.observe(10);
    h.reset();
    const snap = h.getSnapshot();
    expect(snap.count).toBe(0);
    expect(snap.sum).toBe(0);
    expect(snap.min).toBe(0);
    expect(snap.max).toBe(0);
    expect(snap.mean).toBe(0);
  });
});

describe('MetricsRegistry — labels', () => {
  it('different labels produce distinct metric instances', () => {
    const registry = new MetricsRegistry('node-1');
    const a = registry.counter('http_requests', { status: '200' });
    const b = registry.counter('http_requests', { status: '500' });
    a.inc(3);
    b.inc(7);
    expect(a.get()).toBe(3);
    expect(b.get()).toBe(7);
    expect(a).not.toBe(b);
  });

  it('empty labels and no labels produce the same key', () => {
    const registry = new MetricsRegistry('node-1');
    const a = registry.counter('events');
    const b = registry.counter('events', {});
    expect(a).toBe(b);
  });
});

describe('MetricsRegistry — getSnapshot()', () => {
  it('includes all registered metrics', () => {
    const registry = new MetricsRegistry('node-1');
    const c = registry.counter('reqs');
    c.inc(2);
    const g = registry.gauge('active');
    g.set(5);
    const h = registry.histogram('latency');
    h.observe(100);

    const snap = registry.getSnapshot();
    expect(snap.nodeId).toBe('node-1');
    expect(typeof snap.timestamp).toBe('number');

    const names = snap.metrics.map((m) => m.name);
    expect(names).toContain('reqs');
    expect(names).toContain('active');
    expect(names).toContain('latency');

    const counterSample = snap.metrics.find((m) => m.name === 'reqs');
    expect(counterSample?.value).toBe(2);

    const gaugeSample = snap.metrics.find((m) => m.name === 'active');
    expect(gaugeSample?.value).toBe(5);

    const histSample = snap.metrics.find((m) => m.name === 'latency');
    expect((histSample?.value as HistogramSnapshot).count).toBe(1);
  });
});

describe('MetricsRegistry — reset()', () => {
  it('resets all metric values but keeps registrations', () => {
    const registry = new MetricsRegistry('node-1');
    const c = registry.counter('reqs');
    c.inc(10);
    const g = registry.gauge('active');
    g.set(7);
    const h = registry.histogram('latency');
    h.observe(50);

    registry.reset();

    expect(c.get()).toBe(0);
    expect(g.get()).toBe(0);
    expect(h.getSnapshot().count).toBe(0);

    expect(registry.counter('reqs')).toBe(c);
    expect(registry.gauge('active')).toBe(g);
    expect(registry.histogram('latency')).toBe(h);
  });
});

describe('MetricsRegistry — getMetricNames()', () => {
  it('returns deduplicated names without label suffixes', () => {
    const registry = new MetricsRegistry('node-1');
    registry.counter('http_requests', { status: '200' });
    registry.counter('http_requests', { status: '500' });
    registry.gauge('active_connections');

    const names = registry.getMetricNames();
    expect(names).toContain('http_requests');
    expect(names).toContain('active_connections');
    expect(names.filter((n) => n === 'http_requests').length).toBe(1);
  });
});

describe('MetricsRegistry — type conflict', () => {
  it('throws when the same key is registered with a different type', () => {
    const registry = new MetricsRegistry('node-1');
    registry.counter('metric_name');
    expect(() => registry.gauge('metric_name')).toThrow();
    expect(() => registry.histogram('metric_name')).toThrow();
  });
});

describe('Histogram — bounded ring buffer', () => {
  it('default maxObservations is 1000: observe 1500, getCount() returns 1000', () => {
    const h = new Histogram();
    for (let i = 0; i < 1500; i++) h.observe(i);
    expect(h.getCount()).toBe(1000);
  });

  it('maxObservations=5: after 10 observations getCount is 5 and snapshot reflects last 5', () => {
    const h = new Histogram(5);
    for (let i = 1; i <= 10; i++) h.observe(i);
    expect(h.getCount()).toBe(5);
    const snap = h.getSnapshot();
    expect(snap.count).toBe(5);
    expect(snap.min).toBe(6);
    expect(snap.max).toBe(10);
  });

  it('min/max reflect CURRENT buffer, not lifetime values', () => {
    const h = new Histogram(5);
    h.observe(100); // will be overwritten
    h.observe(1);
    h.observe(2);
    h.observe(3);
    h.observe(4);
    h.observe(5); // overwrites the 100
    const snap = h.getSnapshot();
    expect(snap.min).toBe(1);
    expect(snap.max).toBe(5);
  });

  it('sum is maintained correctly across overwrites', () => {
    const h = new Histogram(3);
    h.observe(10);
    h.observe(20);
    h.observe(30);
    h.observe(40); // overwrites 10
    h.observe(50); // overwrites 20
    const snap = h.getSnapshot();
    expect(snap.sum).toBe(30 + 40 + 50);
  });

  it('reset() clears the buffer; subsequent observe(42) gives getCount=1 and mean=42', () => {
    const h = new Histogram(5);
    h.observe(1);
    h.observe(2);
    h.reset();
    h.observe(42);
    expect(h.getCount()).toBe(1);
    const snap = h.getSnapshot();
    expect(snap.mean).toBe(42);
  });

  it('MetricsRegistry.histogram(name, labels, 100) creates a histogram with maxObservations=100', () => {
    const registry = new MetricsRegistry('node-1');
    const h = registry.histogram('latency', {}, 100);
    for (let i = 0; i < 200; i++) h.observe(i);
    expect(h.getCount()).toBe(100);
  });
});
