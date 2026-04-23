import { EventEmitter } from 'events';
import { ResourceRouter } from '../../../src/routing/ResourceRouter';
import { ResourceRouterSyncAdapter } from '../../../src/routing/ResourceRouterSyncAdapter';
import { EntityRegistryFactory } from '../../../src/cluster/entity/EntityRegistryFactory';
import { MembershipEntry } from '../../../src/cluster/types';
import { EntityUpdate } from '../../../src/persistence/wal/types';
import { PubSubMessageMetadata } from '../../../src/gateway/pubsub/types';

// ---------------------------------------------------------------------------
// Minimal ClusterManager stub
// ---------------------------------------------------------------------------

function makeCluster(
  localNodeId: string,
  peers: { id: string; address: string; port: number }[] = [],
) {
  const emitter = new EventEmitter();
  const membership = new Map<string, MembershipEntry>();

  membership.set(localNodeId, {
    id: localNodeId,
    status: 'ALIVE',
    lastSeen: Date.now(),
    version: 1,
    lastUpdated: Date.now(),
    metadata: { address: '127.0.0.1', port: 7000 },
  } as MembershipEntry);

  for (const peer of peers) {
    membership.set(peer.id, {
      id: peer.id,
      status: 'ALIVE',
      lastSeen: Date.now(),
      version: 1,
      lastUpdated: Date.now(),
      metadata: { address: peer.address, port: peer.port },
    } as MembershipEntry);
  }

  return {
    getMembership: () => membership,
    getLocalNodeInfo: () => ({ id: localNodeId, status: 'ALIVE', lastSeen: Date.now(), version: 1 }),
    on: (event: string, handler: (...args: any[]) => void) => emitter.on(event, handler),
    off: (event: string, handler: (...args: any[]) => void) => emitter.off(event, handler),
    emit: (event: string, ...args: any[]) => emitter.emit(event, ...args),
  };
}

// ---------------------------------------------------------------------------
// Minimal PubSubManager mock
// ---------------------------------------------------------------------------

function makePubSub() {
  let handler: ((topic: string, payload: unknown, meta: PubSubMessageMetadata) => void) | null = null;
  return {
    subscribe: jest.fn((topic: string, h: any) => {
      handler = h;
      return 'sub-1';
    }),
    unsubscribe: jest.fn(),
    publish: jest.fn().mockResolvedValue(undefined),
    deliver: (payload: unknown, publisherNodeId: string) => {
      handler?.('resource-router:updates', payload, {
        publisherNodeId,
        messageId: '1',
        timestamp: Date.now(),
        topic: 'resource-router:updates',
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const activeRouters: ResourceRouter[] = [];

async function makeRouter(
  nodeId = 'node-1',
  peers: { id: string; address: string; port: number }[] = [],
) {
  const cluster = makeCluster(nodeId, peers);
  const registry = EntityRegistryFactory.createMemory(nodeId, { enableTestMode: true });
  const router = new ResourceRouter(nodeId, registry, cluster as any);
  await router.start();
  activeRouters.push(router);
  return { router, cluster };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResourceRouterSyncAdapter', () => {
  afterEach(async () => {
    for (const r of activeRouters.splice(0)) {
      await r.stop();
    }
  });

  it('start() subscribes to the default topic on pubsub', async () => {
    const { router } = await makeRouter();
    const pubsub = makePubSub();

    const adapter = new ResourceRouterSyncAdapter(router, pubsub as any, 'node-1');
    adapter.start();

    expect(pubsub.subscribe).toHaveBeenCalledTimes(1);
    expect(pubsub.subscribe).toHaveBeenCalledWith('resource-router:updates', expect.any(Function));

    adapter.stop();
  });

  it('stop() unsubscribes from pubsub', async () => {
    const { router } = await makeRouter();
    const pubsub = makePubSub();

    const adapter = new ResourceRouterSyncAdapter(router, pubsub as any, 'node-1');
    adapter.start();
    adapter.stop();

    expect(pubsub.unsubscribe).toHaveBeenCalledWith('sub-1');
  });

  it('local claim() publishes a CREATE EntityUpdate', async () => {
    const { router } = await makeRouter('node-1');
    const pubsub = makePubSub();

    const adapter = new ResourceRouterSyncAdapter(router, pubsub as any, 'node-1');
    adapter.start();

    await router.claim('room-1', { metadata: { region: 'us-east-1' } });

    await new Promise((r) => setImmediate(r));

    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    const [topic, payload] = pubsub.publish.mock.calls[0] as [string, EntityUpdate];
    expect(topic).toBe('resource-router:updates');
    expect(payload.entityId).toBe('room-1');
    expect(payload.operation).toBe('CREATE');
    expect(payload.ownerNodeId).toBe('node-1');

    adapter.stop();
  });

  it('local release() publishes a DELETE EntityUpdate', async () => {
    const { router } = await makeRouter('node-1');
    const pubsub = makePubSub();

    const adapter = new ResourceRouterSyncAdapter(router, pubsub as any, 'node-1');
    adapter.start();

    await router.claim('room-2');
    pubsub.publish.mockClear();

    await router.release('room-2');

    await new Promise((r) => setImmediate(r));

    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    const [topic, payload] = pubsub.publish.mock.calls[0] as [string, EntityUpdate];
    expect(topic).toBe('resource-router:updates');
    expect(payload.entityId).toBe('room-2');
    expect(payload.operation).toBe('DELETE');

    adapter.stop();
  });

  it('local transfer() publishes a TRANSFER EntityUpdate', async () => {
    const { router } = await makeRouter('node-1', [
      { id: 'node-2', address: '10.0.0.2', port: 7001 },
    ]);
    const pubsub = makePubSub();

    const adapter = new ResourceRouterSyncAdapter(router, pubsub as any, 'node-1');
    adapter.start();

    await router.claim('room-3');
    pubsub.publish.mockClear();

    await router.transfer('room-3', 'node-2');

    await new Promise((r) => setImmediate(r));

    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    const [topic, payload] = pubsub.publish.mock.calls[0] as [string, EntityUpdate];
    expect(topic).toBe('resource-router:updates');
    expect(payload.entityId).toBe('room-3');
    expect(payload.operation).toBe('TRANSFER');
    expect(payload.ownerNodeId).toBe('node-2');

    adapter.stop();
  });

  it('remote message (publisherNodeId ≠ localNodeId) calls applyRemoteUpdate()', async () => {
    const { router } = await makeRouter('node-1');
    const pubsub = makePubSub();

    const spy = jest.spyOn(router, 'applyRemoteUpdate');

    const adapter = new ResourceRouterSyncAdapter(router, pubsub as any, 'node-1');
    adapter.start();

    const update: EntityUpdate = {
      entityId: 'room-remote',
      ownerNodeId: 'node-2',
      version: 1,
      timestamp: Date.now(),
      operation: 'CREATE',
      metadata: {},
    };

    pubsub.deliver(update, 'node-2');

    await new Promise((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledWith(update);

    adapter.stop();
  });

  it('own message (publisherNodeId === localNodeId) does NOT call applyRemoteUpdate()', async () => {
    const { router } = await makeRouter('node-1');
    const pubsub = makePubSub();

    const spy = jest.spyOn(router, 'applyRemoteUpdate');

    const adapter = new ResourceRouterSyncAdapter(router, pubsub as any, 'node-1');
    adapter.start();

    const update: EntityUpdate = {
      entityId: 'room-self',
      ownerNodeId: 'node-1',
      version: 1,
      timestamp: Date.now(),
      operation: 'CREATE',
      metadata: {},
    };

    pubsub.deliver(update, 'node-1');

    await new Promise((r) => setImmediate(r));

    expect(spy).not.toHaveBeenCalled();

    adapter.stop();
  });

  it('stop() prevents further publishing after being called', async () => {
    const { router } = await makeRouter('node-1');
    const pubsub = makePubSub();

    const adapter = new ResourceRouterSyncAdapter(router, pubsub as any, 'node-1');
    adapter.start();
    adapter.stop();

    pubsub.publish.mockClear();

    await router.claim('room-after-stop');

    await new Promise((r) => setImmediate(r));

    expect(pubsub.publish).not.toHaveBeenCalled();
  });

  it('stop() prevents applyRemoteUpdate from being called via pubsub messages', async () => {
    const { router } = await makeRouter('node-1');
    const pubsub = makePubSub();

    const spy = jest.spyOn(router, 'applyRemoteUpdate');

    const adapter = new ResourceRouterSyncAdapter(router, pubsub as any, 'node-1');
    adapter.start();
    adapter.stop();

    const update: EntityUpdate = {
      entityId: 'room-stopped',
      ownerNodeId: 'node-2',
      version: 1,
      timestamp: Date.now(),
      operation: 'CREATE',
      metadata: {},
    };

    pubsub.deliver(update, 'node-2');

    await new Promise((r) => setImmediate(r));

    expect(spy).not.toHaveBeenCalled();
  });

  it('custom topic in config is used instead of default', async () => {
    const { router } = await makeRouter('node-1');
    const pubsub = makePubSub();

    const adapter = new ResourceRouterSyncAdapter(router, pubsub as any, 'node-1', {
      topic: 'my-custom-topic',
    });
    adapter.start();

    expect(pubsub.subscribe).toHaveBeenCalledWith('my-custom-topic', expect.any(Function));

    await router.claim('room-custom');

    await new Promise((r) => setImmediate(r));

    expect(pubsub.publish).toHaveBeenCalledWith('my-custom-topic', expect.objectContaining({ entityId: 'room-custom' }));

    adapter.stop();
  });
});
