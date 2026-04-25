import { EventEmitter } from 'events';
import { LifecycleAware } from '../../common/LifecycleAware';
import {
  PubSubConfig,
  PubSubHandler,
  PubSubMessageMetadata,
  PubSubStats,
  Subscription,
} from './types';

/**
 * Configuration for the {@link RedisPubSubManager}.
 *
 * `redis` is an **optional peer dependency** — it is NOT declared in this
 * package's `dependencies`. Consumers must `npm install redis@^5` (or v7)
 * themselves. If the package is missing at runtime, `start()` rejects with a
 * clear error.
 *
 * Either pass a `url`/`socketOptions` (we'll create both clients), or pass
 * `createClient` (we'll call it twice — once for publisher, once for
 * subscriber). Mixing one connection across SUBSCRIBE+PUBLISH is a Redis
 * protocol violation — the manager will always operate two separate clients.
 */
export interface RedisPubSubManagerConfig extends PubSubConfig {
  /** Local node id; used to tag messageIds and as `metadata.publisherNodeId`. */
  localNodeId: string;

  /** Redis connection URL, e.g. `redis://localhost:6379`. */
  url?: string;

  /**
   * Channel name prefix for topic mapping. A topic `room:42` becomes the
   * Redis channel `<channelPrefix><topic>`. Default `dcore:topic:`.
   */
  channelPrefix?: string;

  /**
   * Custom factory used to create each redis client. Called twice — once
   * for publisher, once for subscriber. Useful for tests or for passing
   * custom socket / TLS options.
   *
   * The returned object must conform to a tiny subset of the redis@5 API
   * documented by {@link RedisLikeClient}.
   */
  createClient?: () => RedisLikeClient | Promise<RedisLikeClient>;

  /** Initial delay (ms) for exponential backoff on reconnect. Default 200. */
  reconnectInitialDelayMs?: number;

  /** Cap on reconnect delay (ms). Default 10_000. */
  reconnectMaxDelayMs?: number;

  /** Drain wait timeout in `stop()` for in-flight publishes. Default 5_000. */
  drainTimeoutMs?: number;
}

/**
 * Minimal duck-typed shape of a `redis@5+` client. Both the production
 * client and the test fakes implement this surface. (Connections, error
 * events, subscribe with callback, publish, quit/disconnect.)
 */
export interface RedisLikeClient {
  connect(): Promise<void>;
  /** publisher: PUBLISH channel message; returns subscriber count. */
  publish(channel: string, message: string): Promise<number>;
  /** subscriber: SUBSCRIBE to channel with a per-message callback. */
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<void>;
  unsubscribe(channel?: string): Promise<void>;
  quit(): Promise<unknown>;
  on(event: 'error', handler: (err: Error) => void): unknown;
  on(event: 'end' | 'disconnect' | 'reconnecting' | 'ready', handler: () => void): unknown;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off?(event: string, handler: (...args: unknown[]) => void): unknown;
  removeAllListeners?(event?: string): unknown;
  isOpen?: boolean;
}

interface WirePayload {
  topic: string;
  payload: unknown;
  metadata: PubSubMessageMetadata;
}

const DEFAULT_CONFIG = {
  channelPrefix: 'dcore:topic:',
  messageDeduplicationTTL: 60_000,
  reconnectInitialDelayMs: 200,
  reconnectMaxDelayMs: 10_000,
  drainTimeoutMs: 5_000,
};

const DEDUP_CLEANUP_INTERVAL_MS = 30_000;

/**
 * `RedisPubSubManager` — a first-party PubSub adapter backed by Redis,
 * matching the public surface of the in-memory {@link PubSubManager} and
 * implementing {@link LifecycleAware}.
 *
 * Behavior:
 * - Uses **two** redis clients (one publisher, one subscriber) — Redis
 *   protocol forbids mixing SUBSCRIBE/PUBLISH on the same connection.
 * - Maps each topic to channel `dcore:topic:<topic>` (configurable prefix).
 * - Deduplicates by `metadata.messageId` with a 60-second TTL window —
 *   matches the in-memory manager's contract so that messages replayed
 *   across a Redis flap don't re-deliver.
 * - Re-subscribes to all topics automatically when the subscriber client
 *   reconnects.
 * - `stop()` stops accepting new publishes, waits up to `drainTimeoutMs`
 *   for in-flight publishes, then disconnects both clients.
 *
 * **Optional peer dependency:** consumers must install `redis@^5` (or
 * compatible) themselves. Importing this class without `redis` installed
 * is fine; only `start()` will fail with an actionable error.
 */
export class RedisPubSubManager extends EventEmitter implements LifecycleAware {
  private readonly localNodeId: string;
  private readonly channelPrefix: string;
  private readonly dedupTtlMs: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly drainTimeoutMs: number;
  private readonly url?: string;
  private readonly createClientFactory?: () => RedisLikeClient | Promise<RedisLikeClient>;

  /** topic -> (subscriptionId -> Subscription) */
  private readonly subscriptions: Map<string, Map<string, Subscription>> = new Map();

  /** topic -> bound listener registered with the subscriber client. */
  private readonly subscriberListeners: Map<string, (message: string, channel: string) => void> =
    new Map();

  /** messageId -> firstSeenAt for dedup. */
  private readonly recentMessageIds: Map<string, number> = new Map();

  private readonly stats: PubSubStats = {
    topicCount: 0,
    totalSubscriptions: 0,
    messagesPublished: 0,
    messagesDelivered: 0,
    crossNodeMessages: 0,
  };

  private publisher: RedisLikeClient | null = null;
  private subscriber: RedisLikeClient | null = null;

  private dedupTimer: NodeJS.Timeout | null = null;
  private subIdCounter = 0;
  private inFlightPublishes = 0;
  private _started = false;
  private _stopping = false;

  constructor(config: RedisPubSubManagerConfig) {
    super();

    if (!config?.localNodeId) {
      throw new Error('RedisPubSubManager: localNodeId is required');
    }

    this.localNodeId = config.localNodeId;
    this.channelPrefix = config.channelPrefix ?? DEFAULT_CONFIG.channelPrefix;
    this.dedupTtlMs = config.messageDeduplicationTTL ?? DEFAULT_CONFIG.messageDeduplicationTTL;
    this.reconnectInitialDelayMs =
      config.reconnectInitialDelayMs ?? DEFAULT_CONFIG.reconnectInitialDelayMs;
    this.reconnectMaxDelayMs =
      config.reconnectMaxDelayMs ?? DEFAULT_CONFIG.reconnectMaxDelayMs;
    this.drainTimeoutMs = config.drainTimeoutMs ?? DEFAULT_CONFIG.drainTimeoutMs;
    this.url = config.url;
    this.createClientFactory = config.createClient;
  }

  // ---------------------------------------------------------------------------
  // LifecycleAware
  // ---------------------------------------------------------------------------

  isStarted(): boolean {
    return this._started;
  }

  async start(): Promise<void> {
    if (this._started) return;

    const factory = this.createClientFactory ?? (await this.defaultClientFactory());

    this.publisher = await factory();
    this.subscriber = await factory();

    this.attachClientListeners(this.publisher, 'publisher');
    this.attachClientListeners(this.subscriber, 'subscriber');

    await this.publisher.connect();
    await this.subscriber.connect();

    this.dedupTimer = setInterval(() => this.cleanupDedup(), DEDUP_CLEANUP_INTERVAL_MS);
    this.dedupTimer.unref?.();

    this._started = true;
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this._started || this._stopping) return;
    this._stopping = true;

    // Wait for in-flight publishes up to drainTimeoutMs.
    const drainStart = Date.now();
    while (this.inFlightPublishes > 0 && Date.now() - drainStart < this.drainTimeoutMs) {
      await new Promise((r) => setTimeout(r, 10));
    }

    if (this.dedupTimer) {
      clearInterval(this.dedupTimer);
      this.dedupTimer = null;
    }

    // Best-effort unsubscribe and quit on both clients. Errors are swallowed —
    // we are tearing down.
    const subscriber = this.subscriber;
    const publisher = this.publisher;

    if (subscriber) {
      try {
        for (const topic of this.subscriberListeners.keys()) {
          await subscriber.unsubscribe(this.channelFor(topic)).catch(() => {});
        }
      } catch {
        // ignore
      }
      try {
        await subscriber.quit();
      } catch {
        // ignore
      }
      subscriber.removeAllListeners?.();
    }

    if (publisher) {
      try {
        await publisher.quit();
      } catch {
        // ignore
      }
      publisher.removeAllListeners?.();
    }

    this.publisher = null;
    this.subscriber = null;
    this.subscriberListeners.clear();
    this.subscriptions.clear();
    this.recentMessageIds.clear();
    this.refreshStats();

    this._started = false;
    this._stopping = false;
    this.emit('stopped');
  }

  // ---------------------------------------------------------------------------
  // Public API (mirrors PubSubManager)
  // ---------------------------------------------------------------------------

  subscribe(topic: string, handler: PubSubHandler): string {
    if (!this._started) {
      throw new Error('RedisPubSubManager: subscribe() called before start()');
    }
    this.subIdCounter++;
    const id = `sub-${this.subIdCounter}`;

    const subscription: Subscription = {
      id,
      topic,
      handler,
      createdAt: Date.now(),
    };

    let topicSubs = this.subscriptions.get(topic);
    const isFirstForTopic = !topicSubs;
    if (!topicSubs) {
      topicSubs = new Map();
      this.subscriptions.set(topic, topicSubs);
    }
    topicSubs.set(id, subscription);

    if (isFirstForTopic) {
      // Fire-and-forget — ensureRedisSubscribed handles its own errors. We
      // expose them via an 'error' event so callers can observe.
      this.ensureRedisSubscribed(topic).catch((err) => this.emit('error', err));
    }

    this.refreshStats();
    this.emit('subscription-added', { id, topic });
    return id;
  }

  unsubscribe(subscriptionId: string): boolean {
    for (const [topic, topicSubs] of this.subscriptions) {
      if (topicSubs.has(subscriptionId)) {
        topicSubs.delete(subscriptionId);

        if (topicSubs.size === 0) {
          this.subscriptions.delete(topic);
          // Fire-and-forget — see comment in subscribe().
          this.ensureRedisUnsubscribed(topic).catch((err) => this.emit('error', err));
        }

        this.refreshStats();
        this.emit('subscription-removed', { id: subscriptionId, topic });
        return true;
      }
    }
    return false;
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    if (!this._started || this._stopping) {
      throw new Error('RedisPubSubManager: publish() called while not started');
    }
    if (!this.publisher) {
      throw new Error('RedisPubSubManager: publisher client unavailable');
    }

    const messageId = `pub-${this.localNodeId}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const metadata: PubSubMessageMetadata = {
      messageId,
      publisherNodeId: this.localNodeId,
      timestamp: Date.now(),
      topic,
    };

    const wire: WirePayload = { topic, payload, metadata };
    const channel = this.channelFor(topic);

    this.inFlightPublishes++;
    try {
      await this.publisher.publish(channel, JSON.stringify(wire));
      this.stats.messagesPublished++;
      this.stats.crossNodeMessages++;
      this.emit('message-published', { topic, messageId });
    } finally {
      this.inFlightPublishes--;
    }
  }

  getTopics(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  getSubscriptionCount(topic?: string): number {
    if (topic !== undefined) {
      return this.subscriptions.get(topic)?.size ?? 0;
    }
    return this.stats.totalSubscriptions;
  }

  getStats(): PubSubStats {
    return { ...this.stats };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private channelFor(topic: string): string {
    return this.channelPrefix + topic;
  }

  private async defaultClientFactory(): Promise<() => Promise<RedisLikeClient>> {
    let redisModule: { createClient: (opts?: { url?: string }) => RedisLikeClient };
    try {
      // Use Function() to avoid TS picking it up as a static dependency
      // and to keep the import truly lazy. node:require is cached.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      redisModule = require('redis');
    } catch (err) {
      throw new Error(
        "RedisPubSubManager: the 'redis' package is required but not installed. " +
          "Install it as a peer dependency: `npm install redis@^5`.",
      );
    }

    const url = this.url;
    return async () => redisModule.createClient(url ? { url } : undefined);
  }

  private attachClientListeners(client: RedisLikeClient, role: 'publisher' | 'subscriber'): void {
    client.on('error', (err: Error) => {
      this.emit('client-error', { role, err });
    });
    client.on('reconnecting', () => {
      this.emit('client-reconnecting', { role });
    });
    client.on('ready', () => {
      this.emit('client-ready', { role });
      // On subscriber reconnect, re-subscribe to every active topic.
      // (redis@5 reconnects automatically; we just need to reattach our SUBSCRIBE.)
      if (role === 'subscriber') {
        this.resubscribeAll().catch((err) => this.emit('error', err));
      }
    });
  }

  private async ensureRedisSubscribed(topic: string): Promise<void> {
    if (!this.subscriber) return;
    if (this.subscriberListeners.has(topic)) return;

    const channel = this.channelFor(topic);
    const listener = (raw: string) => this.onIncoming(raw, topic);
    this.subscriberListeners.set(topic, listener);

    await this.subscribeWithBackoff(channel, listener);
  }

  private async ensureRedisUnsubscribed(topic: string): Promise<void> {
    if (!this.subscriber) return;
    const channel = this.channelFor(topic);
    this.subscriberListeners.delete(topic);
    try {
      await this.subscriber.unsubscribe(channel);
    } catch (err) {
      // The subscriber may be mid-reconnect. Swallow — on next reconnect we
      // simply won't re-subscribe (the listener entry was already removed).
      this.emit('client-error', { role: 'subscriber', err: err as Error });
    }
  }

  private async subscribeWithBackoff(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): Promise<void> {
    let delay = this.reconnectInitialDelayMs;
    let attempt = 0;
    // Bounded retry: at most ~10 attempts in test/dev. Each failure emits a
    // 'subscribe-retry' event so callers can observe.
    const maxAttempts = 10;
    while (attempt < maxAttempts) {
      if (!this.subscriber || this._stopping) return;
      try {
        await this.subscriber.subscribe(channel, listener);
        return;
      } catch (err) {
        attempt++;
        this.emit('subscribe-retry', { channel, attempt, err });
        if (attempt >= maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, this.reconnectMaxDelayMs);
      }
    }
  }

  private async resubscribeAll(): Promise<void> {
    if (!this.subscriber) return;
    for (const [topic, listener] of this.subscriberListeners) {
      const channel = this.channelFor(topic);
      try {
        await this.subscriber.subscribe(channel, listener);
      } catch (err) {
        this.emit('subscribe-retry', { channel, attempt: 0, err });
      }
    }
  }

  private onIncoming(raw: string, topic: string): void {
    let parsed: WirePayload;
    try {
      parsed = JSON.parse(raw) as WirePayload;
    } catch (err) {
      this.emit('parse-error', { topic, err });
      return;
    }

    const { metadata, payload } = parsed;
    if (!metadata || typeof metadata.messageId !== 'string') {
      this.emit('parse-error', { topic, err: new Error('missing metadata.messageId') });
      return;
    }

    if (this.recentMessageIds.has(metadata.messageId)) {
      // Duplicate within dedup window — drop.
      return;
    }
    this.recentMessageIds.set(metadata.messageId, Date.now());

    const topicSubs = this.subscriptions.get(topic);
    if (!topicSubs) return;

    for (const sub of topicSubs.values()) {
      try {
        sub.handler(topic, payload, metadata);
      } catch (err) {
        this.emit('handler-error', { topic, subscriptionId: sub.id, err });
      }
      this.stats.messagesDelivered++;
      this.emit('message-delivered', { topic, subscriptionId: sub.id });
    }
  }

  private cleanupDedup(): void {
    const cutoff = Date.now() - this.dedupTtlMs;
    for (const [id, ts] of this.recentMessageIds) {
      if (ts < cutoff) this.recentMessageIds.delete(id);
    }
  }

  private refreshStats(): void {
    let total = 0;
    for (const subs of this.subscriptions.values()) total += subs.size;
    this.stats.topicCount = this.subscriptions.size;
    this.stats.totalSubscriptions = total;
  }
}
