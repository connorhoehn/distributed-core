import { LifecycleAware } from '../../../src/common/LifecycleAware';
import { EntityRegistrySyncAdapter } from '../../../src/cluster/entity/EntityRegistrySyncAdapter';
import { EntityRegistryFactory } from '../../../src/cluster/entity/EntityRegistryFactory';
import { PubSubMessageMetadata } from '../../../src/gateway/pubsub/types';

function makePubSub() {
  return {
    subscribe: jest.fn(() => 'sub-1'),
    unsubscribe: jest.fn(),
    publish: jest.fn().mockResolvedValue(undefined),
  };
}

function makeAdapter() {
  const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
  const pubsub = makePubSub() as any;
  return new EntityRegistrySyncAdapter(registry, pubsub, 'node-1', {
    topic: 'test-topic',
  });
}

describe('LifecycleAware interface — EntityRegistrySyncAdapter', () => {
  it('type-checks as LifecycleAware', () => {
    const adapter = makeAdapter();
    const lc: LifecycleAware = adapter;
    expect(typeof lc.start).toBe('function');
    expect(typeof lc.stop).toBe('function');
    expect(typeof lc.isStarted).toBe('function');
  });

  it('isStarted() returns false before start()', () => {
    const adapter = makeAdapter();
    expect(adapter.isStarted()).toBe(false);
  });

  it('isStarted() returns true after start()', async () => {
    const adapter = makeAdapter();
    await adapter.start();
    expect(adapter.isStarted()).toBe(true);
    await adapter.stop();
  });

  it('isStarted() returns false after stop()', async () => {
    const adapter = makeAdapter();
    await adapter.start();
    await adapter.stop();
    expect(adapter.isStarted()).toBe(false);
  });

  it('start() is idempotent — calling twice is a no-op', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    const pubsub = makePubSub() as any;
    const adapter = new EntityRegistrySyncAdapter(registry, pubsub, 'node-1', {
      topic: 'test-topic',
    });

    await adapter.start();
    await adapter.start();

    expect(pubsub.subscribe).toHaveBeenCalledTimes(1);
    expect(adapter.isStarted()).toBe(true);
    await adapter.stop();
  });

  it('stop() is idempotent — calling twice is a no-op', async () => {
    const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    const pubsub = makePubSub() as any;
    const adapter = new EntityRegistrySyncAdapter(registry, pubsub, 'node-1', {
      topic: 'test-topic',
    });

    await adapter.start();
    await adapter.stop();
    await adapter.stop();

    expect(pubsub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(adapter.isStarted()).toBe(false);
  });

  it('stop() before start() is a no-op', async () => {
    const adapter = makeAdapter();
    await expect(adapter.stop()).resolves.toBeUndefined();
    expect(adapter.isStarted()).toBe(false);
  });
});
