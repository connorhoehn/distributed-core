import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { EventBus, BusEvent } from '../../../src/messaging/EventBus';
import { WalNotConfiguredError } from '../../../src/common/errors';

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
  };
}

function tempWalPath(): string {
  return path.join(os.tmpdir(), `${randomUUID()}.wal`);
}

type LargeEvents = {
  'load.tick': { i: number };
};

describe('EventBus.replayStream', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const p of created.splice(0)) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  });

  test('streams 1000+ events in version order via for-await', async () => {
    const walPath = tempWalPath();
    created.push(walPath);
    const pubsub = makePubSub();
    const bus = new EventBus<LargeEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
      walSyncIntervalMs: 0,
    });
    await bus.start();

    const N = 1100;
    for (let i = 0; i < N; i++) {
      await bus.publish('load.tick', { i });
    }

    const versions: number[] = [];
    let count = 0;
    for await (const evt of bus.replayStream(1)) {
      versions.push(evt.version);
      count++;
    }

    expect(count).toBe(N);
    for (let i = 0; i < versions.length; i++) {
      expect(versions[i]).toBe(i + 1);
    }

    await bus.stop();
  }, 60_000);

  test('replayStream applies fromVersion lower bound', async () => {
    const walPath = tempWalPath();
    created.push(walPath);
    const pubsub = makePubSub();
    const bus = new EventBus<LargeEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
      walSyncIntervalMs: 0,
    });
    await bus.start();

    for (let i = 0; i < 50; i++) {
      await bus.publish('load.tick', { i });
    }

    const versions: number[] = [];
    for await (const evt of bus.replayStream(40)) {
      versions.push(evt.version);
    }

    expect(versions).toHaveLength(11); // 40..50 inclusive
    expect(versions[0]).toBe(40);
    expect(versions[versions.length - 1]).toBe(50);

    await bus.stop();
  });

  test('replayStream throws WalNotConfiguredError when WAL is not configured', async () => {
    const pubsub = makePubSub();
    const bus = new EventBus<LargeEvents>(pubsub as any, 'node-1', { topic: 'events:test' });
    await bus.start();

    let err: unknown;
    try {
      // Need to await the iterator's first .next() to surface the throw from the generator body.
      const iter = bus.replayStream(1)[Symbol.asyncIterator]();
      await iter.next();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WalNotConfiguredError);

    await bus.stop();
  });

  test('replay() with handler still works (delegates to replayStream)', async () => {
    const walPath = tempWalPath();
    created.push(walPath);
    const pubsub = makePubSub();
    const bus = new EventBus<LargeEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
      walSyncIntervalMs: 0,
    });
    await bus.start();

    for (let i = 0; i < 100; i++) {
      await bus.publish('load.tick', { i });
    }

    const got: BusEvent[] = [];
    await bus.replay(1, async (e) => { got.push(e); });

    expect(got).toHaveLength(100);
    expect(got[0].version).toBe(1);
    expect(got[99].version).toBe(100);

    await bus.stop();
  });

  test('backpressure: slow handler delays the underlying read; events arrive one at a time', async () => {
    const walPath = tempWalPath();
    created.push(walPath);
    const pubsub = makePubSub();
    const bus = new EventBus<LargeEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
      walSyncIntervalMs: 0,
    });
    await bus.start();

    const N = 20;
    for (let i = 0; i < N; i++) {
      await bus.publish('load.tick', { i });
    }

    // Track how many events have been seen vs. how many handler calls have
    // started. Because the for-await loop awaits the handler, the next yield
    // cannot happen until the handler resolves — i.e., `inFlight` is never > 1.
    let inFlight = 0;
    let maxInFlight = 0;
    const seenVersions: number[] = [];

    for await (const evt of bus.replayStream(1)) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Simulate slow consumer.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      seenVersions.push(evt.version);
      inFlight--;
    }

    expect(seenVersions).toHaveLength(N);
    // The reader must not race ahead of the consumer — only one event is ever
    // "active" because for-await suspends iteration until the body resolves.
    expect(maxInFlight).toBe(1);
    // And events arrive in order.
    for (let i = 0; i < seenVersions.length; i++) {
      expect(seenVersions[i]).toBe(i + 1);
    }

    await bus.stop();
  }, 15_000);

  test('replayStream is consumable via collect-into-array (Array.fromAsync-equivalent)', async () => {
    const walPath = tempWalPath();
    created.push(walPath);
    const pubsub = makePubSub();
    const bus = new EventBus<LargeEvents>(pubsub as any, 'node-1', {
      topic: 'events:test',
      walFilePath: walPath,
      walSyncIntervalMs: 0,
    });
    await bus.start();

    for (let i = 0; i < 5; i++) {
      await bus.publish('load.tick', { i });
    }

    const arr: BusEvent[] = [];
    for await (const e of bus.replayStream(1)) arr.push(e);

    expect(arr.map((e) => e.version)).toEqual([1, 2, 3, 4, 5]);

    await bus.stop();
  });
});
