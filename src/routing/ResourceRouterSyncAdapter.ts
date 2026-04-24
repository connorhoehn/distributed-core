import { ResourceRouter } from './ResourceRouter';
import { ResourceHandle } from './types';
import { EntityUpdate } from '../persistence/wal/types';
import { PubSubManager } from '../gateway/pubsub/PubSubManager';
import { PubSubMessageMetadata } from '../gateway/pubsub/types';
import { LifecycleAware } from '../common/LifecycleAware';

export interface ResourceRouterSyncAdapterConfig {
  topic?: string;
}

const DEFAULT_TOPIC = 'resource-router:updates';

function toEntityUpdate(handle: ResourceHandle, operation: 'CREATE' | 'DELETE' | 'TRANSFER'): EntityUpdate {
  return {
    entityId: handle.resourceId,
    ownerNodeId: handle.ownerNodeId,
    version: handle.version,
    timestamp: Date.now(),
    operation,
    metadata: handle.metadata as Record<string, any>,
  };
}

export class ResourceRouterSyncAdapter implements LifecycleAware {
  private readonly router: ResourceRouter;
  private readonly pubsub: PubSubManager;
  private readonly localNodeId: string;
  private readonly topic: string;

  private subId: string | null = null;
  private _started = false;

  private readonly _onClaimed: (handle: ResourceHandle) => void;
  private readonly _onReleased: (handle: ResourceHandle) => void;
  private readonly _onTransferred: (handle: ResourceHandle) => void;
  private readonly _onPubSub: (topic: string, payload: unknown, meta: PubSubMessageMetadata) => void;

  constructor(
    router: ResourceRouter,
    pubsub: PubSubManager,
    localNodeId: string,
    config?: ResourceRouterSyncAdapterConfig,
  ) {
    this.router = router;
    this.pubsub = pubsub;
    this.localNodeId = localNodeId;
    this.topic = config?.topic ?? DEFAULT_TOPIC;

    this._onClaimed = (handle: ResourceHandle) => {
      this.pubsub.publish(this.topic, toEntityUpdate(handle, 'CREATE')).catch(() => undefined);
    };

    this._onReleased = (handle: ResourceHandle) => {
      this.pubsub.publish(this.topic, toEntityUpdate(handle, 'DELETE')).catch(() => undefined);
    };

    this._onTransferred = (handle: ResourceHandle) => {
      this.pubsub.publish(this.topic, toEntityUpdate(handle, 'TRANSFER')).catch(() => undefined);
    };

    this._onPubSub = (_topic: string, payload: unknown, meta: PubSubMessageMetadata) => {
      if (this.subId === null) return;
      if (meta.publisherNodeId === this.localNodeId) return;
      this.router.applyRemoteUpdate(payload as EntityUpdate).catch(() => undefined);
    };
  }

  isStarted(): boolean {
    return this._started;
  }

  start(): Promise<void> {
    if (this._started) return Promise.resolve();
    this._started = true;
    this.subId = this.pubsub.subscribe(this.topic, this._onPubSub);
    this.router.on('resource:claimed', this._onClaimed);
    this.router.on('resource:released', this._onReleased);
    this.router.on('resource:transferred', this._onTransferred);
    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (!this._started) return Promise.resolve();
    this._started = false;
    if (this.subId !== null) {
      this.pubsub.unsubscribe(this.subId);
      this.subId = null;
    }
    this.router.off('resource:claimed', this._onClaimed);
    this.router.off('resource:released', this._onReleased);
    this.router.off('resource:transferred', this._onTransferred);
    return Promise.resolve();
  }
}
