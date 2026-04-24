import { ServiceRegistry, UnknownServiceError } from '../../../../src/cluster/discovery/ServiceRegistry';
import { EntityRegistryFactory } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { EntityRegistrySyncAdapter } from '../../../../src/cluster/entity/EntityRegistrySyncAdapter';
import { PubSubMessageMetadata } from '../../../../src/gateway/pubsub/types';

function makeRegistry(nodeId: string) {
  return EntityRegistryFactory.createMemory(nodeId, { enableTestMode: true });
}

function makeSharedPubSub() {
  const subs: Array<{ nodeId: string; handler: any; topic: string }> = [];
  return {
    bind(nodeId: string) {
      return {
        subscribe: (topic: string, h: any) => {
          const id = `${nodeId}-${subs.length}`;
          subs.push({ nodeId, handler: h, topic });
          return id;
        },
        unsubscribe: jest.fn(),
        publish: async (topic: string, payload: unknown) => {
          for (const s of subs) {
            if (s.topic === topic) {
              s.handler(topic, payload, {
                publisherNodeId: nodeId,
                messageId: 'x',
                timestamp: Date.now(),
                topic,
              } as PubSubMessageMetadata);
            }
          }
        },
      } as any;
    },
  };
}

describe('ServiceRegistry', () => {
  let entityRegistry: ReturnType<typeof makeRegistry>;
  let sr: ServiceRegistry;

  beforeEach(async () => {
    entityRegistry = makeRegistry('node-1');
    await entityRegistry.start();
    sr = new ServiceRegistry(entityRegistry as any, { localNodeId: 'node-1' });
    await sr.start();
  });

  afterEach(async () => {
    await sr.stop();
    await entityRegistry.stop();
  });

  // 1. register() returns an endpoint with correct fields
  it('register() returns endpoint with correct fields', async () => {
    const ep = await sr.register('video-transcoder', '10.0.0.1', 8080, { region: 'us-east-1' });

    expect(ep.serviceName).toBe('video-transcoder');
    expect(ep.address).toBe('10.0.0.1');
    expect(ep.port).toBe(8080);
    expect(ep.nodeId).toBe('node-1');
    expect(ep.metadata).toEqual({ region: 'us-east-1' });
    expect(typeof ep.endpointId).toBe('string');
    expect(ep.endpointId.length).toBeGreaterThan(0);
    expect(typeof ep.registeredAt).toBe('number');
  });

  // 2. find() returns registered endpoints for the service
  it('find() returns endpoints after register()', async () => {
    await sr.register('video-transcoder', '10.0.0.1', 8080);
    await sr.register('video-transcoder', '10.0.0.2', 8081);

    const found = sr.find('video-transcoder');
    expect(found).toHaveLength(2);
    expect(found.every((e) => e.serviceName === 'video-transcoder')).toBe(true);
  });

  // 3. find() returns empty for unknown services
  it('find() returns empty array for unknown service', () => {
    expect(sr.find('unknown-service')).toEqual([]);
  });

  // 4. unregister() removes endpoint; subsequent find() omits it; returns true
  it('unregister() removes endpoint and returns true', async () => {
    const ep = await sr.register('video-transcoder', '10.0.0.1', 8080);
    const result = await sr.unregister(ep.endpointId);

    expect(result).toBe(true);
    expect(sr.find('video-transcoder')).toHaveLength(0);
  });

  // 5. unregister() for unknown endpointId returns false
  it('unregister() returns false for unknown endpointId', async () => {
    const result = await sr.unregister('service:nonexistent-id');
    expect(result).toBe(false);
  });

  // 6. unregisterAll('serviceName') removes only that service's endpoints
  it('unregisterAll(serviceName) removes only that service endpoints owned by this node', async () => {
    await sr.register('video-transcoder', '10.0.0.1', 8080);
    await sr.register('video-transcoder', '10.0.0.2', 8081);
    await sr.register('audio-transcoder', '10.0.0.3', 9090);

    const removed = await sr.unregisterAll('video-transcoder');

    expect(removed).toBe(2);
    expect(sr.find('video-transcoder')).toHaveLength(0);
    expect(sr.find('audio-transcoder')).toHaveLength(1);
  });

  // 7. unregisterAll() with no arg removes ALL local endpoints
  it('unregisterAll() removes all local endpoints', async () => {
    await sr.register('video-transcoder', '10.0.0.1', 8080);
    await sr.register('audio-transcoder', '10.0.0.2', 9090);

    const removed = await sr.unregisterAll();

    expect(removed).toBe(2);
    expect(sr.find('video-transcoder')).toHaveLength(0);
    expect(sr.find('audio-transcoder')).toHaveLength(0);
  });

  // 8. selectOne round-robin rotates through endpoints
  it('selectOne round-robin rotates through endpoints', async () => {
    const ep1 = await sr.register('svc', '10.0.0.1', 1111);
    const ep2 = await sr.register('svc', '10.0.0.2', 2222);
    const ep3 = await sr.register('svc', '10.0.0.3', 3333);

    const ids = [
      sr.selectOne('svc', 'round-robin').endpointId,
      sr.selectOne('svc', 'round-robin').endpointId,
      sr.selectOne('svc', 'round-robin').endpointId,
      sr.selectOne('svc', 'round-robin').endpointId,
    ];

    expect(ids[0]).toBe(ep1.endpointId);
    expect(ids[1]).toBe(ep2.endpointId);
    expect(ids[2]).toBe(ep3.endpointId);
    expect(ids[3]).toBe(ep1.endpointId);
  });

  // 9. selectOne local-preferred returns local endpoint first
  it('selectOne local-preferred returns local endpoint when available', async () => {
    // Inject a remote endpoint directly via applyRemoteUpdate
    await entityRegistry.applyRemoteUpdate({
      entityId: 'service:node-2-svc-remote',
      ownerNodeId: 'node-2',
      version: 1,
      timestamp: Date.now(),
      operation: 'CREATE',
      metadata: { serviceName: 'svc', address: '10.0.0.2', port: 2222, userMetadata: {} },
    });

    const localEp = await sr.register('svc', '10.0.0.1', 1111);

    const selected = sr.selectOne('svc', 'local-preferred');
    expect(selected.endpointId).toBe(localEp.endpointId);
    expect(selected.nodeId).toBe('node-1');
  });

  // 10. selectOne throws UnknownServiceError when no endpoints match
  it('selectOne throws UnknownServiceError when no endpoints', () => {
    expect(() => sr.selectOne('nonexistent')).toThrow(UnknownServiceError);
    expect(() => sr.selectOne('nonexistent')).toThrow('No endpoints registered for service "nonexistent"');
  });

  // 11. aliveNodeIds getter filters out endpoints on non-alive nodes
  it('aliveNodeIds filters out dead node endpoints', async () => {
    const aliveSet = new Set(['node-1']);
    const srWithAlive = new ServiceRegistry(entityRegistry as any, {
      localNodeId: 'node-1',
      aliveNodeIds: () => aliveSet,
    });
    await srWithAlive.start();

    // node-1 local endpoint
    await srWithAlive.register('svc', '10.0.0.1', 1111);

    // Inject remote endpoint from dead node-2
    await entityRegistry.applyRemoteUpdate({
      entityId: 'service:node-2-svc-dead',
      ownerNodeId: 'node-2',
      version: 1,
      timestamp: Date.now(),
      operation: 'CREATE',
      metadata: { serviceName: 'svc', address: '10.0.0.2', port: 2222, userMetadata: {} },
    });

    const found = srWithAlive.find('svc');
    expect(found).toHaveLength(1);
    expect(found[0].nodeId).toBe('node-1');

    const foundWithDead = srWithAlive.find('svc', { includeDead: true });
    expect(foundWithDead).toHaveLength(2);

    await srWithAlive.stop();
  });

  // 12. listServices() includes services with at least one live endpoint
  it('listServices() returns names of all registered services', async () => {
    await sr.register('service-a', '10.0.0.1', 1111);
    await sr.register('service-b', '10.0.0.2', 2222);
    await sr.register('service-a', '10.0.0.3', 3333);

    const services = sr.listServices();
    expect(services).toHaveLength(2);
    expect(services).toContain('service-a');
    expect(services).toContain('service-b');
  });

  // 13. getLocalEndpoints() only returns endpoints this node registered
  it('getLocalEndpoints() only returns local node endpoints', async () => {
    await sr.register('svc', '10.0.0.1', 1111);

    await entityRegistry.applyRemoteUpdate({
      entityId: 'service:node-2-svc-remote2',
      ownerNodeId: 'node-2',
      version: 1,
      timestamp: Date.now(),
      operation: 'CREATE',
      metadata: { serviceName: 'svc', address: '10.0.0.2', port: 2222, userMetadata: {} },
    });

    const local = sr.getLocalEndpoints();
    expect(local).toHaveLength(1);
    expect(local[0].nodeId).toBe('node-1');
  });

  // 14. service:registered and service:unregistered events fire
  it('emits service:registered on register and service:unregistered on unregister', async () => {
    const registered: any[] = [];
    const unregistered: any[] = [];

    sr.on('service:registered', (ep) => registered.push(ep));
    sr.on('service:unregistered', (id, name) => unregistered.push({ id, name }));

    const ep = await sr.register('svc', '10.0.0.1', 1111);
    await sr.unregister(ep.endpointId);

    expect(registered).toHaveLength(1);
    expect(registered[0].serviceName).toBe('svc');
    expect(unregistered).toHaveLength(1);
    expect(unregistered[0].id).toBe(ep.endpointId);
    expect(unregistered[0].name).toBe('svc');
  });

  // 15. LifecycleAware: isStarted, idempotent start/stop
  it('isStarted correctness and idempotent start/stop', async () => {
    const reg = makeRegistry('node-x');
    await reg.start();
    const s = new ServiceRegistry(reg as any, { localNodeId: 'node-x' });

    expect(s.isStarted()).toBe(false);
    await s.start();
    expect(s.isStarted()).toBe(true);
    await s.start();
    expect(s.isStarted()).toBe(true);
    await s.stop();
    expect(s.isStarted()).toBe(false);
    await s.stop();
    expect(s.isStarted()).toBe(false);

    await reg.stop();
  });

  // 16. Cross-node: register on A, observe on B after sync
  it('cross-node: register on node-A visible via find() on node-B after sync', async () => {
    const sharedPubSub = makeSharedPubSub();

    const regA = makeRegistry('node-a');
    const regB = makeRegistry('node-b');
    await regA.start();
    await regB.start();

    const pubsubA = sharedPubSub.bind('node-a');
    const pubsubB = sharedPubSub.bind('node-b');

    const adapterA = new EntityRegistrySyncAdapter(regA as any, pubsubA, 'node-a', { topic: 'entities' });
    const adapterB = new EntityRegistrySyncAdapter(regB as any, pubsubB, 'node-b', { topic: 'entities' });
    adapterA.start();
    adapterB.start();

    const srA = new ServiceRegistry(regA as any, { localNodeId: 'node-a' });
    const srB = new ServiceRegistry(regB as any, { localNodeId: 'node-b' });
    await srA.start();
    await srB.start();

    await srA.register('shared-svc', '10.0.0.1', 8080);
    await new Promise((r) => setImmediate(r));

    const found = srB.find('shared-svc');
    expect(found).toHaveLength(1);
    expect(found[0].serviceName).toBe('shared-svc');
    expect(found[0].nodeId).toBe('node-a');

    await srA.stop();
    await srB.stop();
    adapterA.stop();
    adapterB.stop();
    await regA.stop();
    await regB.stop();
  });

  // getStats()
  it('getStats() returns correct counts', async () => {
    await sr.register('svc-x', '10.0.0.1', 1111);
    await sr.register('svc-x', '10.0.0.2', 2222);
    await sr.register('svc-y', '10.0.0.3', 3333);

    const stats = sr.getStats();
    expect(stats.services).toBe(2);
    expect(stats.endpoints).toBe(3);
    expect(stats.localEndpoints).toBe(3);
  });
});
