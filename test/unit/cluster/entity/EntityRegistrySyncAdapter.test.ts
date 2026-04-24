import { EntityRegistrySyncAdapter } from '../../../../src/cluster/entity/EntityRegistrySyncAdapter';
import { EntityRegistryFactory } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { EntityUpdate } from '../../../../src/persistence/wal/types';
import { PubSubMessageMetadata } from '../../../../src/gateway/pubsub/types';

// ---------------------------------------------------------------------------
// PubSub mock — single node
// ---------------------------------------------------------------------------

function makePubSub(localNodeId = 'node-1') {
  let handler: ((topic: string, payload: unknown, meta: PubSubMessageMetadata) => void) | null = null;
  return {
    subscribe: jest.fn((_topic: string, h: any) => {
      handler = h;
      return 'sub-1';
    }),
    unsubscribe: jest.fn(),
    publish: jest.fn().mockResolvedValue(undefined),
    deliver(payload: unknown, publisherNodeId = 'remote-node') {
      handler?.('entities', payload, {
        publisherNodeId,
        messageId: 'x',
        timestamp: Date.now(),
        topic: 'entities',
      });
    },
    _localNodeId: localNodeId,
  };
}

// ---------------------------------------------------------------------------
// Shared PubSub mock — two nodes routing to each other
// ---------------------------------------------------------------------------

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
              });
            }
          }
        },
      } as any;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EntityRegistrySyncAdapter', () => {
  const TOPIC = 'entities';

  it('start() subscribes to the configured topic', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
    const pubsub = makePubSub();

    const adapter = new EntityRegistrySyncAdapter(registry as any, pubsub as any, 'node-1', { topic: TOPIC });
    adapter.start();

    expect(pubsub.subscribe).toHaveBeenCalledTimes(1);
    expect(pubsub.subscribe).toHaveBeenCalledWith(TOPIC, expect.any(Function));

    adapter.stop();
    await registry.stop();
  });

  it('stop() unsubscribes from pubsub', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
    const pubsub = makePubSub();

    const adapter = new EntityRegistrySyncAdapter(registry as any, pubsub as any, 'node-1', { topic: TOPIC });
    adapter.start();
    adapter.stop();

    expect(pubsub.unsubscribe).toHaveBeenCalledWith('sub-1');
    await registry.stop();
  });

  it('proposeEntity → publishes a CREATE EntityUpdate with correct fields', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
    const pubsub = makePubSub();

    const adapter = new EntityRegistrySyncAdapter(registry as any, pubsub as any, 'node-1', { topic: TOPIC });
    adapter.start();

    await registry.proposeEntity('entity-1', { region: 'us-east-1' });
    await new Promise((r) => setImmediate(r));

    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    const [topic, payload] = pubsub.publish.mock.calls[0] as [string, EntityUpdate];
    expect(topic).toBe(TOPIC);
    expect(payload.entityId).toBe('entity-1');
    expect(payload.operation).toBe('CREATE');
    expect(payload.ownerNodeId).toBe('node-1');
    expect(payload.version).toBe(1);

    adapter.stop();
    await registry.stop();
  });

  it('releaseEntity → publishes a DELETE EntityUpdate', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
    const pubsub = makePubSub();

    const adapter = new EntityRegistrySyncAdapter(registry as any, pubsub as any, 'node-1', { topic: TOPIC });
    adapter.start();

    await registry.proposeEntity('entity-2');
    pubsub.publish.mockClear();

    await registry.releaseEntity('entity-2');
    await new Promise((r) => setImmediate(r));

    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    const [topic, payload] = pubsub.publish.mock.calls[0] as [string, EntityUpdate];
    expect(topic).toBe(TOPIC);
    expect(payload.entityId).toBe('entity-2');
    expect(payload.operation).toBe('DELETE');

    adapter.stop();
    await registry.stop();
  });

  it('transferEntity → publishes a TRANSFER EntityUpdate', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
    const pubsub = makePubSub();

    const adapter = new EntityRegistrySyncAdapter(registry as any, pubsub as any, 'node-1', { topic: TOPIC });
    adapter.start();

    await registry.proposeEntity('entity-3');
    pubsub.publish.mockClear();

    await registry.transferEntity('entity-3', 'node-2');
    await new Promise((r) => setImmediate(r));

    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    const [topic, payload] = pubsub.publish.mock.calls[0] as [string, EntityUpdate];
    expect(topic).toBe(TOPIC);
    expect(payload.entityId).toBe('entity-3');
    expect(payload.operation).toBe('TRANSFER');
    expect(payload.ownerNodeId).toBe('node-2');

    adapter.stop();
    await registry.stop();
  });

  it('updateEntity → publishes an UPDATE EntityUpdate', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
    const pubsub = makePubSub();

    const adapter = new EntityRegistrySyncAdapter(registry as any, pubsub as any, 'node-1', { topic: TOPIC });
    adapter.start();

    await registry.proposeEntity('entity-4');
    pubsub.publish.mockClear();

    await registry.updateEntity('entity-4', { color: 'blue' });
    await new Promise((r) => setImmediate(r));

    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    const [topic, payload] = pubsub.publish.mock.calls[0] as [string, EntityUpdate];
    expect(topic).toBe(TOPIC);
    expect(payload.entityId).toBe('entity-4');
    expect(payload.operation).toBe('UPDATE');

    adapter.stop();
    await registry.stop();
  });

  it('remote pubsub message → applyRemoteUpdate is called (visible via getEntityHost)', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
    const pubsub = makePubSub();

    const adapter = new EntityRegistrySyncAdapter(registry as any, pubsub as any, 'node-1', { topic: TOPIC });
    adapter.start();

    const update: EntityUpdate = {
      entityId: 'remote-entity',
      ownerNodeId: 'node-2',
      version: 1,
      timestamp: Date.now(),
      operation: 'CREATE',
      metadata: {},
    };

    pubsub.deliver(update, 'node-2');
    await new Promise((r) => setImmediate(r));

    expect(registry.getEntityHost('remote-entity')).toBe('node-2');

    adapter.stop();
    await registry.stop();
  });

  it('own pubsub message (same publisherNodeId) is NOT applied (loop prevention)', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
    const pubsub = makePubSub('node-1');

    const spy = jest.spyOn(registry, 'applyRemoteUpdate');

    const adapter = new EntityRegistrySyncAdapter(registry as any, pubsub as any, 'node-1', { topic: TOPIC });
    adapter.start();

    const update: EntityUpdate = {
      entityId: 'self-entity',
      ownerNodeId: 'node-1',
      version: 1,
      timestamp: Date.now(),
      operation: 'CREATE',
    };

    pubsub.deliver(update, 'node-1');
    await new Promise((r) => setImmediate(r));

    expect(spy).not.toHaveBeenCalled();

    adapter.stop();
    await registry.stop();
  });

  it('after stop(), further local events do not publish', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
    const pubsub = makePubSub();

    const adapter = new EntityRegistrySyncAdapter(registry as any, pubsub as any, 'node-1', { topic: TOPIC });
    adapter.start();
    adapter.stop();

    pubsub.publish.mockClear();

    await registry.proposeEntity('entity-after-stop');
    await new Promise((r) => setImmediate(r));

    expect(pubsub.publish).not.toHaveBeenCalled();
    await registry.stop();
  });

  it('after stop(), further pubsub deliveries do not apply', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
    const pubsub = makePubSub();

    const spy = jest.spyOn(registry, 'applyRemoteUpdate');

    const adapter = new EntityRegistrySyncAdapter(registry as any, pubsub as any, 'node-1', { topic: TOPIC });
    adapter.start();
    adapter.stop();

    const update: EntityUpdate = {
      entityId: 'stopped-entity',
      ownerNodeId: 'node-2',
      version: 1,
      timestamp: Date.now(),
      operation: 'CREATE',
    };

    pubsub.deliver(update, 'node-2');
    await new Promise((r) => setImmediate(r));

    expect(spy).not.toHaveBeenCalled();
    await registry.stop();
  });

  it('onPublish callback fires on local events', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
    const pubsub = makePubSub();
    const onPublish = jest.fn();

    const adapter = new EntityRegistrySyncAdapter(registry as any, pubsub as any, 'node-1', {
      topic: TOPIC,
      onPublish,
    });
    adapter.start();

    await registry.proposeEntity('entity-cb');
    await new Promise((r) => setImmediate(r));

    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0][0]).toMatchObject({ entityId: 'entity-cb', operation: 'CREATE' });

    adapter.stop();
    await registry.stop();
  });

  it('onReceive callback fires on remote deliveries', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
    const pubsub = makePubSub();
    const onReceive = jest.fn();

    const adapter = new EntityRegistrySyncAdapter(registry as any, pubsub as any, 'node-1', {
      topic: TOPIC,
      onReceive,
    });
    adapter.start();

    const update: EntityUpdate = {
      entityId: 'rcv-entity',
      ownerNodeId: 'node-2',
      version: 1,
      timestamp: Date.now(),
      operation: 'CREATE',
    };

    pubsub.deliver(update, 'node-2');
    await new Promise((r) => setImmediate(r));

    expect(onReceive).toHaveBeenCalledTimes(1);
    expect(onReceive.mock.calls[0][0]).toMatchObject({ entityId: 'rcv-entity', operation: 'CREATE' });

    adapter.stop();
    await registry.stop();
  });

  it('integration: claim on registry A propagates to registry B', async () => {
    const sharedPubSub = makeSharedPubSub();

    const registryA = EntityRegistryFactory.createMemory('node-a', { enableTestMode: true });
    const registryB = EntityRegistryFactory.createMemory('node-b', { enableTestMode: true });

    await registryA.start();
    await registryB.start();

    const pubsubA = sharedPubSub.bind('node-a');
    const pubsubB = sharedPubSub.bind('node-b');

    const adapterA = new EntityRegistrySyncAdapter(registryA as any, pubsubA, 'node-a', { topic: TOPIC });
    const adapterB = new EntityRegistrySyncAdapter(registryB as any, pubsubB, 'node-b', { topic: TOPIC });

    adapterA.start();
    adapterB.start();

    await registryA.proposeEntity('shared-entity', { source: 'node-a' });

    await new Promise((r) => setImmediate(r));

    expect(registryB.getEntityHost('shared-entity')).toBe('node-a');

    adapterA.stop();
    adapterB.stop();
    await registryA.stop();
    await registryB.stop();
  });
});
