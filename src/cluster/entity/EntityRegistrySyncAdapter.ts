import { EntityRegistry, EntityRecord } from './types';
import { EntityUpdate } from '../../persistence/wal/types';
import { PubSubManager } from '../../gateway/pubsub/PubSubManager';
import { PubSubMessageMetadata } from '../../gateway/pubsub/types';

export interface EntityRegistrySyncAdapterConfig {
  topic: string;
  onPublish?: (update: EntityUpdate) => void;
  onReceive?: (update: EntityUpdate) => void;
}

function toEntityUpdate(record: EntityRecord, operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'TRANSFER'): EntityUpdate {
  return {
    entityId: record.entityId,
    ownerNodeId: record.ownerNodeId,
    version: record.version,
    timestamp: Date.now(),
    operation,
    metadata: record.metadata as Record<string, any> | undefined,
  };
}

export class EntityRegistrySyncAdapter {
  private readonly registry: EntityRegistry;
  private readonly pubsub: PubSubManager;
  private readonly localNodeId: string;
  private readonly config: EntityRegistrySyncAdapterConfig;

  private subId: string | null = null;

  private readonly _onCreated: (record: EntityRecord) => void;
  private readonly _onUpdated: (record: EntityRecord) => void;
  private readonly _onDeleted: (record: EntityRecord) => void;
  private readonly _onTransferred: (record: EntityRecord) => void;
  private readonly _onMessage: (topic: string, payload: unknown, meta: PubSubMessageMetadata) => void;

  constructor(
    registry: EntityRegistry,
    pubsub: PubSubManager,
    localNodeId: string,
    config: EntityRegistrySyncAdapterConfig,
  ) {
    this.registry = registry;
    this.pubsub = pubsub;
    this.localNodeId = localNodeId;
    this.config = config;

    this._onCreated = (record: EntityRecord) => {
      const update = toEntityUpdate(record, 'CREATE');
      this.pubsub.publish(this.config.topic, update).catch(() => {});
      this.config.onPublish?.(update);
    };

    this._onUpdated = (record: EntityRecord) => {
      const update = toEntityUpdate(record, 'UPDATE');
      this.pubsub.publish(this.config.topic, update).catch(() => {});
      this.config.onPublish?.(update);
    };

    this._onDeleted = (record: EntityRecord) => {
      const update = toEntityUpdate(record, 'DELETE');
      this.pubsub.publish(this.config.topic, update).catch(() => {});
      this.config.onPublish?.(update);
    };

    this._onTransferred = (record: EntityRecord) => {
      const update = toEntityUpdate(record, 'TRANSFER');
      this.pubsub.publish(this.config.topic, update).catch(() => {});
      this.config.onPublish?.(update);
    };

    this._onMessage = (_topic: string, payload: unknown, meta: PubSubMessageMetadata) => {
      if (this.subId === null) return;
      if (meta.publisherNodeId === this.localNodeId) return;
      this.registry.applyRemoteUpdate(payload as EntityUpdate).catch(() => {});
      this.config.onReceive?.(payload as EntityUpdate);
    };
  }

  start(): void {
    this.subId = this.pubsub.subscribe(this.config.topic, this._onMessage);
    this.registry.on('entity:created', this._onCreated);
    this.registry.on('entity:updated', this._onUpdated);
    this.registry.on('entity:deleted', this._onDeleted);
    this.registry.on('entity:transferred', this._onTransferred);
  }

  stop(): void {
    if (this.subId !== null) {
      this.pubsub.unsubscribe(this.subId);
      this.subId = null;
    }
    this.registry.off('entity:created', this._onCreated);
    this.registry.off('entity:updated', this._onUpdated);
    this.registry.off('entity:deleted', this._onDeleted);
    this.registry.off('entity:transferred', this._onTransferred);
  }
}
