import * as http from 'http';
import { RegistrySnapshot, HistogramSnapshot, MetricSample } from './MetricsRegistry';
import { MetricsRegistry } from './MetricsRegistry';
import { LifecycleAware } from '../../common/LifecycleAware';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BUCKETS: readonly number[] = [
  0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, Infinity,
];

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert dotted metric names to underscore-separated Prometheus names. */
function mangleName(name: string): string {
  return name.replace(/\./g, '_');
}

/** Build a Prometheus label string like `{key="value",key2="value2"}`. */
function labelStr(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const parts = keys.map((k) => `${k}="${labels[k]}"`);
  return `{${parts.join(',')}}`;
}

/** Build label string with an extra synthetic label appended (e.g. `le`). */
function labelStrWith(
  labels: Record<string, string>,
  extraKey: string,
  extraValue: string,
): string {
  const keys = Object.keys(labels).sort();
  const parts = keys.map((k) => `${k}="${labels[k]}"`);
  parts.push(`${extraKey}="${extraValue}"`);
  return `{${parts.join(',')}}`;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FormatPrometheusOptions {
  /** Override the default histogram buckets (upper bounds in ms). Must be sorted ascending; +Inf is appended automatically if absent. */
  histogramBuckets?: number[];
  /** Optional HELP lines. Key is the original metric name (pre-mangling). */
  helpText?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Format a {@link RegistrySnapshot} as Prometheus text exposition format (0.0.4).
 *
 * Each distinct metric *name* becomes one metric family.  All label-variants of
 * that name are emitted together under the same `# TYPE` header.
 *
 * Name mangling: dots are converted to underscores.
 * Histograms are expanded into the `_bucket` / `_sum` / `_count` families.
 * Bucket values are cumulative (as Prometheus requires).
 */
export function formatPrometheus(
  snapshot: RegistrySnapshot,
  opts: FormatPrometheusOptions = {},
): string {
  if (snapshot.metrics.length === 0) return '';

  const rawBuckets: number[] = opts.histogramBuckets
    ? [...opts.histogramBuckets]
    : [...DEFAULT_BUCKETS];

  // Ensure +Inf is the last bucket.
  if (rawBuckets[rawBuckets.length - 1] !== Infinity) {
    rawBuckets.push(Infinity);
  }

  const helpText = opts.helpText ?? {};

  // Group samples by base name so all label-variants share one TYPE header.
  const groups = new Map<string, MetricSample[]>();
  for (const sample of snapshot.metrics) {
    const existing = groups.get(sample.name);
    if (existing) {
      existing.push(sample);
    } else {
      groups.set(sample.name, [sample]);
    }
  }

  const lines: string[] = [];

  for (const [baseName, samples] of groups) {
    const mangledName = mangleName(baseName);
    const type = samples[0].type; // all samples in a group share the same type

    // Optional HELP line.
    if (helpText[baseName] !== undefined) {
      lines.push(`# HELP ${mangledName} ${helpText[baseName]}`);
    }

    lines.push(`# TYPE ${mangledName} ${type}`);

    if (type === 'counter' || type === 'gauge') {
      for (const sample of samples) {
        const value = sample.value as number;
        const ls = labelStr(sample.labels);
        lines.push(`${mangledName}${ls} ${value} ${snapshot.timestamp}`);
      }
    } else {
      // histogram
      for (const sample of samples) {
        const hs = sample.value as HistogramSnapshot;
        const labels = sample.labels;

        // Build cumulative bucket counts from the stored observations.
        // MetricsRegistry stores a HistogramSnapshot with p50/p90/p99 but not
        // raw observations, so we approximate bucket counts from the snapshot
        // statistics that *are* available.
        //
        // Strategy: we know count, min, max, sum, p50, p90, p99.
        // We linearly interpolate cumulative counts across known quantile
        // anchor points to fill in intermediate buckets.  This is not exact,
        // but it is the best we can do without raw observations.
        const cumulativeCounts = buildCumulativeCounts(hs, rawBuckets);

        for (let i = 0; i < rawBuckets.length; i++) {
          const le = rawBuckets[i] === Infinity ? '+Inf' : String(rawBuckets[i]);
          const ls = labelStrWith(labels, 'le', le);
          lines.push(`${mangledName}_bucket${ls} ${cumulativeCounts[i]}`);
        }

        const ls = labelStr(labels);
        lines.push(`${mangledName}_sum${ls} ${hs.sum}`);
        lines.push(`${mangledName}_count${ls} ${hs.count}`);
      }
    }

    lines.push(''); // blank line between families
  }

  // Remove trailing blank line and add a final newline.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Cumulative bucket estimation
// ---------------------------------------------------------------------------

/**
 * Estimate cumulative bucket counts for Prometheus from a {@link HistogramSnapshot}.
 *
 * Known quantile anchors: (min, 0%), (p50, 50%), (p90, 90%), (p99, 99%), (max, 100%).
 * We linearly interpolate the cumulative fraction for each bucket upper bound
 * across these anchors, then multiply by the total count.
 */
function buildCumulativeCounts(hs: HistogramSnapshot, buckets: readonly number[]): number[] {
  if (hs.count === 0) {
    return buckets.map(() => 0);
  }

  // Anchor points: [value, cumulative_fraction]
  const anchors: [number, number][] = [
    [hs.min, 0],
    [hs.p50, 0.5],
    [hs.p90, 0.9],
    [hs.p99, 0.99],
    [hs.max, 1.0],
  ];

  // Deduplicate / sort anchors (p50 could equal min for tiny datasets).
  const sorted = anchors.sort((a, b) => a[0] - b[0]);
  const deduped: [number, number][] = [];
  for (const anchor of sorted) {
    if (deduped.length === 0 || deduped[deduped.length - 1][0] !== anchor[0]) {
      deduped.push(anchor);
    } else {
      // Keep the one with the larger fraction.
      deduped[deduped.length - 1][1] = Math.max(deduped[deduped.length - 1][1], anchor[1]);
    }
  }

  function interpolateFraction(value: number): number {
    if (value < deduped[0][0]) return 0;
    if (value >= deduped[deduped.length - 1][0]) return 1;

    for (let i = 0; i < deduped.length - 1; i++) {
      const [x0, f0] = deduped[i];
      const [x1, f1] = deduped[i + 1];
      if (value >= x0 && value <= x1) {
        if (x1 === x0) return f1;
        const t = (value - x0) / (x1 - x0);
        return f0 + t * (f1 - f0);
      }
    }
    return 1;
  }

  return buckets.map((upperBound) => {
    if (upperBound === Infinity) return hs.count;
    const fraction = interpolateFraction(upperBound);
    return Math.round(fraction * hs.count);
  });
}

// ---------------------------------------------------------------------------
// HTTP exporter
// ---------------------------------------------------------------------------

export interface PrometheusHttpExporterOptions {
  /** TCP port to listen on. Use 0 to get an OS-assigned port. Default: 9464. */
  port?: number;
  /** Bind address. Default: '0.0.0.0'. */
  host?: string;
  /** URL path to serve metrics on. Default: '/metrics'. */
  path?: string;
  /** Options forwarded to the formatter. */
  formatOptions?: FormatPrometheusOptions;
}

/**
 * A minimal HTTP server that serves a Prometheus scrape endpoint.
 *
 * Implements {@link LifecycleAware}: call `start()` to open the port and
 * `stop()` to close it gracefully.
 *
 * ```typescript
 * const exporter = new PrometheusHttpExporter(registry, { port: 9464 });
 * await exporter.start();
 * // ... scrape at http://host:9464/metrics
 * await exporter.stop();
 * ```
 */
export class PrometheusHttpExporter implements LifecycleAware {
  private readonly registry: MetricsRegistry;
  private readonly options: Required<PrometheusHttpExporterOptions>;
  private server: http.Server | null = null;
  private _started = false;
  private _port = 0;

  constructor(registry: MetricsRegistry, options: PrometheusHttpExporterOptions = {}) {
    this.registry = registry;
    this.options = {
      port: options.port ?? 9464,
      host: options.host ?? '0.0.0.0',
      path: options.path ?? '/metrics',
      formatOptions: options.formatOptions ?? {},
    };
  }

  /** The actual bound port. Populated after `start()` resolves. */
  get port(): number {
    return this._port;
  }

  async start(): Promise<void> {
    if (this._started) return;

    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      // Strip query string for path comparison.
      const pathname = url.split('?')[0];

      if (pathname !== this.options.path) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      try {
        const snapshot = this.registry.getSnapshot();
        const body = formatPrometheus(snapshot, this.options.formatOptions);
        res.writeHead(200, { 'Content-Type': PROMETHEUS_CONTENT_TYPE });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    });

    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', reject);
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
        }
        resolve();
      });
    });

    this._started = true;
  }

  async stop(): Promise<void> {
    if (!this._started || this.server === null) return;

    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this._started = false;
    this.server = null;
  }

  isStarted(): boolean {
    return this._started;
  }
}
