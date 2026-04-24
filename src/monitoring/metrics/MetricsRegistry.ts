export type MetricLabels = Record<string, string>;

export interface MetricSample {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  labels: MetricLabels;
  value: number | HistogramSnapshot;
}

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
}

export interface RegistrySnapshot {
  timestamp: number;
  nodeId: string;
  metrics: MetricSample[];
}

function buildLabelSuffix(labels?: MetricLabels): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`);
  return `{${parts.join(',')}}`;
}

function buildKey(name: string, labels?: MetricLabels): string {
  return `${name}${buildLabelSuffix(labels)}`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export class Counter {
  private value = 0;

  inc(amount = 1): void {
    this.value += amount;
  }

  get(): number {
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}

export class Gauge {
  private value = 0;

  set(v: number): void {
    this.value = v;
  }

  inc(amount = 1): void {
    this.value += amount;
  }

  dec(amount = 1): void {
    this.value -= amount;
  }

  get(): number {
    return this.value;
  }
}

export class Histogram {
  private readonly observations: number[];
  private readonly maxObservations: number;
  private writeIdx = 0;
  private _count = 0;
  private _stored = 0;
  private _sum = 0;

  constructor(maxObservations = 1000) {
    this.maxObservations = maxObservations;
    this.observations = new Array(maxObservations);
  }

  observe(value: number): void {
    if (this._stored < this.maxObservations) {
      this.observations[this.writeIdx] = value;
      this.writeIdx = (this.writeIdx + 1) % this.maxObservations;
      this._stored++;
      this._sum += value;
    } else {
      const overwritten = this.observations[this.writeIdx];
      this.observations[this.writeIdx] = value;
      this.writeIdx = (this.writeIdx + 1) % this.maxObservations;
      this._sum = this._sum - overwritten + value;
    }
    this._count++;
  }

  getCount(): number {
    return this._stored;
  }

  getSum(): number {
    return this._sum;
  }

  getSnapshot(): HistogramSnapshot {
    if (this._stored === 0) {
      return { count: 0, sum: 0, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p99: 0 };
    }
    const current = this.observations.slice(0, this._stored);
    const sorted = [...current].sort((a, b) => a - b);
    return {
      count: this._stored,
      sum: this._sum,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: this._sum / this._stored,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p99: percentile(sorted, 99),
    };
  }

  reset(): void {
    this.writeIdx = 0;
    this._count = 0;
    this._stored = 0;
    this._sum = 0;
  }
}

export interface MetricsRegistryOptions {
  /**
   * Optional namespace prefix prepended to every metric name.
   * Example: namespace='acme' turns `resource.claim.count` into
   * `acme.resource.claim.count` in the output snapshot.
   */
  namespace?: string;

  /**
   * Default labels merged onto every Counter/Gauge/Histogram at creation.
   * Explicit labels passed to counter/gauge/histogram() are merged on top —
   * they override defaults when keys collide.
   */
  defaultLabels?: MetricLabels;
}

type MetricType = 'counter' | 'gauge' | 'histogram';

interface StoredMetric {
  type: MetricType;
  name: string;
  labels: MetricLabels;
  instance: Counter | Gauge | Histogram;
}

export class MetricsRegistry {
  private nodeId: string;
  private store: Map<string, StoredMetric>;
  private namespace: string | undefined;
  private defaultLabels: MetricLabels;

  constructor(nodeId: string, options?: MetricsRegistryOptions, store?: Map<string, StoredMetric>) {
    this.nodeId = nodeId;
    this.namespace = options?.namespace;
    this.defaultLabels = options?.defaultLabels ?? {};
    this.store = store ?? new Map<string, StoredMetric>();
  }

  private effectiveName(name: string): string {
    return this.namespace ? `${this.namespace}.${name}` : name;
  }

  private effectiveLabels(labels?: MetricLabels): MetricLabels {
    return { ...this.defaultLabels, ...(labels ?? {}) };
  }

  counter(name: string, labels?: MetricLabels): Counter {
    const fullName = this.effectiveName(name);
    const mergedLabels = this.effectiveLabels(labels);
    const key = buildKey(fullName, mergedLabels);
    const existing = this.store.get(key);
    if (existing) {
      if (existing.type !== 'counter') {
        throw new Error(`Metric "${key}" already registered as ${existing.type}, cannot re-register as counter`);
      }
      return existing.instance as Counter;
    }
    const instance = new Counter();
    this.store.set(key, { type: 'counter', name: fullName, labels: mergedLabels, instance });
    return instance;
  }

  gauge(name: string, labels?: MetricLabels): Gauge {
    const fullName = this.effectiveName(name);
    const mergedLabels = this.effectiveLabels(labels);
    const key = buildKey(fullName, mergedLabels);
    const existing = this.store.get(key);
    if (existing) {
      if (existing.type !== 'gauge') {
        throw new Error(`Metric "${key}" already registered as ${existing.type}, cannot re-register as gauge`);
      }
      return existing.instance as Gauge;
    }
    const instance = new Gauge();
    this.store.set(key, { type: 'gauge', name: fullName, labels: mergedLabels, instance });
    return instance;
  }

  histogram(name: string, labels?: MetricLabels, maxObservations?: number): Histogram {
    const fullName = this.effectiveName(name);
    const mergedLabels = this.effectiveLabels(labels);
    const key = buildKey(fullName, mergedLabels);
    const existing = this.store.get(key);
    if (existing) {
      if (existing.type !== 'histogram') {
        throw new Error(`Metric "${key}" already registered as ${existing.type}, cannot re-register as histogram`);
      }
      return existing.instance as Histogram;
    }
    const instance = new Histogram(maxObservations);
    this.store.set(key, { type: 'histogram', name: fullName, labels: mergedLabels, instance });
    return instance;
  }

  /**
   * Derive a child registry that inherits the parent's namespace+defaultLabels
   * but adds its own on top. The child shares the parent's underlying
   * metric instances — incrementing a counter on the child affects the
   * parent's snapshot.
   */
  child(childNamespace?: string, childLabels?: MetricLabels): MetricsRegistry {
    const combinedNamespace = [this.namespace, childNamespace].filter(Boolean).join('.') || undefined;
    const combinedLabels: MetricLabels = { ...this.defaultLabels, ...(childLabels ?? {}) };
    return new MetricsRegistry(
      this.nodeId,
      { namespace: combinedNamespace, defaultLabels: combinedLabels },
      this.store,
    );
  }

  getSnapshot(): RegistrySnapshot {
    const metrics: MetricSample[] = [];
    for (const [, stored] of this.store) {
      let value: number | HistogramSnapshot;
      if (stored.type === 'counter') {
        value = (stored.instance as Counter).get();
      } else if (stored.type === 'gauge') {
        value = (stored.instance as Gauge).get();
      } else {
        value = (stored.instance as Histogram).getSnapshot();
      }
      metrics.push({ name: stored.name, type: stored.type, labels: stored.labels, value });
    }
    return { timestamp: Date.now(), nodeId: this.nodeId, metrics };
  }

  reset(): void {
    for (const [, stored] of this.store) {
      if (stored.type === 'counter') {
        (stored.instance as Counter).reset();
      } else if (stored.type === 'gauge') {
        (stored.instance as Gauge).set(0);
      } else {
        (stored.instance as Histogram).reset();
      }
    }
  }

  getMetricNames(): string[] {
    const names = new Set<string>();
    for (const [, stored] of this.store) {
      names.add(stored.name);
    }
    return Array.from(names);
  }
}
