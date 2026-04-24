import { EventEmitter } from 'events';
import { ForwardingServer } from '../../../src/routing/ForwardingServer';
import { ForwardingHandler } from '../../../src/routing/ForwardingServer';
import { ResourceRouter } from '../../../src/routing/ResourceRouter';
import { MetricsRegistry } from '../../../src/monitoring/metrics/MetricsRegistry';
import { RouteTarget } from '../../../src/routing/types';

// ---------------------------------------------------------------------------
// Helpers (mirrors pattern from ForwardingServer.test.ts)
// ---------------------------------------------------------------------------

function makeRouter(opts: {
  localResources?: Set<string>;
  remoteRoutes?: Map<string, RouteTarget>;
}) {
  const local = opts.localResources ?? new Set<string>();
  const remote = opts.remoteRoutes ?? new Map<string, RouteTarget>();
  const emitter = new EventEmitter();

  return {
    isLocal: jest.fn((resourceId: string) => local.has(resourceId)),
    route: jest.fn(async (resourceId: string) => {
      if (local.has(resourceId)) {
        return { nodeId: 'local', address: '', port: 0, isLocal: true };
      }
      return remote.get(resourceId) ?? null;
    }),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  } as unknown as ResourceRouter;
}

function makeNopHandler(): ForwardingHandler {
  return jest.fn(async () => ({ ok: true }));
}

function makeRegistry(): MetricsRegistry {
  return new MetricsRegistry('test-node');
}

async function getServerPort(server: ForwardingServer): Promise<number> {
  const addr = (server as unknown as { server: import('http').Server }).server.address()!;
  if (typeof addr === 'string') throw new Error('unexpected string address');
  return addr.port;
}

async function get(
  port: number,
  path: string,
): Promise<{ status: number; body: string; contentType: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'GET' });
  const body = await res.text();
  return {
    status: res.status,
    body,
    contentType: res.headers.get('content-type'),
  };
}

async function httpMethod(port: number, path: string, method: string): Promise<{ status: number }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return { status: res.status };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ForwardingServer – /metrics route', () => {
  let server: ForwardingServer;

  afterEach(async () => {
    if (server?.isStarted()) {
      await server.stop();
    }
  });

  // -------------------------------------------------------------------------
  // 1. metricsRegistry set → GET /metrics returns 200 with counter value
  // -------------------------------------------------------------------------
  test('GET /metrics returns 200 with Prometheus body containing a known counter value', async () => {
    const registry = makeRegistry();
    const counter = registry.counter('http.requests.total');
    counter.inc(42);

    const router = makeRouter({});
    server = new ForwardingServer(router, makeNopHandler(), {
      port: 0,
      metricsRegistry: registry,
    });
    await server.start();
    const port = await getServerPort(server);

    const { status, body } = await get(port, '/metrics');

    expect(status).toBe(200);
    // The formatted line should contain the mangled name and value 42.
    expect(body).toContain('http_requests_total');
    expect(body).toMatch(/42/);
  });

  // -------------------------------------------------------------------------
  // 2. Content-Type is correct Prometheus media type
  // -------------------------------------------------------------------------
  test('GET /metrics Content-Type is text/plain; version=0.0.4; charset=utf-8', async () => {
    const registry = makeRegistry();
    registry.counter('dummy').inc(1);

    const router = makeRouter({});
    server = new ForwardingServer(router, makeNopHandler(), {
      port: 0,
      metricsRegistry: registry,
    });
    await server.start();
    const port = await getServerPort(server);

    const { status, contentType } = await get(port, '/metrics');

    expect(status).toBe(200);
    expect(contentType).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  // -------------------------------------------------------------------------
  // 3. metricsRegistry unset → GET /metrics returns 404
  // -------------------------------------------------------------------------
  test('GET /metrics returns 404 when metricsRegistry is not set', async () => {
    const router = makeRouter({});
    server = new ForwardingServer(router, makeNopHandler(), { port: 0 });
    await server.start();
    const port = await getServerPort(server);

    const { status } = await get(port, '/metrics');
    expect(status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // 4. Custom metricsPath works; default /metrics returns 404
  // -------------------------------------------------------------------------
  test('custom metricsPath "/stats" serves metrics; GET /metrics returns 404', async () => {
    const registry = makeRegistry();
    registry.counter('calls').inc(7);

    const router = makeRouter({});
    server = new ForwardingServer(router, makeNopHandler(), {
      port: 0,
      metricsRegistry: registry,
      metricsPath: '/stats',
    });
    await server.start();
    const port = await getServerPort(server);

    const { status: statsStatus, body } = await get(port, '/stats');
    expect(statsStatus).toBe(200);
    expect(body).toContain('calls');

    // /metrics is not the configured metricsPath, so it falls through to the
    // normal routing logic — a GET to a non-metrics path returns 405 (not POST).
    const { status: metricsStatus } = await get(port, '/metrics');
    expect(metricsStatus).toBe(405);
  });

  // -------------------------------------------------------------------------
  // 5. POST /metrics returns 405 — metrics is GET-only
  // -------------------------------------------------------------------------
  test('POST /metrics returns 405', async () => {
    const registry = makeRegistry();
    registry.counter('ping').inc(1);

    const router = makeRouter({});
    server = new ForwardingServer(router, makeNopHandler(), {
      port: 0,
      metricsRegistry: registry,
    });
    await server.start();
    const port = await getServerPort(server);

    const { status } = await httpMethod(port, '/metrics', 'POST');
    expect(status).toBe(405);
  });

  // -------------------------------------------------------------------------
  // 6. metricsFormatOptions passed through — custom bucket appears in output
  // -------------------------------------------------------------------------
  test('metricsFormatOptions histogramBuckets are passed to formatPrometheus', async () => {
    const registry = makeRegistry();
    const hist = registry.histogram('response.latency');
    // Observe a value (3 ms) that sits inside our custom bucket [1, 5] but
    // would be in a different bucket with the default set.
    hist.observe(3);

    const router = makeRouter({});
    // Provide custom buckets: [1, 5, +Inf].  The le="5" bucket must appear.
    server = new ForwardingServer(router, makeNopHandler(), {
      port: 0,
      metricsRegistry: registry,
      metricsFormatOptions: { histogramBuckets: [1, 5] },
    });
    await server.start();
    const port = await getServerPort(server);

    const { status, body } = await get(port, '/metrics');
    expect(status).toBe(200);
    // le="5" bucket should appear in the output.
    expect(body).toContain('le="5"');
    // Default buckets contain values like "0.5", "2.5", "250", etc. — none of
    // those should be present when we override with [1, 5].
    expect(body).not.toContain('le="2.5"');
    expect(body).not.toContain('le="250"');
  });

  // -------------------------------------------------------------------------
  // 7. Existing forwarding behavior unchanged when metricsRegistry is set
  // -------------------------------------------------------------------------
  test('forwarding dispatch still works when metricsRegistry is configured', async () => {
    const registry = makeRegistry();
    const router = makeRouter({ localResources: new Set(['room-1']) });
    const handler: ForwardingHandler = jest.fn(async () => ({ forwarded: true }));

    server = new ForwardingServer(router, handler, {
      port: 0,
      metricsRegistry: registry,
    });
    await server.start();
    const port = await getServerPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/forward/room-1/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ forwarded: true });
    expect(handler).toHaveBeenCalledWith('room-1', '/action', { x: 1 });
  });
});
