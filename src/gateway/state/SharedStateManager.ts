import { EvictionTimer } from '../eviction/EvictionTimer';
import { UpdateCoalescer } from '../coalescing/UpdateCoalescer';
import { ISnapshotVersionStore } from '../../persistence/snapshot/types';
import { ChannelManager } from '../channel/ChannelManager';
import { PresenceManager } from '../presence/PresenceManager';
import { PubSubManager } from '../pubsub/PubSubManager';
import {
  SharedStateAdapter,
  SharedStateManagerConfig,
  SharedStateManagerStats,
  SharedStateSession,
} from './types';

const DEFAULTS: Required<SharedStateManagerConfig> = {
  idleEvictionMs: 600_000,
  coalescingWindowMs: 50,
  operationsBeforeCheckpoint: 50,
  snapshotDebounceMs: 5_000,
};

const PUBSUB_PREFIX = 'shared-state:';

export class SharedStateManager<S, U = unknown> {
  private readonly adapter: SharedStateAdapter<S, U>;
  private readonly config: Required<SharedStateManagerConfig>;

  private readonly sessions = new Map<string, SharedStateSession<S>>();
  // clientId → channels this client is subscribed to (for disconnect cleanup)
  private readonly clientChannels = new Map<string, Set<string>>();
  // channelId → debounce timer for periodic snapshotting
  private readonly snapshotTimers = new Map<string, NodeJS.Timeout>();
  // channelId → PubSub subscription ID for cross-node updates
  private readonly crossNodeSubs = new Map<string, string>();

  private readonly eviction: EvictionTimer<string>;
  private readonly coalescer: UpdateCoalescer<U>;

  private readonly channels?: ChannelManager;
  private readonly presence?: PresenceManager;
  private readonly pubsub?: PubSubManager;
  private readonly snapshots?: ISnapshotVersionStore<Uint8Array | string>;

  constructor(
    adapter: SharedStateAdapter<S, U>,
    config?: SharedStateManagerConfig,
    deps?: {
      channels?: ChannelManager;
      presence?: PresenceManager;
      pubsub?: PubSubManager;
      snapshots?: ISnapshotVersionStore<Uint8Array | string>;
    }
  ) {
    this.adapter = adapter;
    this.config = { ...DEFAULTS, ...config };
    this.channels = deps?.channels;
    this.presence = deps?.presence;
    this.pubsub = deps?.pubsub;
    this.snapshots = deps?.snapshots;

    this.eviction = new EvictionTimer<string>(this.config.idleEvictionMs);

    this.coalescer = new UpdateCoalescer<U>({
      windowMs: this.config.coalescingWindowMs,
      onFlush: (channelId, updates) => this._broadcastCoalesced(channelId, updates),
      merge: adapter.mergeUpdates?.bind(adapter),
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Subscribe a client to a channel session. Returns the current state so
   * the caller can deliver it as an initial snapshot to the new subscriber.
   *
   * If no session is active for the channel it is hydrated from the snapshot
   * store (if available) or initialized with adapter.createState().
   */
  async subscribe(clientId: string, channelId: string): Promise<S> {
    this.eviction.cancel(channelId);

    let session = this.sessions.get(channelId);
    if (session === undefined) {
      session = await this._openSession(channelId);
    }

    session.subscriberCount++;
    session.lastActivity = Date.now();

    // Track client → channel reverse index
    let chans = this.clientChannels.get(clientId);
    if (chans === undefined) {
      chans = new Set();
      this.clientChannels.set(clientId, chans);
      this.presence?.trackClient(clientId, {});
    }
    chans.add(channelId);

    this.channels?.joinChannel(channelId, clientId);

    return session.state;
  }

  /**
   * Apply an update produced by a local client.
   * Updates state, coalesces for broadcast, publishes cross-node, and
   * triggers periodic checkpointing.
   */
  async applyUpdate(channelId: string, update: U, _sourceClientId?: string): Promise<void> {
    const session = this.sessions.get(channelId);
    if (session === undefined) {
      throw new Error(`SharedStateManager: no active session for channel "${channelId}"`);
    }

    session.state = this.adapter.applyUpdate(session.state, update);
    session.operationCount++;
    session.lastActivity = Date.now();

    // Coalesce for broadcast to local channel subscribers
    this.coalescer.buffer(channelId, update);

    // Cross-node propagation — other nodes apply via _applyRemote (no re-publish)
    await this.pubsub?.publish(`${PUBSUB_PREFIX}${channelId}`, update);

    if (session.operationCount % this.config.operationsBeforeCheckpoint === 0) {
      await this._writeSnapshot(channelId, session, 'auto');
    } else {
      this._scheduleSnapshot(channelId, session);
    }
  }

  /**
   * Return the current state for a channel without joining the session.
   * Falls back to the snapshot store for inactive sessions.
   */
  async getSnapshot(channelId: string): Promise<S | null> {
    const session = this.sessions.get(channelId);
    if (session !== undefined) return session.state;

    const stored = this.snapshots ? await this.snapshots.getLatest(channelId) : null;
    if (stored === null) return null;
    return this.adapter.deserialize(stored.data);
  }

  /**
   * Unsubscribe a client from a channel. When the last subscriber leaves,
   * a checkpoint is taken and idle eviction is scheduled.
   */
  async unsubscribe(clientId: string, channelId: string): Promise<void> {
    // Update reverse index
    const chans = this.clientChannels.get(clientId);
    if (chans !== undefined) {
      chans.delete(channelId);
      if (chans.size === 0) {
        this.clientChannels.delete(clientId);
        this.presence?.untrackClient(clientId);
      }
    }

    this.channels?.leaveChannel(channelId, clientId);

    const session = this.sessions.get(channelId);
    if (session === undefined) return;

    session.subscriberCount = Math.max(0, session.subscriberCount - 1);
    session.lastActivity = Date.now();

    if (session.subscriberCount === 0) {
      // Flush any coalesced updates immediately
      this.coalescer.flush(channelId);
      this._clearSnapshotTimer(channelId);

      // Checkpoint before idle eviction
      await this._writeSnapshot(channelId, session, 'checkpoint');

      // Unsubscribe cross-node listener
      const subId = this.crossNodeSubs.get(channelId);
      if (subId !== undefined) {
        this.pubsub?.unsubscribe(subId);
        this.crossNodeSubs.delete(channelId);
      }

      this.eviction.schedule(channelId, (key) => this._evict(key));
    }
  }

  /**
   * Handle a client that disconnected without sending explicit unsubscribes.
   */
  async onClientDisconnect(clientId: string): Promise<void> {
    const chans = this.clientChannels.get(clientId);
    if (chans === undefined) return;

    const channelList = Array.from(chans);
    await Promise.all(channelList.map((channelId) => this.unsubscribe(clientId, channelId)));
  }

  /**
   * Flush all pending state and write final checkpoints. Call on graceful shutdown.
   */
  async shutdown(): Promise<void> {
    this.coalescer.flushAll();
    this.eviction.cancelAll();
    this._clearAllSnapshotTimers();

    await Promise.all(
      Array.from(this.sessions.entries()).map(([channelId, session]) =>
        this._writeSnapshot(channelId, session, 'checkpoint')
      )
    );

    for (const subId of this.crossNodeSubs.values()) {
      this.pubsub?.unsubscribe(subId);
    }
    this.crossNodeSubs.clear();
    this.sessions.clear();
    this.clientChannels.clear();
  }

  getStats(): SharedStateManagerStats {
    return {
      activeSessions: this.sessions.size,
      pendingCoalesce: this.coalescer.pendingCount,
      pendingEvictions: this.eviction.pendingCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async _openSession(channelId: string): Promise<SharedStateSession<S>> {
    let state: S;
    const stored = this.snapshots ? await this.snapshots.getLatest(channelId) : null;
    state = stored !== null ? this.adapter.deserialize(stored.data) : this.adapter.createState();

    const session: SharedStateSession<S> = {
      channelId,
      state,
      subscriberCount: 0,
      operationCount: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    this.sessions.set(channelId, session);

    // Register cross-node update receiver
    if (this.pubsub !== undefined) {
      const subId = this.pubsub.subscribe(
        `${PUBSUB_PREFIX}${channelId}`,
        (_topic, payload) => this._applyRemote(channelId, payload as U)
      );
      this.crossNodeSubs.set(channelId, subId);
    }

    return session;
  }

  /** Apply an update received from another cluster node — no re-publish. */
  private _applyRemote(channelId: string, update: U): void {
    const session = this.sessions.get(channelId);
    if (session === undefined) return;

    session.state = this.adapter.applyUpdate(session.state, update);
    session.lastActivity = Date.now();

    // Coalesce for local broadcast only
    this.coalescer.buffer(channelId, update);
    this._scheduleSnapshot(channelId, session);
  }

  /** Called by the coalescer when the window closes for a channel. */
  private async _broadcastCoalesced(channelId: string, updates: U[]): Promise<void> {
    if (this.channels === undefined) return;
    // Pass the merged/raw batch as-is; the application layer decides how to serialize
    const payload = updates.length === 1 ? updates[0] : updates;
    await this.channels.broadcastToChannel(channelId, payload);
  }

  private _scheduleSnapshot(channelId: string, session: SharedStateSession<S>): void {
    this._clearSnapshotTimer(channelId);
    const timer = setTimeout(async () => {
      this.snapshotTimers.delete(channelId);
      await this._writeSnapshot(channelId, session, 'auto');
    }, this.config.snapshotDebounceMs);
    timer.unref();
    this.snapshotTimers.set(channelId, timer);
  }

  private async _writeSnapshot(
    channelId: string,
    session: SharedStateSession<S>,
    type: 'auto' | 'checkpoint'
  ): Promise<void> {
    if (this.snapshots === undefined) return;
    const data = this.adapter.serialize(session.state);
    await this.snapshots.store(channelId, data, { type });
  }

  private async _evict(channelId: string): Promise<void> {
    const session = this.sessions.get(channelId);
    if (session === undefined || session.subscriberCount > 0) return;
    this.sessions.delete(channelId);
  }

  private _clearSnapshotTimer(channelId: string): void {
    const timer = this.snapshotTimers.get(channelId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.snapshotTimers.delete(channelId);
    }
  }

  private _clearAllSnapshotTimers(): void {
    for (const timer of this.snapshotTimers.values()) clearTimeout(timer);
    this.snapshotTimers.clear();
  }
}
