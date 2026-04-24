import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import { PubSubManager } from '../gateway/pubsub/PubSubManager';
import { PubSubMessageMetadata } from '../gateway/pubsub/types';
import { WALWriterImpl } from '../persistence/wal/WALWriter';
import { WALReaderImpl } from '../persistence/wal/WALReader';
import { ISnapshotVersionStore } from '../persistence/snapshot/types';
import { MetricsRegistry } from '../monitoring/metrics/MetricsRegistry';
import { LifecycleAware } from '../common/LifecycleAware';
import { WalNotConfiguredError } from '../common/errors';

export interface BusEvent<T = unknown> {
  id: string;
  type: string;
  payload: T;
  timestamp: number;
  sourceNodeId: string;
  version: number;
}

export interface EventBusConfig {
  topic: string;
  walFilePath?: string;
  walSyncIntervalMs?: number;  // Default: 1000. Set to 0 for manual sync.
  deadLetterHandler?: (event: BusEvent, error: Error) => void;
  metrics?: MetricsRegistry;

  /**
   * If set, the bus runs compact() on this interval. Pairs well with
   * `compactOptions.keepLastNPerType` to bound WAL growth without manual
   * intervention. Only active when walFilePath is also configured.
   * Default: undefined (manual compaction only).
   */
  autoCompactIntervalMs?: number;

  /**
   * Options passed to compact() when auto-compaction fires.
   * Default: { keepLastNPerType: 100 }
   */
  autoCompactOptions?: EventBusCompactionOptions;
}

export interface DurableSubscriptionOptions<S = unknown> {
  checkpointStore: ISnapshotVersionStore<{ version: number }>;
  checkpointKey: string;
  checkpointEveryN?: number;
}

export interface EventBusCompactionOptions {
  keepLastNPerType?: number;
}

export interface EventBusCompactionResult {
  entriesBefore: number;
  entriesKept: number;
  entriesRemoved: number;
  typesVisited: number;
}

type TypedHandler<T = unknown> = (event: BusEvent<T>) => Promise<void>;

/**
 * Typed cluster-wide event bus over PubSubManager.
 *
 * Delivery semantics: events are delivered to ALL subscribers, including
 * subscribers on the publishing node. If you need to skip self-published
 * events, check `event.sourceNodeId !== localNodeId` in your handler.
 *
 * Durability: when `walFilePath` is set, events are persisted before being
 * published. A background sync flushes the WAL every `walSyncIntervalMs`
 * (default 1000ms). Process crash between append and sync may lose events
 * within that window.
 *
 * Versioning: each EventBus instance assigns a monotonically increasing
 * version to its events. On restart with a WAL, the counter is restored
 * from the max version in the log to avoid collisions.
 */
export class EventBus<EventMap extends Record<string, unknown> = Record<string, unknown>> extends EventEmitter implements LifecycleAware {
  private readonly pubsub: PubSubManager;
  private readonly localNodeId: string;
  private readonly config: EventBusConfig;
  private readonly metrics: MetricsRegistry | null;

  private _subId: string | null = null;
  private _versionCounter = 0;
  private _subIdCounter = 0;
  private _started = false;

  private readonly _typeHandlers: Map<string, Map<string, TypedHandler<unknown>>> = new Map();
  private readonly _allHandlers: Map<string, TypedHandler<unknown>> = new Map();

  private _walWriter: WALWriterImpl | null = null;

  private _autoCompactTimer: ReturnType<typeof setInterval> | null = null;
  private _inflightCompaction: Promise<unknown> | null = null;

  private readonly _stats = { published: 0, received: 0, subscriptions: 0 };

  constructor(pubsub: PubSubManager, localNodeId: string, config: EventBusConfig) {
    super();
    this.pubsub = pubsub;
    this.localNodeId = localNodeId;
    this.config = config;
    this.metrics = config.metrics ?? null;
    this._onMessage = this._onMessage.bind(this);
  }

  isStarted(): boolean {
    return this._started;
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this._subId = this.pubsub.subscribe(this.config.topic, this._onMessage);

    if (this.config.walFilePath) {
      this._walWriter = new WALWriterImpl({
        filePath: this.config.walFilePath,
        syncInterval: this.config.walSyncIntervalMs ?? 1000,
      });
      await this._walWriter.initialize();

      // Restore version counter from existing WAL entries to avoid collisions on restart.
      const reader = new WALReaderImpl(this.config.walFilePath);
      await reader.initialize();
      try {
        const entries = await reader.readAll();
        let maxVersion = 0;
        for (const entry of entries) {
          if (entry.data.metadata?._eventBus === true && entry.data.version > maxVersion) {
            maxVersion = entry.data.version;
          }
        }
        this._versionCounter = maxVersion;
      } finally {
        await reader.close();
      }
    }

    if (
      this.config.autoCompactIntervalMs !== undefined &&
      this.config.autoCompactIntervalMs > 0 &&
      this.config.walFilePath
    ) {
      const opts: EventBusCompactionOptions = this.config.autoCompactOptions ?? { keepLastNPerType: 100 };
      const timer = setInterval(() => {
        const promise = this.compact(opts).then((result) => {
          this.emit('compact:completed', result);
        }).catch((err) => {
          this.emit('compact:error', err);
        }).finally(() => {
          if (this._inflightCompaction === promise) {
            this._inflightCompaction = null;
          }
        });
        this._inflightCompaction = promise;
      }, this.config.autoCompactIntervalMs);
      timer.unref();
      this._autoCompactTimer = timer;
    }
  }

  async stop(): Promise<void> {
    if (!this._started) return;
    this._started = false;

    if (this._autoCompactTimer !== null) {
      clearInterval(this._autoCompactTimer);
      this._autoCompactTimer = null;
    }

    if (this._inflightCompaction !== null) {
      await this._inflightCompaction.catch(() => { /* already emitted compact:error */ });
      this._inflightCompaction = null;
    }

    if (this._subId !== null) {
      this.pubsub.unsubscribe(this._subId);
      this._subId = null;
    }

    if (this._walWriter) {
      await this._walWriter.close();
      this._walWriter = null;
    }
  }

  async publish<K extends keyof EventMap & string>(
    type: K,
    payload: EventMap[K],
  ): Promise<BusEvent<EventMap[K]>> {
    this._versionCounter++;

    const event: BusEvent<EventMap[K]> = {
      id: randomUUID(),
      type,
      payload,
      timestamp: Date.now(),
      sourceNodeId: this.localNodeId,
      version: this._versionCounter,
    };

    if (this._walWriter) {
      await this._walWriter.append({
        entityId: `event:${event.type}`,
        version: event.version,
        timestamp: event.timestamp,
        operation: 'CREATE',
        metadata: {
          _eventBus: true,
          event: JSON.stringify(event),
        },
      });
    }

    await this.pubsub.publish(this.config.topic, event);

    this._stats.published++;
    this.metrics?.counter('event.published.count', { type }).inc();

    return event;
  }

  subscribe<K extends keyof EventMap & string>(
    type: K,
    handler: (event: BusEvent<EventMap[K]>) => Promise<void>,
  ): string {
    this._subIdCounter++;
    const id = `sub-${this._subIdCounter}`;

    let typeMap = this._typeHandlers.get(type);
    if (!typeMap) {
      typeMap = new Map();
      this._typeHandlers.set(type, typeMap);
    }
    typeMap.set(id, handler as TypedHandler<unknown>);

    this._stats.subscriptions++;
    return id;
  }

  async subscribeDurable<K extends keyof EventMap & string>(
    type: K,
    handler: (event: BusEvent<EventMap[K]>) => Promise<void>,
    options: DurableSubscriptionOptions,
  ): Promise<string> {
    const checkpointEveryN = options.checkpointEveryN ?? 10;
    let eventCount = 0;

    const checkpoint = await options.checkpointStore.getLatest(options.checkpointKey);
    const resumeFrom = checkpoint ? checkpoint.data.version : 0;

    if (this.config.walFilePath && resumeFrom >= 0) {
      await this.replay(resumeFrom + 1, async (event) => {
        if (event.type !== type) return;
        try {
          await handler(event as BusEvent<EventMap[K]>);
          eventCount++;
          if (eventCount % checkpointEveryN === 0) {
            await options.checkpointStore.store(
              options.checkpointKey,
              { version: event.version },
              { type: 'checkpoint' },
            );
          }
        } catch (err) {
          this.config.deadLetterHandler?.(event, err as Error);
        }
      });
    }

    const wrappedHandler: TypedHandler<unknown> = async (event) => {
      try {
        await handler(event as BusEvent<EventMap[K]>);
        eventCount++;
        if (eventCount % checkpointEveryN === 0) {
          await options.checkpointStore.store(
            options.checkpointKey,
            { version: event.version },
            { type: 'checkpoint' },
          );
        }
      } catch (err) {
        this.config.deadLetterHandler?.(event, err as Error);
      }
    };

    this._subIdCounter++;
    const id = `sub-${this._subIdCounter}`;

    let typeMap = this._typeHandlers.get(type);
    if (!typeMap) {
      typeMap = new Map();
      this._typeHandlers.set(type, typeMap);
    }
    typeMap.set(id, wrappedHandler);

    this._stats.subscriptions++;
    return id;
  }

  subscribeAll(handler: (event: BusEvent) => Promise<void>): string {
    this._subIdCounter++;
    const id = `sub-${this._subIdCounter}`;
    this._allHandlers.set(id, handler as TypedHandler<unknown>);
    this._stats.subscriptions++;
    return id;
  }

  unsubscribe(subscriptionId: string): void {
    let removed = false;

    for (const typeMap of this._typeHandlers.values()) {
      if (typeMap.has(subscriptionId)) {
        typeMap.delete(subscriptionId);
        removed = true;
        break;
      }
    }

    if (!removed && this._allHandlers.has(subscriptionId)) {
      this._allHandlers.delete(subscriptionId);
      removed = true;
    }

    if (removed) {
      this._stats.subscriptions--;
    }
  }

  async replay(fromVersion: number, handler: (event: BusEvent) => Promise<void>): Promise<void> {
    if (!this.config.walFilePath) {
      throw new WalNotConfiguredError('replay events');
    }

    const reader = new WALReaderImpl(this.config.walFilePath);
    await reader.initialize();

    try {
      const entries = await reader.readAll();

      const events: BusEvent[] = entries
        .filter(
          (e) =>
            e.data.metadata?._eventBus === true && e.data.version >= fromVersion,
        )
        .map((e) => JSON.parse(e.data.metadata!.event as string) as BusEvent)
        .sort((a, b) => a.version - b.version);

      for (const event of events) {
        await handler(event);
      }
    } finally {
      await reader.close();
    }
  }

  async compact(options?: EventBusCompactionOptions): Promise<EventBusCompactionResult> {
    if (!this.config.walFilePath) {
      throw new WalNotConfiguredError('compact');
    }

    const keepLastNPerType = options?.keepLastNPerType ?? 100;

    const reader = new WALReaderImpl(this.config.walFilePath);
    await reader.initialize();
    let allEntries: BusEvent[];
    let entriesBefore: number;

    try {
      const walEntries = await reader.readAll();
      const busEntries = walEntries.filter(
        (e) => e.data.metadata?._eventBus === true,
      );
      entriesBefore = busEntries.length;

      const parsed = busEntries.map((e) => JSON.parse(e.data.metadata!.event as string) as BusEvent);

      const byType = new Map<string, BusEvent[]>();
      for (const event of parsed) {
        const group = byType.get(event.type);
        if (group) {
          group.push(event);
        } else {
          byType.set(event.type, [event]);
        }
      }

      const kept: BusEvent[] = [];
      for (const [, events] of byType) {
        const sorted = events.slice().sort((a, b) => b.version - a.version);
        kept.push(...sorted.slice(0, keepLastNPerType));
      }

      allEntries = kept;
    } finally {
      await reader.close();
    }

    if (this._walWriter) {
      await this._walWriter.close();
      this._walWriter = null;
    }

    try {
      await unlink(this.config.walFilePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') throw err;
    }

    const freshWriter = new WALWriterImpl({
      filePath: this.config.walFilePath,
      syncInterval: 0,
    });
    await freshWriter.initialize();

    allEntries.sort((a, b) => a.version - b.version);
    for (const event of allEntries) {
      await freshWriter.append({
        entityId: `event:${event.type}`,
        version: event.version,
        timestamp: event.timestamp,
        operation: 'CREATE',
        metadata: {
          _eventBus: true,
          event: JSON.stringify(event),
        },
      });
    }

    await freshWriter.close();

    this._walWriter = new WALWriterImpl({
      filePath: this.config.walFilePath,
      syncInterval: this.config.walSyncIntervalMs ?? 1000,
    });
    await this._walWriter.initialize();

    if (allEntries.length > 0) {
      const maxKeptVersion = Math.max(...allEntries.map((e) => e.version));
      if (this._versionCounter < maxKeptVersion) {
        this._versionCounter = maxKeptVersion;
      }
    }

    const entriesKept = allEntries.length;
    return {
      entriesBefore,
      entriesKept,
      entriesRemoved: entriesBefore - entriesKept,
      typesVisited: new Set(allEntries.map((e) => e.type)).size,
    };
  }

  getStats(): { published: number; received: number; subscriptions: number } {
    return { ...this._stats };
  }

  private async _onMessage(
    _topic: string,
    payload: unknown,
    _meta: PubSubMessageMetadata,
  ): Promise<void> {
    const event = payload as BusEvent;

    this._stats.received++;
    this.metrics?.counter('event.received.count', { type: event.type }).inc();

    const typeMap = this._typeHandlers.get(event.type);
    if (typeMap) {
      for (const handler of typeMap.values()) {
        try {
          await handler(event);
        } catch (err) {
          this.metrics?.counter('event.deadletter.count', { type: event.type }).inc();
          this.config.deadLetterHandler?.(event, err as Error);
        }
      }
    }

    for (const handler of this._allHandlers.values()) {
      try {
        await handler(event);
      } catch (err) {
        this.metrics?.counter('event.deadletter.count', { type: event.type }).inc();
        this.config.deadLetterHandler?.(event, err as Error);
      }
    }
  }
}
