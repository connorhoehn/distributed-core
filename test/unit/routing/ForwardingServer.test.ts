import { EventEmitter } from 'events';
import { ForwardingServer } from '../../../src/routing/ForwardingServer';
import { ForwardingHandler } from '../../../src/routing/ForwardingServer';
import { ResourceRouter } from '../../../src/routing/ResourceRouter';
import { RouteTarget } from '../../../src/routing/types';

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

async function getServerPort(server: ForwardingServer): Promise<number> {
  const addr = (server as unknown as { server: import('http').Server }).server.address()!;
  if (typeof addr === 'string') throw new Error('unexpected string address');
  return addr.port;
}

async function post(port: number, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let responseBody: unknown;
  try {
    responseBody = await res.json();
  } catch {
    responseBody = null;
  }
  return { status: res.status, body: responseBody };
}

async function request(port: number, path: string, method: string): Promise<{ status: number }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return { status: res.status };
}

describe('ForwardingServer', () => {
  let server: ForwardingServer;

  afterEach(async () => {
    if (server?.isStarted()) {
      await server.stop();
    }
  });

  test('POST to locally-owned resource returns 200 with handler response', async () => {
    const router = makeRouter({ localResources: new Set(['room-42']) });
    const handler: ForwardingHandler = jest.fn(async () => ({ joined: true }));
    server = new ForwardingServer(router, handler, { port: 0 });
    await server.start();
    const port = await getServerPort(server);

    const { status, body } = await post(port, '/forward/room-42/join', { user: 'alice' });

    expect(status).toBe(200);
    expect(body).toEqual({ joined: true });
    expect(handler).toHaveBeenCalledWith('room-42', '/join', { user: 'alice' });
  });

  test('POST to locally-owned resource with no remainder path', async () => {
    const router = makeRouter({ localResources: new Set(['res-1']) });
    const handler: ForwardingHandler = jest.fn(async () => ({ ok: true }));
    server = new ForwardingServer(router, handler, { port: 0 });
    await server.start();
    const port = await getServerPort(server);

    const { status } = await post(port, '/forward/res-1', { data: 1 });
    expect(status).toBe(200);
    expect(handler).toHaveBeenCalledWith('res-1', '', { data: 1 });
  });

  test('POST to resource owned by another node returns 421 with owner', async () => {
    const remoteTarget: RouteTarget = { nodeId: 'node-3', address: '10.0.0.3', port: 9000, isLocal: false };
    const router = makeRouter({ remoteRoutes: new Map([['room-99', remoteTarget]]) });
    const handler: ForwardingHandler = jest.fn(async () => ({}));
    server = new ForwardingServer(router, handler, { port: 0 });
    await server.start();
    const port = await getServerPort(server);

    const { status, body } = await post(port, '/forward/room-99/action', {});

    expect(status).toBe(421);
    expect(body).toEqual({ owner: { address: '10.0.0.3', port: 9000 } });
    expect(handler).not.toHaveBeenCalled();
  });

  test('POST to unknown resource returns 404', async () => {
    const router = makeRouter({});
    const handler: ForwardingHandler = jest.fn(async () => ({}));
    server = new ForwardingServer(router, handler, { port: 0 });
    await server.start();
    const port = await getServerPort(server);

    const { status } = await post(port, '/forward/unknown-res', {});
    expect(status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  test('non-POST method returns 405', async () => {
    const router = makeRouter({ localResources: new Set(['res-1']) });
    const handler: ForwardingHandler = jest.fn(async () => ({}));
    server = new ForwardingServer(router, handler, { port: 0 });
    await server.start();
    const port = await getServerPort(server);

    const { status } = await request(port, '/forward/res-1', 'GET');
    expect(status).toBe(405);

    const { status: deleteStatus } = await request(port, '/forward/res-1', 'DELETE');
    expect(deleteStatus).toBe(405);
  });

  test('malformed JSON body returns 400', async () => {
    const router = makeRouter({ localResources: new Set(['res-1']) });
    const handler: ForwardingHandler = jest.fn(async () => ({}));
    server = new ForwardingServer(router, handler, { port: 0 });
    await server.start();
    const port = await getServerPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/forward/res-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ bad json',
    });
    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  test('handler throws returns 500 with error message', async () => {
    const router = makeRouter({ localResources: new Set(['res-1']) });
    const handler: ForwardingHandler = jest.fn(async () => {
      throw new Error('something went wrong');
    });
    server = new ForwardingServer(router, handler, { port: 0 });
    await server.start();
    const port = await getServerPort(server);

    const { status, body } = await post(port, '/forward/res-1/action', {});
    expect(status).toBe(500);
    expect((body as { error: string }).error).toBe('something went wrong');
  });

  test('stop() closes port; subsequent requests fail to connect', async () => {
    const router = makeRouter({ localResources: new Set(['res-1']) });
    const handler: ForwardingHandler = jest.fn(async () => ({}));
    server = new ForwardingServer(router, handler, { port: 0 });
    await server.start();
    const port = await getServerPort(server);

    await server.stop();
    expect(server.isStarted()).toBe(false);

    await expect(
      fetch(`http://127.0.0.1:${port}/forward/res-1`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
    ).rejects.toThrow();
  });

  test('custom pathPrefix is respected', async () => {
    const router = makeRouter({ localResources: new Set(['res-1']) });
    const handler: ForwardingHandler = jest.fn(async () => ({ custom: true }));
    server = new ForwardingServer(router, handler, { port: 0, pathPrefix: '/api/v1/fwd' });
    await server.start();
    const port = await getServerPort(server);

    const { status } = await post(port, '/api/v1/fwd/res-1/action', {});
    expect(status).toBe(200);

    const { status: notFound } = await post(port, '/forward/res-1/action', {});
    expect(notFound).toBe(404);
  });
});
