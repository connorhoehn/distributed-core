import { EntityRegistry, EntityRecord } from './types';
import { EntityUpdate } from '../../persistence/wal/types';
import { PubSubManager } from '../../gateway/pubsub/PubSubManager';
import { PubSubMessageMetadata } from '../../gateway/pubsub/types';
import { LifecycleAware } from '../../common/LifecycleAware';
import { NotStartedError } from '../../common/errors';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EntityRegistryBootstrapperConfig {
  /** PubSub topic used for bootstrap requests and responses. Default: 'cluster.entity-bootstrap' */
  topic?: string;
  /** How long to wait for snapshot responses from peers, in ms. Default: 3000 */
  responseTimeoutMs?: number;
  /**
   * Minimum number of peers expected to reply. If fewer respond, the result
   * still resolves (not an error) and `metMinResponders` will be false.
   * Default: 1
   */
  minResponders?: number;
}

// ---------------------------------------------------------------------------
// Protocol message shapes
// ---------------------------------------------------------------------------

interface SnapshotRequest {
  kind: 'snapshot-request';
  requestId: string;
  fromNodeId: string;
}

interface SnapshotResponse {
  kind: 'snapshot-response';
  requestId: string;
  fromNodeId: string;
  entities: EntityRecord[];
}

type BootstrapMessage = SnapshotRequest | SnapshotResponse;

// ---------------------------------------------------------------------------
// Bootstrap result
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  respondersCount: number;
  entitiesMerged: number;
  /** True when respondersCount >= minResponders. */
  metMinResponders: boolean;
}

// ---------------------------------------------------------------------------
// Pending-request tracker
// ---------------------------------------------------------------------------

interface PendingRequest {
  responses: SnapshotResponse[];
  resolve: (responses: SnapshotResponse[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// EntityRegistryBootstrapper
// ---------------------------------------------------------------------------

const DEFAULT_TOPIC = 'cluster.entity-bootstrap';
const DEFAULT_RESPONSE_TIMEOUT_MS = 3000;
const DEFAULT_MIN_RESPONDERS = 1;

function toEntityUpdate(record: EntityRecord): EntityUpdate {
  return {
    entityId: record.entityId,
    ownerNodeId: record.ownerNodeId,
    version: record.version,
    timestamp: record.lastUpdated,
    operation: 'CREATE',
    metadata: record.metadata,
  };
}

export class EntityRegistryBootstrapper implements LifecycleAware {
  private readonly registry: EntityRegistry;
  private readonly pubsub: PubSubManager;
  private readonly localNodeId: string;

  private readonly topic: string;
  private readonly responseTimeoutMs: number;
  private readonly minResponders: number;

  private subId: string | null = null;
  private _started = false;

  /** requestId → pending request state */
  private readonly _pendingRequests: Map<string, PendingRequest> = new Map();

  private readonly _onMessage: (
    topic: string,
    payload: unknown,
    meta: PubSubMessageMetadata,
  ) => void;

  constructor(
    registry: EntityRegistry,
    pubsub: PubSubManager,
    localNodeId: string,
    config?: EntityRegistryBootstrapperConfig,
  ) {
    this.registry = registry;
    this.pubsub = pubsub;
    this.localNodeId = localNodeId;

    this.topic = config?.topic ?? DEFAULT_TOPIC;
    this.responseTimeoutMs = config?.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.minResponders = config?.minResponders ?? DEFAULT_MIN_RESPONDERS;

    this._onMessage = (_topic: string, payload: unknown, meta: PubSubMessageMetadata) => {
      // Ignore our own messages
      if (meta.publisherNodeId === this.localNodeId) return;

      const msg = payload as BootstrapMessage;

      if (msg?.kind === 'snapshot-request') {
        // Another node wants our snapshot — reply immediately
        const response: SnapshotResponse = {
          kind: 'snapshot-response',
          requestId: msg.requestId,
          fromNodeId: this.localNodeId,
          entities: this.registry.getAllKnownEntities(),
        };
        this.pubsub.publish(this.topic, response).catch(() => {});
      } else if (msg?.kind === 'snapshot-response') {
        // A peer is answering one of our bootstrap requests
        const pending = this._pendingRequests.get(msg.requestId);
        if (pending) {
          pending.responses.push(msg);
        }
      }
    };
  }

  // ---------------------------------------------------------------------------
  // LifecycleAware
  // ---------------------------------------------------------------------------

  isStarted(): boolean {
    return this._started;
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this.subId = this.pubsub.subscribe(this.topic, this._onMessage);
  }

  async stop(): Promise<void> {
    if (!this._started) return;
    this._started = false;

    if (this.subId !== null) {
      this.pubsub.unsubscribe(this.subId);
      this.subId = null;
    }

    // Cancel and discard all pending bootstrap requests
    for (const [requestId, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve(pending.responses);
      this._pendingRequests.delete(requestId);
    }
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  /**
   * Fetch snapshots from peers and merge them into the local registry.
   * Must be called after start(). Resolves regardless of whether the
   * minimum number of peers responded — callers can inspect `metMinResponders`.
   */
  async bootstrap(): Promise<BootstrapResult> {
    if (!this._started) {
      throw new NotStartedError('EntityRegistryBootstrapper');
    }

    const requestId = `bootstrap-${this.localNodeId}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;

    // Set up a collector that resolves when the timeout fires
    const responses = await new Promise<SnapshotResponse[]>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this._pendingRequests.get(requestId);
        if (pending) {
          this._pendingRequests.delete(requestId);
          resolve(pending.responses);
        }
      }, this.responseTimeoutMs);

      const pending: PendingRequest = {
        responses: [],
        resolve,
        timer,
      };
      this._pendingRequests.set(requestId, pending);

      // Publish the request after the tracker is registered so we don't miss
      // any synchronous (in-process) replies
      this.pubsub.publish(this.topic, {
        kind: 'snapshot-request',
        requestId,
        fromNodeId: this.localNodeId,
      } satisfies SnapshotRequest).catch(() => {});
    });

    // Clean up in case stop() already resolved this
    this._pendingRequests.delete(requestId);

    // Deduplicate: for each entity, keep only the record with the highest version
    const best = new Map<string, EntityRecord>();
    for (const response of responses) {
      for (const record of response.entities) {
        const existing = best.get(record.entityId);
        if (!existing || record.version > existing.version) {
          best.set(record.entityId, record);
        }
      }
    }

    // Apply each winning record as a CREATE update
    let entitiesMerged = 0;
    for (const record of best.values()) {
      const update = toEntityUpdate(record);
      const applied = await this.registry.applyRemoteUpdate(update);
      if (applied) {
        entitiesMerged++;
      }
    }

    const respondersCount = responses.length;

    return {
      respondersCount,
      entitiesMerged,
      metMinResponders: respondersCount >= this.minResponders,
    };
  }
}
