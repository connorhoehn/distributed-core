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
  private observations: number[] = [];
  private _sum = 0;
  private _min = Infinity;
  private _max = -Infinity;

  observe(value: number): void {
    this.observations.push(value);
    this._sum += value;
    if (value < this._min) this._min = value;
    if (value > this._max) this._max = value;
  }

  getCount(): number {
    return this.observations.length;
  }

  getSum(): number {
    return this._sum;
  }

  getSnapshot(): HistogramSnapshot {
    const count = this.observations.length;
    if (count === 0) {
      return { count: 0, sum: 0, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p99: 0 };
    }
    const sorted = [...this.observations].sort((a, b) => a - b);
    return {
      count,
      sum: this._sum,
      min: this._min,
      max: this._max,
      mean: this._sum / count,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p99: percentile(sorted, 99),
    };
  }

  reset(): void {
    this.observations = [];
    this._sum = 0;
    this._min = Infinity;
    this._max = -Infinity;
  }
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
  private store = new Map<string, StoredMetric>();

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  counter(name: string, labels?: MetricLabels): Counter {
    const key = buildKey(name, labels);
    const existing = this.store.get(key);
    if (existing) {
      if (existing.type !== 'counter') {
        throw new Error(`Metric "${key}" already registered as ${existing.type}, cannot re-register as counter`);
      }
      return existing.instance as Counter;
    }
    const instance = new Counter();
    this.store.set(key, { type: 'counter', name, labels: labels ?? {}, instance });
    return instance;
  }

  gauge(name: string, labels?: MetricLabels): Gauge {
    const key = buildKey(name, labels);
    const existing = this.store.get(key);
    if (existing) {
      if (existing.type !== 'gauge') {
        throw new Error(`Metric "${key}" already registered as ${existing.type}, cannot re-register as gauge`);
      }
      return existing.instance as Gauge;
    }
    const instance = new Gauge();
    this.store.set(key, { type: 'gauge', name, labels: labels ?? {}, instance });
    return instance;
  }

  histogram(name: string, labels?: MetricLabels): Histogram {
    const key = buildKey(name, labels);
    const existing = this.store.get(key);
    if (existing) {
      if (existing.type !== 'histogram') {
        throw new Error(`Metric "${key}" already registered as ${existing.type}, cannot re-register as histogram`);
      }
      return existing.instance as Histogram;
    }
    const instance = new Histogram();
    this.store.set(key, { type: 'histogram', name, labels: labels ?? {}, instance });
    return instance;
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
