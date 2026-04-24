import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { EventBus, BusEvent } from '../../../src/messaging/EventBus';
import { InMemorySnapshotVersionStore } from '../../../src/persistence/snapshot/InMemorySnapshotVersionStore';
import { MetricsRegistry } from '../../../src/monitoring/metrics/MetricsRegistry';

function makePubSub(localNodeId = 'node-1') {
  let handler: ((topic: string, payload: unknown, meta: any) => void) | null = null;
  return {
    subscribe: jest.fn((topic: string, h: (topic: string, payload: unknown, meta: any) => void) => {
      handler = h;
      return 'sub-1';
    }),
    unsubscribe: jest.fn(),
    publish: jest.fn(async (topic: string, payload: unknown) => {
      handler?.(topic, payload, {
        publisherNodeId: localNodeId,
        messageId: 'x',
        timestamp: Date.now(),
        topic,
      });
    }),
    _deliver: (payload: unknown, fromNodeId = 'node-2') => {
      handler?.('events:test', payload, {
        publisherNodeId: fromNodeId,
        messageId: 'y',
        timestamp: Date.now(),
        topic: 'events:test',
      });
    },
  };
}

function tempWalPath(): string {
  return path.join(os.tmpdir(), `${randomUUID()}.wal`);
}

type TestEvents = {
  'user.created': { userId: string };
  'order.placed': { orderId: string };
};

describe('EventBus', () => {
  it('publish() calls pubsub.publish with the event', async () => {
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
    await bus.start();

    await bus.publish('user.created', { userId: 'u1' });

    expect(pubsub.publish).toHaveBeenCalledWith(
      'events:test',
      expect.objectContaining({ type: 'user.created', payload: { userId: 'u1' } }),
    );

    await bus.stop();
  });

  it('subscribe(type, handler) receives matching events', async () => {
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
    await bus.start();

    const received: BusEvent<{ userId: string }>[] = [];
    bus.subscribe('user.created', async (event) => { received.push(event); });

    await bus.publish('user.created', { userId: 'u1' });

    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ userId: 'u1' });

    await bus.stop();
  });

  it('subscribe(type, handler) does NOT receive events of other types', async () => {
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
    await bus.start();

    const received: BusEvent[] = [];
    bus.subscribe('user.created', async (event) => { received.push(event); });

    await bus.publish('order.placed', { orderId: 'o1' });

    expect(received).toHaveLength(0);

    await bus.stop();
  });

  it('subscribeAll(handler) receives all events regardless of type', async () => {
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
    await bus.start();

    const received: BusEvent[] = [];
    bus.subscribeAll(async (event) => { received.push(event); });

    await bus.publish('user.created', { userId: 'u1' });
    await bus.publish('order.placed', { orderId: 'o1' });

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe('user.created');
    expect(received[1].type).toBe('order.placed');

    await bus.stop();
  });

  it('unsubscribe() stops delivery to that handler', async () => {
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
    await bus.start();

    const received: BusEvent[] = [];
    const subId = bus.subscribe('user.created', async (event) => { received.push(event); });

    await bus.publish('user.created', { userId: 'u1' });
    expect(received).toHaveLength(1);

    bus.unsubscribe(subId);
    await bus.publish('user.created', { userId: 'u2' });
    expect(received).toHaveLength(1);

    await bus.stop();
  });

  it('multiple subscribers on same type all receive the event', async () => {
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
    await bus.start();

    const r1: BusEvent[] = [];
    const r2: BusEvent[] = [];
    bus.subscribe('user.created', async (e) => { r1.push(e); });
    bus.subscribe('user.created', async (e) => { r2.push(e); });

    await bus.publish('user.created', { userId: 'u1' });

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);

    await bus.stop();
  });

  it('handler throwing calls deadLetterHandler and does not stop other handlers', async () => {
    const deadLetter = jest.fn();
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      deadLetterHandler: deadLetter,
    });
    await bus.start();

    const received: BusEvent[] = [];
    bus.subscribe('user.created', async () => { throw new Error('handler error'); });
    bus.subscribe('user.created', async (e) => { received.push(e); });

    await bus.publish('user.created', { userId: 'u1' });

    expect(deadLetter).toHaveBeenCalledTimes(1);
    expect(deadLetter.mock.calls[0][1]).toBeInstanceOf(Error);
    expect(received).toHaveLength(1);

    await bus.stop();
  });

  it('publish() returns the BusEvent with correct type/payload/sourceNodeId', async () => {
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
    await bus.start();

    const event = await bus.publish('user.created', { userId: 'u42' });

    expect(event.type).toBe('user.created');
    expect(event.payload).toEqual({ userId: 'u42' });
    expect(event.sourceNodeId).toBe('node-1');
    expect(typeof event.id).toBe('string');
    expect(typeof event.timestamp).toBe('number');
    expect(typeof event.version).toBe('number');

    await bus.stop();
  });

  it('version counter increments on each publish', async () => {
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
    await bus.start();

    const e1 = await bus.publish('user.created', { userId: 'u1' });
    const e2 = await bus.publish('order.placed', { orderId: 'o1' });
    const e3 = await bus.publish('user.created', { userId: 'u2' });

    expect(e1.version).toBe(1);
    expect(e2.version).toBe(2);
    expect(e3.version).toBe(3);

    await bus.stop();
  });

  it('WAL: replay() delivers events in version order from the given version', async () => {
    const walPath = tempWalPath();
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus.start();

    await bus.publish('user.created', { userId: 'u1' });
    await bus.publish('order.placed', { orderId: 'o1' });
    await bus.publish('user.created', { userId: 'u2' });

    const replayed: BusEvent[] = [];
    await bus.replay(1, async (e) => { replayed.push(e); });

    expect(replayed).toHaveLength(3);
    expect(replayed[0].version).toBe(1);
    expect(replayed[1].version).toBe(2);
    expect(replayed[2].version).toBe(3);

    await bus.stop();
  });

  it('WAL: events from before fromVersion are not replayed', async () => {
    const walPath = tempWalPath();
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus.start();

    await bus.publish('user.created', { userId: 'u1' });
    await bus.publish('user.created', { userId: 'u2' });
    await bus.publish('user.created', { userId: 'u3' });

    const replayed: BusEvent[] = [];
    await bus.replay(2, async (e) => { replayed.push(e); });

    expect(replayed).toHaveLength(2);
    expect(replayed[0].version).toBe(2);
    expect(replayed[1].version).toBe(3);

    await bus.stop();
  });

  it('replay() throws when WAL not configured', async () => {
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
    await bus.start();

    await expect(bus.replay(1, async () => {})).rejects.toThrow('WAL not configured');

    await bus.stop();
  });

  it('getStats() tracks published and received counts correctly', async () => {
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
    await bus.start();

    bus.subscribe('user.created', async () => {});
    bus.subscribeAll(async () => {});

    await bus.publish('user.created', { userId: 'u1' });
    await bus.publish('order.placed', { orderId: 'o1' });

    const stats = bus.getStats();
    expect(stats.published).toBe(2);
    expect(stats.received).toBe(2);
    expect(stats.subscriptions).toBe(2);

    await bus.stop();
  });

  it('WAL: version counter is restored from WAL on restart', async () => {
    const walPath = tempWalPath();
    const pubsub1 = makePubSub();
    const bus1 = new EventBus<TestEvents>(pubsub1 as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus1.start();

    await bus1.publish('user.created', { userId: 'u1' });
    await bus1.publish('user.created', { userId: 'u2' });
    const e3 = await bus1.publish('user.created', { userId: 'u3' });
    expect(e3.version).toBe(3);

    await bus1.stop();

    // Start a second bus on the same WAL — it should resume from version 4, not 1.
    const pubsub2 = makePubSub();
    const bus2 = new EventBus<TestEvents>(pubsub2 as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus2.start();

    const e4 = await bus2.publish('user.created', { userId: 'u4' });
    expect(e4.version).toBe(4);

    await bus2.stop();
  });

  it('walSyncIntervalMs config is accepted without throwing', async () => {
    const walPath = tempWalPath();
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
      walSyncIntervalMs: 500,
    });

    // Should start and stop without errors.
    await expect(bus.start()).resolves.toBeUndefined();
    await bus.publish('user.created', { userId: 'u1' });
    await expect(bus.stop()).resolves.toBeUndefined();
  });

  it('event from remote node is still delivered to subscribers', async () => {
    const pubsub = makePubSub('node-1');
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
    await bus.start();

    const received: BusEvent[] = [];
    bus.subscribe('user.created', async (e) => { received.push(e); });

    const remoteEvent: BusEvent<{ userId: string }> = {
      id: 'remote-id',
      type: 'user.created',
      payload: { userId: 'remote-user' },
      timestamp: Date.now(),
      sourceNodeId: 'node-2',
      version: 99,
    };

    pubsub._deliver(remoteEvent, 'node-2');

    expect(received).toHaveLength(1);
    expect(received[0].sourceNodeId).toBe('node-2');
    expect(received[0].payload).toEqual({ userId: 'remote-user' });

    await bus.stop();
  });
});

describe('subscribeDurable', () => {
  const walPaths: string[] = [];

  function freshWal(): string {
    const p = tempWalPath();
    walPaths.push(p);
    return p;
  }

  afterEach(() => {
    for (const p of walPaths.splice(0)) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  });

  it('new durable subscription with empty checkpoint store receives subsequently published events', async () => {
    const walPath = freshWal();
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus.start();

    const store = new InMemorySnapshotVersionStore<{ version: number }>();
    const received: BusEvent[] = [];
    await bus.subscribeDurable('user.created', async (e) => { received.push(e); }, {
      checkpointStore: store,
      checkpointKey: 'sub-test',
    });

    await bus.publish('user.created', { userId: 'u1' });
    await bus.publish('user.created', { userId: 'u2' });

    expect(received).toHaveLength(2);
    expect(received[0].payload).toEqual({ userId: 'u1' });

    await bus.stop();
  });

  it('restarts from last checkpoint — handler called only for events after last checkpoint', async () => {
    const walPath = freshWal();
    const store = new InMemorySnapshotVersionStore<{ version: number }>();
    const checkpointKey = 'sub-restart';

    const pubsub1 = makePubSub();
    const bus1 = new EventBus<TestEvents>(pubsub1 as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus1.start();

    const received1: BusEvent[] = [];
    await bus1.subscribeDurable('user.created', async (e) => { received1.push(e); }, {
      checkpointStore: store,
      checkpointKey,
      checkpointEveryN: 5,
    });

    for (let i = 0; i < 15; i++) {
      await bus1.publish('user.created', { userId: `u${i}` });
    }
    await bus1.stop();

    const checkpoint = await store.getLatest(checkpointKey);
    expect(checkpoint).not.toBeNull();
    const checkpointVersion = checkpoint!.data.version;

    const pubsub2 = makePubSub();
    const bus2 = new EventBus<TestEvents>(pubsub2 as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus2.start();

    const received2: BusEvent[] = [];
    await bus2.subscribeDurable('user.created', async (e) => { received2.push(e); }, {
      checkpointStore: store,
      checkpointKey,
      checkpointEveryN: 5,
    });

    for (const e of received2) {
      expect(e.version).toBeGreaterThan(checkpointVersion);
    }

    await bus2.stop();
  });

  it('checkpoint is persisted every N events', async () => {
    const walPath = freshWal();
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus.start();

    const store = new InMemorySnapshotVersionStore<{ version: number }>();
    const checkpointKey = 'sub-checkpoint-n';
    await bus.subscribeDurable('user.created', async () => {}, {
      checkpointStore: store,
      checkpointKey,
      checkpointEveryN: 3,
    });

    await bus.publish('user.created', { userId: 'u1' });
    await bus.publish('user.created', { userId: 'u2' });
    expect(await store.getLatest(checkpointKey)).toBeNull();

    await bus.publish('user.created', { userId: 'u3' });
    const cp = await store.getLatest(checkpointKey);
    expect(cp).not.toBeNull();
    expect(cp!.data.version).toBe(3);

    await bus.stop();
  });

  it('handler error does NOT advance the checkpoint', async () => {
    const walPath = freshWal();
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
      deadLetterHandler: jest.fn(),
    });
    await bus.start();

    const store = new InMemorySnapshotVersionStore<{ version: number }>();
    const checkpointKey = 'sub-err';
    await bus.subscribeDurable('user.created', async () => { throw new Error('boom'); }, {
      checkpointStore: store,
      checkpointKey,
      checkpointEveryN: 1,
    });

    await bus.publish('user.created', { userId: 'u1' });

    const cp = await store.getLatest(checkpointKey);
    expect(cp).toBeNull();

    await bus.stop();
  });

  it('unsubscribe removes the durable subscription', async () => {
    const walPath = freshWal();
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus.start();

    const store = new InMemorySnapshotVersionStore<{ version: number }>();
    const received: BusEvent[] = [];
    const subId = await bus.subscribeDurable('user.created', async (e) => { received.push(e); }, {
      checkpointStore: store,
      checkpointKey: 'sub-unsub',
    });

    await bus.publish('user.created', { userId: 'u1' });
    expect(received).toHaveLength(1);

    bus.unsubscribe(subId);
    await bus.publish('user.created', { userId: 'u2' });
    expect(received).toHaveLength(1);

    await bus.stop();
  });

  it('replay on initial subscribe is filtered to matching type', async () => {
    const walPath = freshWal();
    const pubsub1 = makePubSub();
    const bus1 = new EventBus<TestEvents>(pubsub1 as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus1.start();

    await bus1.publish('user.created', { userId: 'u1' });
    await bus1.publish('order.placed', { orderId: 'o1' });
    await bus1.publish('user.created', { userId: 'u2' });
    await bus1.stop();

    const pubsub2 = makePubSub();
    const bus2 = new EventBus<TestEvents>(pubsub2 as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus2.start();

    const store = new InMemorySnapshotVersionStore<{ version: number }>();
    const received: BusEvent[] = [];
    await bus2.subscribeDurable('user.created', async (e) => { received.push(e); }, {
      checkpointStore: store,
      checkpointKey: 'sub-filter',
    });

    expect(received).toHaveLength(2);
    expect(received.every((e) => e.type === 'user.created')).toBe(true);

    await bus2.stop();
  });
});

describe('compact()', () => {
  const walPaths: string[] = [];

  function freshWal(): string {
    const p = tempWalPath();
    walPaths.push(p);
    return p;
  }

  afterEach(() => {
    for (const p of walPaths.splice(0)) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  });

  it('compacts WAL keeping keepLastNPerType most recent per type', async () => {
    const walPath = freshWal();
    const pubsub = makePubSub();

    type Multi = { 'type.a': { v: number }; 'type.b': { v: number }; 'type.c': { v: number } };
    const bus = new EventBus<Multi>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus.start();

    for (let i = 0; i < 7; i++) await bus.publish('type.a', { v: i });
    for (let i = 0; i < 7; i++) await bus.publish('type.b', { v: i });
    for (let i = 0; i < 6; i++) await bus.publish('type.c', { v: i });

    const result = await bus.compact({ keepLastNPerType: 5 });

    expect(result.entriesBefore).toBe(20);
    expect(result.entriesKept).toBe(15);
    expect(result.entriesRemoved).toBe(5);
    expect(result.typesVisited).toBe(3);

    await bus.stop();
  });

  it('after compact replay returns only kept events in version order', async () => {
    const walPath = freshWal();
    const pubsub = makePubSub();

    type Multi = { 'type.a': { v: number }; 'type.b': { v: number } };
    const bus = new EventBus<Multi>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus.start();

    for (let i = 0; i < 10; i++) await bus.publish('type.a', { v: i });
    for (let i = 0; i < 10; i++) await bus.publish('type.b', { v: i });

    await bus.compact({ keepLastNPerType: 3 });

    const replayed: BusEvent[] = [];
    await bus.replay(0, async (e) => { replayed.push(e); });

    expect(replayed).toHaveLength(6);
    for (let i = 1; i < replayed.length; i++) {
      expect(replayed[i].version).toBeGreaterThan(replayed[i - 1].version);
    }

    await bus.stop();
  });

  it('after compact publish produces version greater than any kept version', async () => {
    const walPath = freshWal();
    const pubsub = makePubSub();

    type Multi = { 'type.a': { v: number } };
    const bus = new EventBus<Multi>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus.start();

    for (let i = 0; i < 10; i++) await bus.publish('type.a', { v: i });

    const result = await bus.compact({ keepLastNPerType: 5 });

    const replayed: BusEvent[] = [];
    await bus.replay(0, async (e) => { replayed.push(e); });
    const maxKept = Math.max(...replayed.map((e) => e.version));

    const newEvent = await bus.publish('type.a', { v: 99 });
    expect(newEvent.version).toBeGreaterThan(maxKept);
    expect(result.entriesRemoved).toBeGreaterThan(0);

    await bus.stop();
  });

  it('compact throws if WAL not configured', async () => {
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
    await bus.start();

    await expect(bus.compact()).rejects.toThrow('WAL not configured');

    await bus.stop();
  });

  it('compact with keepLastNPerType: 0 removes all events', async () => {
    const walPath = freshWal();
    const pubsub = makePubSub();
    const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
    });
    await bus.start();

    await bus.publish('user.created', { userId: 'u1' });
    await bus.publish('user.created', { userId: 'u2' });
    await bus.publish('order.placed', { orderId: 'o1' });

    const result = await bus.compact({ keepLastNPerType: 0 });

    expect(result.entriesKept).toBe(0);
    expect(result.entriesRemoved).toBe(3);

    const replayed: BusEvent[] = [];
    await bus.replay(0, async (e) => { replayed.push(e); });
    expect(replayed).toHaveLength(0);

    await bus.stop();
  });

  describe('metrics', () => {
    it('increments event.published.count{type} on publish', async () => {
      const metrics = new MetricsRegistry('node-1');
      const pubsub = makePubSub();
      const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test', metrics });
      await bus.start();

      await bus.publish('user.created', { userId: 'u1' });
      await bus.publish('user.created', { userId: 'u2' });
      await bus.publish('order.placed', { orderId: 'o1' });

      expect(metrics.counter('event.published.count', { type: 'user.created' }).get()).toBe(2);
      expect(metrics.counter('event.published.count', { type: 'order.placed' }).get()).toBe(1);

      await bus.stop();
    });

    it('increments event.received.count{type} on incoming message', async () => {
      const metrics = new MetricsRegistry('node-1');
      const pubsub = makePubSub('node-1');
      const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test', metrics });
      await bus.start();

      await bus.publish('user.created', { userId: 'u1' });

      expect(metrics.counter('event.received.count', { type: 'user.created' }).get()).toBe(1);

      await bus.stop();
    });

    it('increments event.deadletter.count{type} when a subscriber throws', async () => {
      const metrics = new MetricsRegistry('node-1');
      const deadLetter = jest.fn();
      const pubsub = makePubSub();
      const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', {
        topic: 'events:test',
        deadLetterHandler: deadLetter,
        metrics,
      });
      await bus.start();

      bus.subscribe('user.created', async () => { throw new Error('fail'); });
      await bus.publish('user.created', { userId: 'u1' });

      expect(metrics.counter('event.deadletter.count', { type: 'user.created' }).get()).toBe(1);

      await bus.stop();
    });

    it('no metrics errors when metrics is omitted', async () => {
      const pubsub = makePubSub();
      const bus = new EventBus<TestEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
      await bus.start();
      await expect(bus.publish('user.created', { userId: 'u1' })).resolves.toBeDefined();
      await bus.stop();
    });
  });
});
