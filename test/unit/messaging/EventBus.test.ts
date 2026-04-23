import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { EventBus, BusEvent } from '../../../src/messaging/EventBus';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventbus-test-'));
  return path.join(dir, 'test.wal');
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
