import { randomUUID } from 'crypto';
import { PubSubManager } from '../gateway/pubsub/PubSubManager';
import { PubSubMessageMetadata } from '../gateway/pubsub/types';
import { WALWriterImpl } from '../persistence/wal/WALWriter';
import { WALReaderImpl } from '../persistence/wal/WALReader';

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
  deadLetterHandler?: (event: BusEvent, error: Error) => void;
}

type TypedHandler<T = unknown> = (event: BusEvent<T>) => Promise<void>;

export class EventBus<EventMap extends Record<string, unknown> = Record<string, unknown>> {
  private readonly pubsub: PubSubManager;
  private readonly localNodeId: string;
  private readonly config: EventBusConfig;

  private _subId: string | null = null;
  private _versionCounter = 0;
  private _subIdCounter = 0;

  private readonly _typeHandlers: Map<string, Map<string, TypedHandler<unknown>>> = new Map();
  private readonly _allHandlers: Map<string, TypedHandler<unknown>> = new Map();

  private _walWriter: WALWriterImpl | null = null;

  private readonly _stats = { published: 0, received: 0, subscriptions: 0 };

  constructor(pubsub: PubSubManager, localNodeId: string, config: EventBusConfig) {
    this.pubsub = pubsub;
    this.localNodeId = localNodeId;
    this.config = config;
    this._onMessage = this._onMessage.bind(this);
  }

  async start(): Promise<void> {
    this._subId = this.pubsub.subscribe(this.config.topic, this._onMessage);

    if (this.config.walFilePath) {
      this._walWriter = new WALWriterImpl({ filePath: this.config.walFilePath, syncInterval: 0 });
      await this._walWriter.initialize();
    }
  }

  async stop(): Promise<void> {
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
      throw new Error('WAL not configured: cannot replay events');
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

    const typeMap = this._typeHandlers.get(event.type);
    if (typeMap) {
      for (const handler of typeMap.values()) {
        try {
          await handler(event);
        } catch (err) {
          this.config.deadLetterHandler?.(event, err as Error);
        }
      }
    }

    for (const handler of this._allHandlers.values()) {
      try {
        await handler(event);
      } catch (err) {
        this.config.deadLetterHandler?.(event, err as Error);
      }
    }
  }
}
