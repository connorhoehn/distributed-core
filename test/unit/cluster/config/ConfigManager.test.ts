import { ConfigManager, ConfigValidationError, UnknownConfigKeyError, ConfigChangeEvent } from '../../../../src/cluster/config/ConfigManager';
import { EntityRegistryFactory } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { EntityRegistrySyncAdapter } from '../../../../src/cluster/entity/EntityRegistrySyncAdapter';
import { PubSubMessageMetadata } from '../../../../src/gateway/pubsub/types';

function makeRegistry(nodeId: string) {
  return EntityRegistryFactory.createMemory(nodeId, { enableTestMode: true });
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number';
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

describe('ConfigManager', () => {
  let registry: ReturnType<typeof makeRegistry>;
  let manager: ConfigManager;

  beforeEach(async () => {
    registry = makeRegistry('node-1');
    await registry.start();
    manager = new ConfigManager(registry, { localNodeId: 'node-1' });
    await manager.start();
  });

  afterEach(async () => {
    await manager.stop();
    await registry.stop();
  });

  it('register() then get() returns the default value', () => {
    manager.register({ key: 'timeout', defaultValue: 5000, validator: isNumber });
    expect(manager.get('timeout')).toBe(5000);
  });

  it('set() then get() returns the set value', async () => {
    manager.register({ key: 'timeout', defaultValue: 5000, validator: isNumber });
    await manager.set('timeout', 9000);
    expect(manager.get('timeout')).toBe(9000);
  });

  it('set() with a value that fails the validator throws ConfigValidationError', async () => {
    manager.register({ key: 'name', defaultValue: 'default', validator: isString });
    await expect(manager.set('name', 42 as unknown as string)).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('get() on an unregistered key throws UnknownConfigKeyError', () => {
    expect(() => manager.get('not-registered')).toThrow(UnknownConfigKeyError);
  });

  it('set() on an unregistered key throws UnknownConfigKeyError', async () => {
    await expect(manager.set('not-registered', 'value')).rejects.toBeInstanceOf(UnknownConfigKeyError);
  });

  it('clear() reverts to default', async () => {
    manager.register({ key: 'level', defaultValue: 'info', validator: isString });
    await manager.set('level', 'debug');
    expect(manager.get('level')).toBe('debug');
    await manager.clear('level');
    expect(manager.get('level')).toBe('info');
  });

  it('watch(key, handler) fires when that specific key changes', async () => {
    manager.register({ key: 'threshold', defaultValue: 10, validator: isNumber });
    const events: ConfigChangeEvent<number>[] = [];
    manager.watch<number>('threshold', (e) => events.push(e));
    await manager.set('threshold', 20);
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);
    expect(events[0].newValue).toBe(20);
    expect(events[0].key).toBe('threshold');
  });

  it('watch(key, handler) does NOT fire for other keys', async () => {
    manager.register({ key: 'alpha', defaultValue: 1, validator: isNumber });
    manager.register({ key: 'beta', defaultValue: 2, validator: isNumber });
    const alphaEvents: ConfigChangeEvent[] = [];
    manager.watch('alpha', (e) => alphaEvents.push(e));
    await manager.set('beta', 99);
    await new Promise((r) => setImmediate(r));
    expect(alphaEvents).toHaveLength(0);
  });

  it('returned unsubscribe function works', async () => {
    manager.register({ key: 'count', defaultValue: 0, validator: isNumber });
    const events: ConfigChangeEvent[] = [];
    const unsub = manager.watch('count', (e) => events.push(e));
    unsub();
    await manager.set('count', 5);
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(0);
  });

  it('watchAll(handler) fires for any key change', async () => {
    manager.register({ key: 'x', defaultValue: 0, validator: isNumber });
    manager.register({ key: 'y', defaultValue: 0, validator: isNumber });
    const events: ConfigChangeEvent[] = [];
    manager.watchAll((e) => events.push(e));
    await manager.set('x', 1);
    await manager.set('y', 2);
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.key)).toEqual(['x', 'y']);
  });

  it('re-registering same key with same validator/default is idempotent', () => {
    manager.register({ key: 'mode', defaultValue: 'fast', validator: isString });
    expect(() =>
      manager.register({ key: 'mode', defaultValue: 'fast', validator: isString }),
    ).not.toThrow();
  });

  it('re-registering same key with different default throws', () => {
    manager.register({ key: 'mode', defaultValue: 'fast', validator: isString });
    expect(() =>
      manager.register({ key: 'mode', defaultValue: 'slow', validator: isString }),
    ).toThrow();
  });

  it('getSnapshot() returns all registered keys with current-or-default values', async () => {
    manager.register({ key: 'p', defaultValue: 1, validator: isNumber });
    manager.register({ key: 'q', defaultValue: 2, validator: isNumber });
    await manager.set('p', 99);
    const snap = manager.getSnapshot();
    expect(snap).toEqual({ p: 99, q: 2 });
  });

  it('getRegisteredKeys() lists registered keys', () => {
    manager.register({ key: 'a', defaultValue: 'x', validator: isString });
    manager.register({ key: 'b', defaultValue: 'y', validator: isString });
    expect(manager.getRegisteredKeys().sort()).toEqual(['a', 'b']);
  });

  it('cross-node propagation: set on one manager, observe change on the other', async () => {
    const sharedPubSub = makeSharedPubSub();

    const regA = EntityRegistryFactory.createMemory('node-a', { enableTestMode: true });
    const regB = EntityRegistryFactory.createMemory('node-b', { enableTestMode: true });
    await regA.start();
    await regB.start();

    const pubsubA = sharedPubSub.bind('node-a');
    const pubsubB = sharedPubSub.bind('node-b');

    const adapterA = new EntityRegistrySyncAdapter(regA as any, pubsubA, 'node-a', { topic: 'config-sync' });
    const adapterB = new EntityRegistrySyncAdapter(regB as any, pubsubB, 'node-b', { topic: 'config-sync' });

    const managerA = new ConfigManager(regA, { localNodeId: 'node-a' });
    const managerB = new ConfigManager(regB, { localNodeId: 'node-b' });

    await adapterA.start();
    await adapterB.start();
    await managerA.start();
    await managerB.start();

    managerA.register({ key: 'feature', defaultValue: false, validator: (v): v is boolean => typeof v === 'boolean' });
    managerB.register({ key: 'feature', defaultValue: false, validator: (v): v is boolean => typeof v === 'boolean' });

    const receivedOnB: ConfigChangeEvent[] = [];
    managerB.watchAll((e) => receivedOnB.push(e));

    await managerA.set('feature', true);
    await new Promise((r) => setImmediate(r));

    expect(receivedOnB).toHaveLength(1);
    expect(receivedOnB[0].key).toBe('feature');
    expect(receivedOnB[0].newValue).toBe(true);

    await managerA.stop();
    await managerB.stop();
    await adapterA.stop();
    await adapterB.stop();
    await regA.stop();
    await regB.stop();
  });

  it('isStarted() is correct before/after start/stop; stop/start idempotent', async () => {
    const reg = makeRegistry('node-x');
    await reg.start();
    const mgr = new ConfigManager(reg, { localNodeId: 'node-x' });

    expect(mgr.isStarted()).toBe(false);
    await mgr.start();
    expect(mgr.isStarted()).toBe(true);
    await mgr.start();
    expect(mgr.isStarted()).toBe(true);
    await mgr.stop();
    expect(mgr.isStarted()).toBe(false);
    await mgr.stop();
    expect(mgr.isStarted()).toBe(false);

    await reg.stop();
  });
});
