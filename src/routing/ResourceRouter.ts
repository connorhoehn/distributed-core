import { EventEmitter } from 'events';
import { ClusterManager } from '../cluster/ClusterManager';
import { EntityRegistry, EntityRecord } from '../cluster/entity/types';
import { EntityUpdate } from '../persistence/wal/types';
import { LocalPlacement } from './PlacementStrategy';
import {
  ClaimOptions,
  PlacementStrategy,
  ResourceHandle,
  ResourceRouterConfig,
  RouteTarget,
} from './types';
import { MetricsRegistry } from '../monitoring/metrics/MetricsRegistry';

const DEFAULTS: Omit<Required<ResourceRouterConfig>, 'metrics'> = {
  placement: new LocalPlacement(),
};

/**
 * ResourceRouter — the "which node owns X and how do I reach it?" primitive.
 *
 * Responsibilities:
 *  - claim(resourceId)     Own a resource on this node
 *  - release(resourceId)   Give up ownership
 *  - route(resourceId)     Find the owner's address
 *  - selectNode(resourceId) Ask the placement strategy who should own it
 *  - transfer(resourceId)  Migrate ownership to another node
 *  - Emit resource:orphaned when a node that owned resources leaves
 *
 * ResourceRouter is storage-agnostic: pass any EntityRegistry implementation
 * (InMemory for tests, WAL for durability, CRDT for multi-master).
 *
 * Cross-node sync of ownership state is the caller's responsibility. When a
 * remote node claims a resource, forward the EntityUpdate to applyRemoteUpdate()
 * so the local registry stays consistent. PubSubManager is a natural fit for
 * this propagation but is not wired in here — keeping the primitive composable.
 *
 * Lifecycle: call start() to wire listeners and start the registry; call stop()
 * to remove all listeners and stop the registry. Skipping stop() leaks listeners
 * on both the registry and the cluster.
 *
 * Events:
 *  resource:claimed      — this node claimed a resource
 *  resource:released     — this node released a resource
 *  resource:transferred  — ownership moved (local or remote)
 *  resource:orphaned     — the owning node left the cluster; handle re-assignment
 */
export class ResourceRouter extends EventEmitter {
  private readonly localNodeId: string;
  private readonly registry: EntityRegistry;
  private readonly cluster: ClusterManager;
  private readonly config: Omit<Required<ResourceRouterConfig>, 'metrics'>;
  private readonly metrics: MetricsRegistry | null;

  // Stored so they can be removed in stop()
  private readonly _onEntityCreated: (record: EntityRecord) => void;
  private readonly _onEntityTransferred: (record: EntityRecord) => void;
  private readonly _onEntityDeleted: (record: EntityRecord) => void;
  private readonly _onMemberLeft: (nodeId: string) => void;

  constructor(
    localNodeId: string,
    registry: EntityRegistry,
    cluster: ClusterManager,
    config?: ResourceRouterConfig
  ) {
    super();
    this.localNodeId = localNodeId;
    this.registry = registry;
    this.cluster = cluster;
    this.metrics = config?.metrics ?? null;
    this.config = { placement: config?.placement ?? DEFAULTS.placement };

    this._onEntityCreated = (record: EntityRecord) => {
      if (record.ownerNodeId === this.localNodeId) {
        this.emit('resource:claimed', this._toHandle(record));
      }
    };
    this._onEntityTransferred = (record: EntityRecord) => {
      this.emit('resource:transferred', this._toHandle(record));
    };
    this._onEntityDeleted = (record: EntityRecord) => {
      this.emit('resource:released', this._toHandle(record));
    };
    this._onMemberLeft = (nodeId: string) => this._handleNodeLeft(nodeId);

    this.registry.on('entity:created', this._onEntityCreated);
    this.registry.on('entity:transferred', this._onEntityTransferred);
    this.registry.on('entity:deleted', this._onEntityDeleted);
    this.cluster.on('member-left', this._onMemberLeft);
  }

  /**
   * Start the router: starts the underlying registry.
   * Call this before any claim/release/route operations.
   */
  async start(): Promise<void> {
    await this.registry.start();
  }

  /**
   * Stop the router: removes all listeners and stops the underlying registry.
   * Always call this when the router is no longer needed to prevent listener leaks.
   */
  async stop(): Promise<void> {
    this.registry.off('entity:created', this._onEntityCreated);
    this.registry.off('entity:transferred', this._onEntityTransferred);
    this.registry.off('entity:deleted', this._onEntityDeleted);
    this.cluster.off('member-left', this._onMemberLeft);
    await this.registry.stop();
  }

  // ---------------------------------------------------------------------------
  // Core API
  // ---------------------------------------------------------------------------

  /**
   * Ask the placement strategy which node should own this resource.
   * Returns the local node ID if the answer is "here", or a remote node ID
   * if the caller should forward the claim request there.
   */
  selectNode(resourceId: string, placement?: PlacementStrategy): string {
    const strategy = placement ?? this.config.placement;
    const candidates = this._getAliveNodeIds();
    return strategy.selectNode(resourceId, this.localNodeId, candidates);
  }

  /**
   * Claim ownership of a resource on THIS node.
   * Throws if the resource is already owned (by this node or another).
   * Use selectNode() first if you want placement-aware routing.
   */
  async claim(resourceId: string, options?: ClaimOptions): Promise<ResourceHandle> {
    const start = Date.now();
    try {
      const record = await this.registry.proposeEntity(
        resourceId,
        (options?.metadata as Record<string, any>) ?? {}
      );
      this.metrics?.counter('resource.claim.count', { result: 'success' }).inc();
      this.metrics?.histogram('resource.claim.latency_ms').observe(Date.now() - start);
      this.metrics?.gauge('resource.local.gauge').set(this.getOwnedResources().length);
      return this._toHandle(record);
    } catch (err) {
      this.metrics?.counter('resource.claim.count', { result: 'conflict' }).inc();
      throw err;
    }
  }

  /**
   * Release ownership of a resource.
   * No-op if this node does not own the resource or it does not exist.
   */
  async release(resourceId: string): Promise<void> {
    const entity = this.registry.getEntity(resourceId);
    if (entity === null || entity.ownerNodeId !== this.localNodeId) return;
    await this.registry.releaseEntity(resourceId);
    this.metrics?.counter('resource.release.count').inc();
    this.metrics?.gauge('resource.local.gauge').set(this.getOwnedResources().length);
  }

  /**
   * Find the current owner of a resource and return routing information.
   * Returns null if the resource is unknown or its owner is not in the
   * current membership table (e.g., orphaned after node failure).
   */
  async route(resourceId: string): Promise<RouteTarget | null> {
    const ownerNodeId = this.registry.getEntityHost(resourceId);
    if (ownerNodeId === null) return null;

    if (ownerNodeId === this.localNodeId) {
      return { nodeId: this.localNodeId, address: '', port: 0, isLocal: true };
    }

    const entry = this.cluster.getMembership().get(ownerNodeId);
    if (entry === undefined) return null;

    return {
      nodeId: ownerNodeId,
      address: entry.metadata?.address ?? '',
      port: entry.metadata?.port ?? 0,
      isLocal: false,
    };
  }

  /**
   * Returns true if this node currently owns the resource.
   */
  isLocal(resourceId: string): boolean {
    return this.registry.getEntityHost(resourceId) === this.localNodeId;
  }

  /**
   * Transfer ownership to another node.
   * Throws if targetNodeId is not in the current alive membership.
   * The remote node must subsequently call claim() or applyRemoteUpdate()
   * to acknowledge the transfer.
   */
  async transfer(resourceId: string, targetNodeId: string): Promise<ResourceHandle> {
    if (!this._getAliveNodeIds().includes(targetNodeId)) {
      throw new Error(`Cannot transfer to node "${targetNodeId}": not in alive membership`);
    }
    const record = await this.registry.transferEntity(resourceId, targetNodeId);
    this.metrics?.counter('resource.transfer.count').inc();
    return this._toHandle(record);
  }

  /**
   * Get all resources currently owned by this node.
   */
  getOwnedResources(): ResourceHandle[] {
    return this.registry.getLocalEntities().map((r) => this._toHandle(r));
  }

  /**
   * Get all resources known to this node (local + observed remote).
   */
  getAllResources(): ResourceHandle[] {
    return this.registry.getAllKnownEntities().map((r) => this._toHandle(r));
  }

  // ---------------------------------------------------------------------------
  // Cross-node sync helpers
  // ---------------------------------------------------------------------------

  /**
   * Apply an ownership update received from another node.
   * Wire this up to your PubSub or gossip layer to keep the registry
   * consistent across the cluster.
   */
  async applyRemoteUpdate(update: EntityUpdate): Promise<boolean> {
    return this.registry.applyRemoteUpdate(update);
  }

  /**
   * Get updates since a given version, for bootstrapping a new node or
   * replaying missed events.
   */
  getUpdatesAfter(version: number): EntityUpdate[] {
    return this.registry.getUpdatesAfter(version);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _handleNodeLeft(nodeId: string): void {
    const orphaned = this.registry
      .getAllKnownEntities()
      .filter((e) => e.ownerNodeId === nodeId);
    for (const entity of orphaned) {
      this.metrics?.counter('resource.orphaned.count').inc();
      this.emit('resource:orphaned', this._toHandle(entity));
    }
  }

  private _getAliveNodeIds(): string[] {
    return Array.from(this.cluster.getMembership().entries())
      .filter(([_, e]) => e.status === 'ALIVE')
      .map(([id]) => id);
  }

  private _toHandle(record: EntityRecord): ResourceHandle {
    return {
      resourceId: record.entityId,
      ownerNodeId: record.ownerNodeId,
      metadata: (record.metadata as Record<string, unknown>) ?? {},
      claimedAt: record.createdAt,
      version: record.version,
    };
  }
}
