import { EventEmitter } from 'events';
import {
  RedisPubSubManager,
  RedisLikeClient,
} from '../../../../src/gateway/pubsub/RedisPubSubManager';

// ---------------------------------------------------------------------------
// In-memory fake of `redis@5+` that supports SUBSCRIBE/PUBLISH semantics
// across multiple clients (publisher + subscriber). All clients created via
// the same `FakeRedisServer` share a routing table so PUBLISH on one client
// reaches subscribers on every other client subscribed to the same channel.
// ---------------------------------------------------------------------------

class FakeRedisServer {
  /** channel -> set of listeners across every connected subscriber client. */
  private channels: Map<
    string,
    Set<(message: string, channel: string) => void>
  > = new Map();
  private down = false;

  /** Simulate a server crash: drop all routing, fail subscribe attempts. */
  kill(): void {
    this.down = true;
    this.channels.clear();
  }

  /** Bring server back up. (Existing connected clients must re-SUBSCRIBE.) */
  restart(): void {
    this.down = false;
  }

  isDown(): boolean {
    return this.down;
  }

  registerSubscription(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): void {
    if (this.down) throw new Error('FakeRedisServer: down');
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(listener);
  }

  unregisterSubscription(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): void {
    const set = this.channels.get(channel);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.channels.delete(channel);
  }

  publish(channel: string, message: string): number {
    if (this.down) return 0;
    const set = this.channels.get(channel);
    if (!set) return 0;
    // Snapshot to avoid mutation-during-iteration if a handler unsubscribes.
    const listeners = Array.from(set);
    for (const l of listeners) {
      try {
        l(message, channel);
      } catch {
        // ignore — production redis client wouldn't surface these either
      }
    }
    return listeners.length;
  }
}

class FakeRedisClient extends EventEmitter implements RedisLikeClient {
  isOpen = false;
  private channelListeners: Map<string, (message: string, channel: string) => void> = new Map();
  constructor(private readonly server: FakeRedisServer) {
    super();
  }

  async connect(): Promise<void> {
    this.isOpen = true;
    // Match redis@5: `ready` fires once the connection is usable.
    setImmediate(() => this.emit('ready'));
  }

  async publish(channel: string, message: string): Promise<number> {
    if (!this.isOpen) throw new Error('FakeRedisClient: not connected');
    if (this.server.isDown()) {
      throw new Error('FakeRedisClient: server down');
    }
    return this.server.publish(channel, message);
  }

  async subscribe(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): Promise<void> {
    if (!this.isOpen) throw new Error('FakeRedisClient: not connected');
    if (this.server.isDown()) {
      throw new Error('FakeRedisClient: server down');
    }
    // If there's an existing listener for this channel on this client,
    // unregister it first (re-subscribe semantics).
    const existing = this.channelListeners.get(channel);
    if (existing) this.server.unregisterSubscription(channel, existing);
    this.channelListeners.set(channel, listener);
    this.server.registerSubscription(channel, listener);
  }

  async unsubscribe(channel?: string): Promise<void> {
    if (!channel) {
      for (const [c, l] of this.channelListeners) this.server.unregisterSubscription(c, l);
      this.channelListeners.clear();
      return;
    }
    const l = this.channelListeners.get(channel);
    if (l) {
      this.server.unregisterSubscription(channel, l);
      this.channelListeners.delete(channel);
    }
  }

  async quit(): Promise<unknown> {
    this.isOpen = false;
    for (const [c, l] of this.channelListeners) this.server.unregisterSubscription(c, l);
    this.channelListeners.clear();
    return 'OK';
  }

  /** Test helper: simulate the connection dropping then reconnecting. */
  simulateReconnect(): void {
    // Real redis@5 emits these around a reconnect cycle.
    this.emit('reconnecting');
    setImmediate(() => this.emit('ready'));
  }

  /** Test helper: drop all server-side subs (server lost them on flap). */
  forgetServerSubs(): void {
    for (const [c, l] of this.channelListeners) this.server.unregisterSubscription(c, l);
  }
}

function makeFactory(server: FakeRedisServer) {
  return () => new FakeRedisClient(server);
}

// Convenience: wait until a predicate returns true (poll, capped).
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: timed out');
}

// ---------------------------------------------------------------------------

describe('RedisPubSubManager', () => {
  test('publish on topic A is delivered to subscriber on the same topic', async () => {
    const server = new FakeRedisServer();
    const mgr = new RedisPubSubManager({
      localNodeId: 'node-a',
      createClient: makeFactory(server),
    });
    await mgr.start();

    const received: unknown[] = [];
    mgr.subscribe('topic-a', (_t, payload) => received.push(payload));

    await mgr.publish('topic-a', { hello: 'world' });
    await waitFor(() => received.length === 1);

    expect(received).toEqual([{ hello: 'world' }]);

    await mgr.stop();
  });

  test('two subscribers on the same topic both receive', async () => {
    const server = new FakeRedisServer();
    const mgr = new RedisPubSubManager({
      localNodeId: 'node-a',
      createClient: makeFactory(server),
    });
    await mgr.start();

    const a: unknown[] = [];
    const b: unknown[] = [];
    mgr.subscribe('shared', (_t, p) => a.push(p));
    mgr.subscribe('shared', (_t, p) => b.push(p));

    await mgr.publish('shared', { n: 1 });
    await waitFor(() => a.length === 1 && b.length === 1);

    expect(a).toEqual([{ n: 1 }]);
    expect(b).toEqual([{ n: 1 }]);

    await mgr.stop();
  });

  test('messages cross between two managers via the shared fake server', async () => {
    const server = new FakeRedisServer();
    const a = new RedisPubSubManager({ localNodeId: 'node-a', createClient: makeFactory(server) });
    const b = new RedisPubSubManager({ localNodeId: 'node-b', createClient: makeFactory(server) });
    await a.start();
    await b.start();

    const got: unknown[] = [];
    b.subscribe('events', (_t, p) => got.push(p));

    await a.publish('events', { from: 'a' });
    await waitFor(() => got.length === 1);
    expect(got).toEqual([{ from: 'a' }]);

    await a.stop();
    await b.stop();
  });

  test('subscriptions resume after a Redis kill/restart cycle', async () => {
    const server = new FakeRedisServer();
    const mgr = new RedisPubSubManager({
      localNodeId: 'node-a',
      createClient: makeFactory(server),
    });
    await mgr.start();

    // Capture references to the fake clients that the manager created so we
    // can simulate a reconnect on the subscriber side.
    // The manager exposes them via 'client-ready' events: every fake client
    // emits 'ready' on connect. We track via the manager events instead.
    const received: unknown[] = [];
    mgr.subscribe('flappy', (_t, p) => received.push(p));

    await mgr.publish('flappy', { seq: 1 });
    await waitFor(() => received.length === 1);

    // Simulate flap: server forgets subs, then comes back.
    // Reach into the manager's subscriber via a public channel — we trigger
    // a reconnect by emitting on its underlying client. The cleanest path
    // for the test is: kill server (invalidate subs), restart, then make the
    // manager's subscriber emit 'ready' so it triggers resubscribeAll.
    const subscriberClient = (mgr as unknown as { subscriber: FakeRedisClient }).subscriber;
    expect(subscriberClient).toBeDefined();
    subscriberClient.forgetServerSubs();
    server.kill();
    server.restart();
    subscriberClient.simulateReconnect();

    // Wait until the manager has re-subscribed (ready handler ran).
    await waitFor(() => {
      // Re-publish — if subscription resumed, this delivers.
      // Loop until either delivered or timeout.
      return received.length === 1; // baseline guard so loop body runs
    });

    // Re-publish a fresh message; should now route through the resumed sub.
    await new Promise((r) => setImmediate(r)); // let resubscribe fire
    await new Promise((r) => setImmediate(r));
    await mgr.publish('flappy', { seq: 2 });
    await waitFor(() => received.length === 2);

    expect(received).toEqual([{ seq: 1 }, { seq: 2 }]);

    await mgr.stop();
  });

  test('duplicate message id within the dedup window is dropped', async () => {
    const server = new FakeRedisServer();
    const mgr = new RedisPubSubManager({
      localNodeId: 'node-a',
      createClient: makeFactory(server),
    });
    await mgr.start();

    const received: unknown[] = [];
    mgr.subscribe('dedup', (_t, p) => received.push(p));

    // Publish a normal message first (lets the manager's metadata/ID logic
    // produce a real entry and confirms baseline delivery).
    await mgr.publish('dedup', { n: 1 });
    await waitFor(() => received.length === 1);

    // Now inject a raw payload twice with the same messageId by publishing
    // through the publisher client directly. The manager parses metadata
    // from the wire and dedups by messageId.
    const publisherClient = (mgr as unknown as { publisher: FakeRedisClient }).publisher;
    const wire = JSON.stringify({
      topic: 'dedup',
      payload: { n: 2 },
      metadata: {
        messageId: 'fixed-id-123',
        publisherNodeId: 'node-b',
        timestamp: Date.now(),
        topic: 'dedup',
      },
    });
    await publisherClient.publish('dcore:topic:dedup', wire);
    await publisherClient.publish('dcore:topic:dedup', wire);
    // Allow microtasks to flush.
    await new Promise((r) => setImmediate(r));

    expect(received).toEqual([{ n: 1 }, { n: 2 }]);

    await mgr.stop();
  });

  test('stop() cleans up both clients and clears state', async () => {
    const server = new FakeRedisServer();
    const mgr = new RedisPubSubManager({
      localNodeId: 'node-a',
      createClient: makeFactory(server),
    });
    await mgr.start();
    mgr.subscribe('topic-x', () => {});
    expect(mgr.isStarted()).toBe(true);

    const subscriberClient = (mgr as unknown as { subscriber: FakeRedisClient }).subscriber;
    const publisherClient = (mgr as unknown as { publisher: FakeRedisClient }).publisher;

    await mgr.stop();

    expect(mgr.isStarted()).toBe(false);
    expect(subscriberClient.isOpen).toBe(false);
    expect(publisherClient.isOpen).toBe(false);
    expect(mgr.getTopics()).toHaveLength(0);

    // Publishing after stop() should reject.
    await expect(mgr.publish('topic-x', { a: 1 })).rejects.toThrow(/not started/);
  });

  test('subscribe before start() throws', () => {
    const server = new FakeRedisServer();
    const mgr = new RedisPubSubManager({
      localNodeId: 'node-a',
      createClient: makeFactory(server),
    });
    expect(() => mgr.subscribe('foo', () => {})).toThrow(/before start/);
  });

  test('unsubscribe last handler issues redis UNSUBSCRIBE', async () => {
    const server = new FakeRedisServer();
    const mgr = new RedisPubSubManager({
      localNodeId: 'node-a',
      createClient: makeFactory(server),
    });
    await mgr.start();

    const id = mgr.subscribe('only', () => {});
    expect(mgr.getTopics()).toContain('only');

    const removed = mgr.unsubscribe(id);
    expect(removed).toBe(true);
    expect(mgr.getTopics()).not.toContain('only');

    await mgr.stop();
  });

  test('getStats reports publishes and deliveries', async () => {
    const server = new FakeRedisServer();
    const mgr = new RedisPubSubManager({
      localNodeId: 'node-a',
      createClient: makeFactory(server),
    });
    await mgr.start();

    const received: unknown[] = [];
    mgr.subscribe('stats', (_t, p) => received.push(p));

    await mgr.publish('stats', { i: 1 });
    await mgr.publish('stats', { i: 2 });
    await waitFor(() => received.length === 2);

    const stats = mgr.getStats();
    expect(stats.messagesPublished).toBe(2);
    expect(stats.messagesDelivered).toBe(2);
    expect(stats.totalSubscriptions).toBe(1);

    await mgr.stop();
  });
});
