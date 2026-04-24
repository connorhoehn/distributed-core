import { EventEmitter } from 'events';
import { DistributedSession } from '../../cluster/sessions/DistributedSession';
import { PubSubManager } from '../pubsub/PubSubManager';
import { ISnapshotVersionStore } from '../../persistence/snapshot/types';
import { SharedStateAdapter, SharedStateManagerStats } from './types';
import { PubSubMessageMetadata } from '../pubsub/types';
import { LifecycleAware } from '../../common/LifecycleAware';

const DEFAULT_TOPIC_PREFIX = 'shared-state';
const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 5_000;

interface CrossNodePayload<U> {
  update: U;
}

export class SharedStateManager<S, U = unknown> extends EventEmitter implements LifecycleAware {
  private readonly session: DistributedSession<S, U>;
  private readonly pubsub: PubSubManager;
  private readonly adapter: SharedStateAdapter<S, U>;
  private readonly topicPrefix: string;
  private readonly snapshotStore?: ISnapshotVersionStore<S>;
  private readonly snapshotDebounceMs: number;

  private readonly clientChannels = new Map<string, Set<string>>();
  private readonly channelSubscriberCount = new Map<string, number>();
  private readonly crossNodeSubs = new Map<string, string>();
  private readonly snapshotTimers = new Map<string, NodeJS.Timeout>();
  private readonly _followerStates = new Map<string, S>();

  private _started = false;

  constructor(
    session: DistributedSession<S, U>,
    pubsub: PubSubManager,
    adapter: SharedStateAdapter<S, U>,
    options?: {
      topicPrefix?: string;
      snapshotStore?: ISnapshotVersionStore<S>;
      snapshotDebounceMs?: number;
    }
  ) {
    super();
    this.session = session;
    this.pubsub = pubsub;
    this.adapter = adapter;
    this.topicPrefix = options?.topicPrefix ?? DEFAULT_TOPIC_PREFIX;
    this.snapshotStore = options?.snapshotStore;
    this.snapshotDebounceMs = options?.snapshotDebounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS;
  }

  isStarted(): boolean {
    return this._started;
  }

  async start(): Promise<void> {
    if (this._started) return;
    await this.session.start();
    this._started = true;
    this.session.on('session:evicted', (sessionId: string) => {
      void this._onSessionEvicted(sessionId);
    });
  }

  async stop(): Promise<void> {
    if (!this._started) return;
    this._started = false;
    this._clearAllSnapshotTimers();
    if (this.snapshotStore !== undefined) {
      const localSessions = this.session.getLocalSessions();
      await Promise.all(
        localSessions.map(({ sessionId, state }) =>
          this.snapshotStore!.store(sessionId, state, { type: 'checkpoint' })
        )
      );
    }
    for (const subId of this.crossNodeSubs.values()) {
      this.pubsub.unsubscribe(subId);
    }
    this.crossNodeSubs.clear();
    this.channelSubscriberCount.clear();
    this.clientChannels.clear();
    this._followerStates.clear();
  }

  async subscribe(clientId: string, channelId: string): Promise<S> {
    const topic = `${this.topicPrefix}:${channelId}`;
    if (!this.crossNodeSubs.has(channelId)) {
      const subId = this.pubsub.subscribe(
        topic,
        (t, payload, meta) => this._onCrossNodeMessage(channelId, payload as CrossNodePayload<U>, meta)
      );
      this.crossNodeSubs.set(channelId, subId);
    }

    const info = await this.session.join(channelId);

    const prevCount = this.channelSubscriberCount.get(channelId) ?? 0;
    this.channelSubscriberCount.set(channelId, prevCount + 1);

    let chans = this.clientChannels.get(clientId);
    if (chans === undefined) {
      chans = new Set();
      this.clientChannels.set(clientId, chans);
    }
    chans.add(channelId);

    if (info.isLocal) {
      if (prevCount === 0 && this.snapshotStore !== undefined) {
        const persisted = await this.snapshotStore.getLatest(channelId);
        if (persisted !== null) {
          this.session.hydrate(channelId, persisted.data);
        }
      }
      return this.session.getState(channelId) ?? this.adapter.createState();
    }

    return this._followerStates.get(channelId) ?? this.adapter.createState();
  }

  async applyUpdate(channelId: string, update: U, _sourceClientId?: string): Promise<void> {
    if (!this.session.isLocal(channelId)) {
      throw new Error('channel is not owned by this node');
    }
    await this.session.apply(channelId, update);
    await this.pubsub.publish(`${this.topicPrefix}:${channelId}`, { update } as CrossNodePayload<U>);

    this._scheduleSnapshot(channelId);
  }

  async getSnapshot(channelId: string): Promise<S | null> {
    if (this.session.isLocal(channelId)) {
      return this.session.getState(channelId);
    }
    return this._followerStates.get(channelId) ?? null;
  }

  async unsubscribe(clientId: string, channelId: string): Promise<void> {
    const chans = this.clientChannels.get(clientId);
    if (chans !== undefined) {
      chans.delete(channelId);
      if (chans.size === 0) {
        this.clientChannels.delete(clientId);
      }
    }

    const count = this.channelSubscriberCount.get(channelId);
    if (count === undefined || count === 0) return;

    const newCount = count - 1;
    this.channelSubscriberCount.set(channelId, newCount);

    if (newCount === 0) {
      this.channelSubscriberCount.delete(channelId);
      const subId = this.crossNodeSubs.get(channelId);
      if (subId !== undefined) {
        this.pubsub.unsubscribe(subId);
        this.crossNodeSubs.delete(channelId);
      }
      this._clearSnapshotTimer(channelId);

      if (this.session.isLocal(channelId)) {
        await this.session.leave(channelId);
      } else {
        this._followerStates.delete(channelId);
      }
    }
  }

  async onClientDisconnect(clientId: string): Promise<void> {
    const chans = this.clientChannels.get(clientId);
    if (chans === undefined) return;
    const channelList = Array.from(chans);
    await Promise.all(channelList.map((channelId) => this.unsubscribe(clientId, channelId)));
  }

  getStats(): SharedStateManagerStats {
    return {
      activeSessions: this.session.getStats().localSessions + this._followerStates.size,
      pendingCoalesce: 0,
      pendingEvictions: this.session.getStats().pendingEvictions,
    };
  }

  private async _onSessionEvicted(sessionId: string): Promise<void> {
    if (this.snapshotStore === undefined) return;
    const state = this.session.getState(sessionId);
    if (state !== null) {
      await this.snapshotStore.store(sessionId, state, { type: 'checkpoint' });
    }
  }

  private _onCrossNodeMessage(
    channelId: string,
    payload: CrossNodePayload<U>,
    meta: PubSubMessageMetadata
  ): void {
    if (meta.publisherNodeId === this.session.nodeId) return;
    if (this.session.isLocal(channelId)) return;

    const current = this._followerStates.get(channelId) ?? this.adapter.createState();
    const next = this.adapter.applyUpdate(current, payload.update);
    this._followerStates.set(channelId, next);

    this.emit('state:updated', channelId, next);
  }

  private _scheduleSnapshot(channelId: string): void {
    this._clearSnapshotTimer(channelId);
    if (this.snapshotStore === undefined) return;
    const timer = setTimeout(async () => {
      this.snapshotTimers.delete(channelId);
      const state = this.session.getState(channelId);
      if (state !== null) {
        await this.snapshotStore!.store(channelId, state, { type: 'auto' });
      }
    }, this.snapshotDebounceMs);
    timer.unref();
    this.snapshotTimers.set(channelId, timer);
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
