import { EventEmitter } from 'events';
import { EntityRegistryFactory, EntityRegistryType } from '../../cluster/core/entity/EntityRegistryFactory';
import { InMemoryEntityRegistry } from '../../cluster/core/entity/InMemoryEntityRegistry';
import { EntityRecord, EntityRegistry } from '../../cluster/core/entity/types';
import {
  ResourceMetadata,
  ResourceTypeDefinition,
  ResourceEvent,
  ResourceEventType,
  ResourceState,
  ResourceHealth
} from '../types';
import { StateAggregator } from '../../cluster/aggregation/StateAggregator';
import { ResourceTopologyManager } from '../../cluster/topology/ResourceTopologyManager';
import { StateDelta } from '../../cluster/delta-sync/StateDelta';
import { ClusterManager } from '../../cluster/ClusterManager';
import { DistributedSemanticsConfig, DistributedSemanticsFlags, globalSemanticsConfig } from '../../communication/semantics/DistributedSemanticsConfig';
import { WALWriter, WALReader, WALEntry, EntityUpdate } from '../../persistence/types';
import { Logger } from '../../common/logger';
import { ResourceAuthorizationService, Principal } from '../security/ResourceAuthorizationService';
import { ResourceOperation } from './ResourceOperation';

/**
 * Operation types for resource WAL entries
 */
export type ResourceWALOperation = 'CREATE' | 'UPDATE' | 'DELETE';

/**
 * Structure stored in WAL entry metadata for resource operations
 */
export interface ResourceWALData {
  operation: ResourceWALOperation;
  resourceId: string;
  resourceMetadata: ResourceMetadata;
}


/**
 * Resource-Entity Bridge: Maps ResourceMetadata to EntityRecord
 * This allows us to leverage the existing EntityRegistry infrastructure
 * for resource management while maintaining the resource-specific API
 */
interface ResourceEntityRecord extends EntityRecord {
  // EntityRecord has: entityId, ownerNodeId, version, createdAt, lastUpdated, metadata
  // We map ResourceMetadata into the metadata field
}

/**
 * Configuration for the ResourceRegistry
 */
/**
 * Caller identity for authorization checks.
 * Passed to CRUD methods when an authorization service is configured.
 */
export interface Caller {
  id: string;
  roles?: string[];
}

export interface ResourceRegistryConfig {
  nodeId: string;
  entityRegistryType: EntityRegistryType;
  entityRegistryConfig?: any;
  stateAggregator?: StateAggregator;
  resourceTopologyManager?: ResourceTopologyManager;
  clusterManager?: ClusterManager;
  semanticsConfig?: DistributedSemanticsConfig;
  walWriter?: WALWriter;
  authorizationService?: ResourceAuthorizationService;
}

/**
 * ResourceRegistry: A focused facade over EntityRegistry for resource management.
 *
 * RESPONSIBILITIES (kept):
 * - CRUD operations on resources (create, read, update, remove)
 * - Resource type registration
 * - Event emission for resource lifecycle (created, updated, destroyed, migrated)
 * - Entity registry bridging (maps ResourceMetadata to EntityRecord)
 * - Cluster integration (state propagation, remote creation)
 *
 * EXTERNAL CONCERNS (removed - wire these externally via ResourceRegistry events):
 * - ResourceQueryEngine: subscribe to events and index resources externally
 * - ResourceSubscriptionManager: listen to ResourceRegistry events externally
 * - ResourceLifecycleEventSystem: listen to ResourceRegistry events externally
 * - ResourceMonitoringSystem: wire externally, consumes events
 * - ResourceOptimizationEngine: wire externally, consumes events
 *
 * EVENT ARCHITECTURE:
 * - LOCAL EVENTS: emit() calls notify local EventEmitter listeners within the same node
 * - CLUSTER EVENTS: propagateResourceEventToCluster() sends events to all cluster members
 * - This dual approach ensures both local components and remote nodes receive resource updates
 */
/**
 * A facade over {@link EntityRegistry} that provides resource-oriented CRUD,
 * type registration, cluster-aware placement, and WAL-based persistence.
 *
 * ResourceRegistry bridges the entity/record model used internally with the
 * higher-level {@link ResourceMetadata} API consumed by application code.
 * It emits lifecycle events (`resource:created`, `resource:updated`,
 * `resource:destroyed`, `resource:migrated`) both locally and across
 * the cluster so that external systems can react without coupling to
 * registry internals.
 */
export class ResourceRegistry extends EventEmitter {
  private logger = Logger.create('ResourceRegistry');
  private entityRegistry: EntityRegistry;
  private resourceTypes = new Map<string, ResourceTypeDefinition>();
  private nodeId: string;
  private isRunning = false;
  private stateAggregator?: StateAggregator;
  private resourceTopologyManager?: ResourceTopologyManager;
  private clusterManager?: ClusterManager;
  private semanticsConfig: DistributedSemanticsConfig;
  private walWriter?: WALWriter;
  private authorizationService?: ResourceAuthorizationService;

  /** Pending remote resource creation requests awaiting confirmation */
  private pendingCreateRequests = new Map<string, {
    resolve: (resource: ResourceMetadata) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /** Timeout for remote resource creation confirmation (ms) */
  private static readonly REMOTE_CREATE_TIMEOUT_MS = 5000;

  constructor(config: ResourceRegistryConfig) {
    super();
    this.nodeId = config.nodeId;
    this.semanticsConfig = config.semanticsConfig || globalSemanticsConfig;
    this.stateAggregator = config.stateAggregator;
    this.resourceTopologyManager = config.resourceTopologyManager;
    this.clusterManager = config.clusterManager;
    this.walWriter = config.walWriter;
    this.authorizationService = config.authorizationService;

    // Create the underlying EntityRegistry using the factory
    this.entityRegistry = EntityRegistryFactory.create({
      type: config.entityRegistryType,
      nodeId: config.nodeId,
      ...config.entityRegistryConfig
    });

    // Bridge entity events to resource events
    this.setupEntityEventBridge();

    // Setup cluster integration if available
    this.setupClusterIntegration();
  }

  /**
   * Register a resource type definition
   */
  registerResourceType(definition: ResourceTypeDefinition): void {
    this.resourceTypes.set(definition.typeName, definition);
  }

  /**
   * Authorize a caller for a given operation on a resource.
   * Resolves silently when no authorization service is configured.
   * @throws If the caller is not authorized.
   */
  private async authorizeOrThrow(
    caller: Caller | undefined,
    resourceId: string,
    opType: 'CREATE' | 'UPDATE' | 'DELETE' | 'READ'
  ): Promise<void> {
    if (!this.authorizationService) {
      return;
    }

    const principal: Principal = {
      id: caller?.id ?? 'anonymous',
      type: 'user',
      attributes: { roles: caller?.roles ?? [] }
    };

    const operation = {
      opId: '',
      resourceId,
      type: opType as any,
      version: 0,
      timestamp: Date.now(),
      originNodeId: this.nodeId,
      payload: {},
      vectorClock: { nodeId: this.nodeId, vector: new Map(), increment() { return this; }, compare() { return 0; }, merge() { return this; } },
      correlationId: '',
      leaseTerm: 0
    } as ResourceOperation;

    const result = await this.authorizationService.authorizeOperation(principal, operation);
    if (!result.allowed) {
      const permLabel = opType.toLowerCase();
      throw new Error(`Unauthorized: cannot ${permLabel} resource`);
    }
  }

  /**
   * Create a new resource, automatically placing it on the optimal node via the topology manager.
   * @param resourceMetadata - Metadata describing the resource to create; its `resourceType` must be registered.
   * @param caller - Optional caller identity for authorization.
   * @returns The finalised resource metadata including assigned node and timestamp.
   * @throws If the registry is not running or the resource type is unregistered.
   */
  async createResource(resourceMetadata: ResourceMetadata, caller?: Caller): Promise<ResourceMetadata> {
    if (!this.isRunning) {
      throw new Error('ResourceRegistry is not running. Call start() first.');
    }

    // Authorization check
    await this.authorizeOrThrow(caller, resourceMetadata.resourceId, 'CREATE');

    // Validate resource type is registered
    const typeDefinition = this.resourceTypes.get(resourceMetadata.resourceType);
    if (!typeDefinition) {
      throw new Error(`Resource type '${resourceMetadata.resourceType}' is not registered`);
    }

    // Get optimal placement suggestion from topology manager
    const suggestedNodeId = await this.getResourcePlacementSuggestion(resourceMetadata);

    // If placement suggests a different node, create resource there instead
    if (suggestedNodeId !== this.nodeId) {
      this.logger.info(`Topology suggests creating ${resourceMetadata.resourceType} ${resourceMetadata.resourceId} on node ${suggestedNodeId} instead of ${this.nodeId}`);
      return await this.createResourceOnNode(suggestedNodeId, resourceMetadata);
    }

    // Create resource locally as topology suggests this node is optimal
    this.logger.info(`Creating ${resourceMetadata.resourceType} ${resourceMetadata.resourceId} locally on optimal node ${this.nodeId}`);

    // Create entity record with resource metadata
    const entityRecord = await this.entityRegistry.proposeEntity(
      resourceMetadata.resourceId,
      {
        resourceType: resourceMetadata.resourceType,
        resourceMetadata: resourceMetadata,
        registryType: 'resource' // Mark this as a resource entity
      }
    );

    // Extract resource metadata from entity record
    const resource = this.entityToResource(entityRecord);

    // Persist to WAL
    await this.writeToWAL('CREATE', resource.resourceId, resource);

    // Call lifecycle hook
    if (typeDefinition.onResourceCreated) {
      await typeDefinition.onResourceCreated(resource);
    }

    return resource;
  }

  /**
   * Create a resource on a specific remote node.
   * Sends a 'resource:create-request' and waits for a confirmed
   * 'resource:create-response' from the target node (with timeout).
   */
  private async createResourceOnNode(targetNodeId: string, resourceMetadata: ResourceMetadata): Promise<ResourceMetadata> {
    // Clone the resource metadata and set the correct nodeId
    const remoteResourceMetadata = {
      ...resourceMetadata,
      nodeId: targetNodeId
    };

    const requestId = `create-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const requestPayload = {
      resourceMetadata: remoteResourceMetadata,
      requestId,
      sourceNodeId: this.nodeId
    };

    try {
      // Create a promise that will be resolved when the response arrives
      const confirmationPromise = new Promise<ResourceMetadata>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingCreateRequests.delete(requestId);
          reject(new Error(
            `Remote resource creation timed out after ${ResourceRegistry.REMOTE_CREATE_TIMEOUT_MS}ms ` +
            `for ${resourceMetadata.resourceType} ${resourceMetadata.resourceId} on node ${targetNodeId}`
          ));
        }, ResourceRegistry.REMOTE_CREATE_TIMEOUT_MS);

        this.pendingCreateRequests.set(requestId, { resolve, reject, timer });
      });

      // Send to target node
      await this.clusterManager?.sendCustomMessage('resource:create-request', requestPayload, [targetNodeId]);

      this.logger.info(`Sent create request ${requestId} for ${resourceMetadata.resourceType} ${resourceMetadata.resourceId} to node ${targetNodeId}`);

      // Wait for confirmed response or timeout
      const confirmedResource = await confirmationPromise;

      this.logger.info(`Remote creation confirmed for ${resourceMetadata.resourceType} ${resourceMetadata.resourceId} on node ${targetNodeId}`);

      return confirmedResource;
    } catch (error) {
      this.logger.error(`Failed to create resource on node ${targetNodeId}:`, error);
      // Fallback: create locally if remote creation fails or times out
      this.logger.info(`Falling back to local creation for ${resourceMetadata.resourceId}`);
      return await this.createResourceLocally(resourceMetadata);
    }
  }

  /**
   * Handle a 'resource:create-response' from a remote node, resolving the
   * pending promise so the original createResourceOnNode call completes.
   */
  private handleRemoteResourceCreationResponse(payload: any): void {
    const { requestId, success, resourceMetadata, error: remoteError } = payload;

    const pending = this.pendingCreateRequests.get(requestId);
    if (!pending) {
      // Response for an unknown or already-timed-out request; ignore.
      return;
    }

    clearTimeout(pending.timer);
    this.pendingCreateRequests.delete(requestId);

    if (success && resourceMetadata) {
      pending.resolve(resourceMetadata as ResourceMetadata);
    } else {
      pending.reject(new Error(
        `Remote node failed to create resource: ${remoteError || 'unknown error'}`
      ));
    }
  }

  /**
   * Create resource locally (internal method)
   */
  private async createResourceLocally(resourceMetadata: ResourceMetadata): Promise<ResourceMetadata> {
    const typeDefinition = this.resourceTypes.get(resourceMetadata.resourceType);
    if (!typeDefinition) {
      throw new Error(`Resource type '${resourceMetadata.resourceType}' is not registered`);
    }

    // Create entity record with resource metadata
    const entityRecord = await this.entityRegistry.proposeEntity(
      resourceMetadata.resourceId,
      {
        resourceType: resourceMetadata.resourceType,
        resourceMetadata: resourceMetadata,
        registryType: 'resource'
      }
    );

    const resource = this.entityToResource(entityRecord);

    // Call lifecycle hook
    if (typeDefinition.onResourceCreated) {
      await typeDefinition.onResourceCreated(resource);
    }

    return resource;
  }

  /**
   * Create a resource from remote cluster data (bypasses placement logic)
   * Used by ResourceDistributionEngine to add remote resources to local EntityRegistry
   */
  async createRemoteResource(resourceMetadata: ResourceMetadata): Promise<ResourceMetadata> {
    // Skip validation and placement logic for remote resources
    // These resources are already validated and placed by their origin node

    try {
      // Check if resource already exists
      const existingEntity = this.entityRegistry.getEntity(resourceMetadata.resourceId);
      if (existingEntity && this.isResourceEntity(existingEntity)) {
        this.logger.debug(`Remote resource ${resourceMetadata.resourceId} already exists, skipping creation`);
        return this.entityToResource(existingEntity);
      }

      // Create entity record for remote resource
      const entityRecord = await this.entityRegistry.proposeEntity(
        resourceMetadata.resourceId,
        {
          resourceType: resourceMetadata.resourceType,
          resourceMetadata: resourceMetadata,
          registryType: 'resource',
          isRemote: true // Mark as remote resource
        }
      );

      const resource = this.entityToResource(entityRecord);
      this.logger.info(`Successfully added remote resource ${resource.resourceId} to EntityRegistry`);

      return resource;
    } catch (error) {
      this.logger.error(`Failed to create remote resource ${resourceMetadata.resourceId}:`, error);
      throw error;
    }
  }

  /**
   * Handle remote resource creation request from another node
   */
  private async handleRemoteResourceCreationRequest(payload: any, senderId: string): Promise<void> {
    try {
      const { resourceMetadata, requestId, sourceNodeId } = payload;

      this.logger.info(`Received create request for ${resourceMetadata.resourceType} ${resourceMetadata.resourceId} from node ${sourceNodeId}`);

      // Create the resource locally
      const createdResource = await this.createResourceLocally(resourceMetadata);

      this.logger.info(`Successfully created ${resourceMetadata.resourceType} ${resourceMetadata.resourceId} on behalf of node ${sourceNodeId}`);

      // Send confirmation back to the requesting node
      if (this.clusterManager) {
        await this.clusterManager.sendCustomMessage('resource:create-response', {
          requestId,
          success: true,
          resourceMetadata: createdResource,
          targetNodeId: sourceNodeId
        }, [sourceNodeId]);
      }
    } catch (error) {
      this.logger.error(`Failed to handle remote creation request from ${senderId}:`, error);

      // Send error response so the requesting node can fall back to local creation
      if (this.clusterManager && payload.requestId) {
        await this.clusterManager.sendCustomMessage('resource:create-response', {
          requestId: payload.requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          targetNodeId: payload.sourceNodeId
        }, [payload.sourceNodeId]);
      }
    }
  }

  /**
   * Handle cluster resource events from other nodes
   * This processes resource events that were propagated across the cluster
   */
  private async handleClusterResourceEvent(clusterEvent: any, senderId: string): Promise<void> {
    try {
      const { eventType, resource, previousResource, sourceNodeId, timestamp } = clusterEvent;

      this.logger.info(`Received cluster event ${eventType} for ${resource.resourceId} from node ${sourceNodeId}`);

      // Emit the event locally so that external listeners can react
      // External components (e.g. ResourceLifecycleEventSystem, ResourceSubscriptionManager)
      // can subscribe to these events to process cluster-wide resource changes
      switch (eventType) {
        case 'resource:created':
          this.emit('resource:created', resource);
          break;
        case 'resource:updated':
          this.emit('resource:updated', resource, previousResource);
          break;
        case 'resource:destroyed':
          this.emit('resource:destroyed', resource);
          break;
        default:
          this.logger.warn(`Unknown cluster resource event type: ${eventType}`);
      }

    } catch (error) {
      this.logger.error(`Failed to handle cluster resource event from ${senderId}:`, error);
    }
  }

  /**
   * Retrieve a resource by its unique identifier, or `null` if it does not exist.
   * @param resourceId - The resource to look up.
   * @param caller - Optional caller identity for authorization.
   */
  async getResource(resourceId: string, caller?: Caller): Promise<ResourceMetadata | null> {
    // Authorization check
    await this.authorizeOrThrow(caller, resourceId, 'READ');

    const entity = this.entityRegistry.getEntity(resourceId);
    if (!entity || !this.isResourceEntity(entity)) {
      return null;
    }
    return this.entityToResource(entity);
  }

    /**
   * Get all resources in the cluster
   */
  getAllResources(): ResourceMetadata[] {
    const allEntities = this.entityRegistry.getAllKnownEntities();
    return allEntities
      .filter((entity: any) => this.isResourceEntity(entity))
      .map((entity: any) => this.entityToResource(entity));
  }

  /**
   * Apply a partial update to an existing resource and propagate the change to the cluster.
   * @param resourceId - ID of the resource to update.
   * @param updates - Fields to merge into the existing resource metadata.
   * @returns The updated resource metadata.
   * @throws If the registry is not running or the resource is not found.
   */
  async updateResource(resourceId: string, updates: Partial<ResourceMetadata>, caller?: Caller): Promise<ResourceMetadata> {
    if (!this.isRunning) {
      throw new Error('ResourceRegistry is not running. Call start() first.');
    }

    // Authorization check
    await this.authorizeOrThrow(caller, resourceId, 'UPDATE');

    const existingEntity = this.entityRegistry.getEntity(resourceId);
    if (!existingEntity || !this.isResourceEntity(existingEntity)) {
      throw new Error(`Resource '${resourceId}' not found`);
    }

    const existingResource = this.entityToResource(existingEntity);
    const updatedResource = { ...existingResource, ...updates };

    // Update the entity with new resource metadata
    const updatedEntity = await this.entityRegistry.updateEntity(resourceId, {
      resourceType: updatedResource.resourceType,
      resourceMetadata: updatedResource,
      registryType: 'resource'
    });

    const finalResource = this.entityToResource(updatedEntity);

    // Persist to WAL
    await this.writeToWAL('UPDATE', resourceId, finalResource);

    // Emit resource:updated event locally with previous state for external listeners
    this.emit('resource:updated', finalResource, existingResource);

    // ALSO propagate to cluster members directly
    await this.propagateResourceEventToCluster('resource:updated', finalResource, existingResource);

    return finalResource;
  }

  /**
   * Remove a resource by ID, invoking its type's `onResourceDestroyed` lifecycle hook and persisting the deletion to the WAL.
   * @throws If the registry is not running or the resource is not found.
   */
  async removeResource(resourceId: string, caller?: Caller): Promise<void> {
    if (!this.isRunning) {
      throw new Error('ResourceRegistry is not running. Call start() first.');
    }

    // Authorization check
    await this.authorizeOrThrow(caller, resourceId, 'DELETE');

    const entity = this.entityRegistry.getEntity(resourceId);
    if (!entity || !this.isResourceEntity(entity)) {
      throw new Error(`Resource '${resourceId}' not found`);
    }

    const resource = this.entityToResource(entity);
    const typeDefinition = this.resourceTypes.get(resource.resourceType);

    // Call lifecycle hook before removal
    if (typeDefinition?.onResourceDestroyed) {
      await typeDefinition.onResourceDestroyed(resource);
    }

    // Persist to WAL before releasing
    await this.writeToWAL('DELETE', resourceId, resource);

    await this.entityRegistry.releaseEntity(resourceId);
  }

  /**
   * Get all resources of a specific type
   */
  getResourcesByType(resourceType: string): ResourceMetadata[] {
    const entities = this.entityRegistry.getAllKnownEntities();
    return entities
      .filter((entity: EntityRecord) => this.isResourceEntity(entity) && entity.metadata?.resourceType === resourceType)
      .map((entity: EntityRecord) => this.entityToResource(entity));
  }

  /**
   * Get all resources owned by a specific node
   */
  getResourcesByNode(nodeId: string): ResourceMetadata[] {
    const entities = this.entityRegistry.getEntitiesByNode(nodeId);
    return entities
      .filter((entity: EntityRecord) => this.isResourceEntity(entity))
      .map((entity: EntityRecord) => this.entityToResource(entity));
  }

  /**
   * Get all local resources (owned by this node)
   */
  getLocalResources(): ResourceMetadata[] {
    const entities = this.entityRegistry.getLocalEntities();
    return entities
      .filter((entity: EntityRecord) => this.isResourceEntity(entity))
      .map((entity: EntityRecord) => this.entityToResource(entity));
  }

  /**
   * Transfer resource ownership to another node
   */
  async transferResource(resourceId: string, targetNodeId: string): Promise<ResourceMetadata> {
    if (!this.isRunning) {
      throw new Error('ResourceRegistry is not running. Call start() first.');
    }

    const entity = this.entityRegistry.getEntity(resourceId);
    if (!entity || !this.isResourceEntity(entity)) {
      throw new Error(`Resource '${resourceId}' not found`);
    }

    const resource = this.entityToResource(entity);
    const typeDefinition = this.resourceTypes.get(resource.resourceType);

    // Transfer the entity
    const transferredEntity = await this.entityRegistry.transferEntity(resourceId, targetNodeId);
    const transferredResource = this.entityToResource(transferredEntity);

    // Call lifecycle hook
    if (typeDefinition?.onResourceMigrated) {
      await typeDefinition.onResourceMigrated(transferredResource, entity.ownerNodeId, targetNodeId);
    }

    return transferredResource;
  }

  /**
   * Get the host node for a resource
   */
  getResourceHost(resourceId: string): string | null {
    return this.entityRegistry.getEntityHost(resourceId);
  }

  /**
   * Start the resource registry
   */
  async start(): Promise<void> {
    await this.entityRegistry.start();
    this.isRunning = true;
  }

  /**
   * Stop the resource registry
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    // Reject and clean up any pending remote creation requests
    this.pendingCreateRequests.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(new Error('ResourceRegistry is stopping'));
    });
    this.pendingCreateRequests.clear();

    await this.entityRegistry.stop();
  }

  /**
   * Convert EntityRecord to ResourceMetadata
   */
  private entityToResource(entity: EntityRecord): ResourceMetadata {
    if (!entity.metadata?.resourceMetadata) {
      throw new Error('Entity does not contain valid resource metadata');
    }

    const resourceMetadata = entity.metadata.resourceMetadata as ResourceMetadata;

    // Ensure the resource metadata has correct ownership info from entity
    return {
      ...resourceMetadata,
      nodeId: entity.ownerNodeId,
      timestamp: entity.lastUpdated
    };
  }

  /**
   * Check if an entity represents a resource
   */
  private isResourceEntity(entity: EntityRecord): boolean {
    return entity.metadata?.registryType === 'resource' &&
           entity.metadata?.resourceMetadata != null;
  }

  /**
   * Setup event bridge from EntityRegistry to ResourceRegistry
   */
  private setupEntityEventBridge(): void {
    this.entityRegistry.on('entity:created', (entity: EntityRecord) => {
      if (this.isResourceEntity(entity)) {
        const resource = this.entityToResource(entity);
        const event: ResourceEvent = {
          eventType: ResourceEventType.RESOURCE_CREATED,
          resourceId: resource.resourceId,
          resourceType: resource.resourceType,
          nodeId: resource.nodeId,
          timestamp: Date.now(),
          metadata: { entity: entity },
          type: ResourceEventType.RESOURCE_CREATED,
          data: resource
        };
        this.emit('resource:created', resource, event);
      }
    });

    this.entityRegistry.on('entity:updated', (entity: EntityRecord) => {
      if (this.isResourceEntity(entity)) {
        const resource = this.entityToResource(entity);
        const event: ResourceEvent = {
          eventType: ResourceEventType.RESOURCE_UPDATED,
          resourceId: resource.resourceId,
          resourceType: resource.resourceType,
          nodeId: resource.nodeId,
          timestamp: Date.now(),
          metadata: { entity: entity },
          type: ResourceEventType.RESOURCE_UPDATED,
          data: resource
        };
        this.emit('resource:updated', resource, event);
      }
    });

    this.entityRegistry.on('entity:deleted', (entity: EntityRecord) => {
      if (this.isResourceEntity(entity)) {
        const resource = this.entityToResource(entity);
        const event: ResourceEvent = {
          eventType: ResourceEventType.RESOURCE_DESTROYED,
          resourceId: resource.resourceId,
          resourceType: resource.resourceType,
          nodeId: resource.nodeId,
          timestamp: Date.now(),
          metadata: { entity: entity },
          type: ResourceEventType.RESOURCE_DESTROYED,
          data: resource
        };
        this.emit('resource:destroyed', resource, event);
      }
    });

    this.entityRegistry.on('entity:transferred', (entity: EntityRecord) => {
      if (this.isResourceEntity(entity)) {
        const resource = this.entityToResource(entity);
        const event: ResourceEvent = {
          eventType: ResourceEventType.RESOURCE_MIGRATED,
          resourceId: resource.resourceId,
          resourceType: resource.resourceType,
          nodeId: resource.nodeId,
          timestamp: Date.now(),
          metadata: { entity: entity },
          type: ResourceEventType.RESOURCE_MIGRATED,
          data: resource
        };
        this.emit('resource:migrated', resource, event);
      }
    });
  }

  /**
   * Setup integration with cluster infrastructure
   */
  private setupClusterIntegration(): void {
    if (this.stateAggregator) {
      // Listen for cluster state changes to detect resource placement changes
      this.stateAggregator.on('stateChanged', (aggregatedState) => {
        this.handleClusterStateChange(aggregatedState);
      });
    }

    // Listen for remote resource creation requests
    if (this.clusterManager) {
      this.clusterManager.on('custom-message', async ({ message, senderId }: { message: any, senderId: string }) => {
        if (message.type === 'resource:create-request') {
          await this.handleRemoteResourceCreationRequest(message.payload, senderId);
        } else if (message.type === 'resource:create-response') {
          this.handleRemoteResourceCreationResponse(message);
        } else if (message.type === 'resource:cluster-event') {
          await this.handleClusterResourceEvent(message, senderId);
        }
      });
    }

    // Resource events propagate to cluster state AND other cluster members
    this.on('resource:created', async (resource, event) => {
      this.propagateResourceToCluster(resource, 'created');
      await this.propagateResourceEventToCluster('resource:created', resource);
    });

    this.on('resource:updated', async (resource, event) => {
      this.propagateResourceToCluster(resource, 'updated');
      // Note: resource:updated events are already propagated in updateResource method
    });

    this.on('resource:destroyed', async (resource, event) => {
      this.propagateResourceToCluster(resource, 'destroyed');
      await this.propagateResourceEventToCluster('resource:destroyed', resource);
    });
  }

  /**
   * Handle cluster state changes that affect resources
   */
  private handleClusterStateChange(aggregatedState: any): void {
    if (aggregatedState.resources) {
      Object.entries(aggregatedState.resources).forEach(([resourceId, resourceState]: [string, any]) => {
        if (resourceState.ownerNodeId !== this.nodeId && resourceState.previousOwner === this.nodeId) {
          this.handleResourceMigration(resourceId, resourceState);
        }
      });
    }
  }

  /**
   * Propagate resource changes to cluster state
   */
  private propagateResourceToCluster(resource: ResourceMetadata, operation: string): void {
    if (this.stateAggregator) {
      try {
        switch (operation) {
          case 'created':
            this.stateAggregator.addResource(resource);
            break;
          case 'updated':
            this.stateAggregator.updateResource(resource);
            break;
          case 'destroyed':
            this.stateAggregator.removeResource(resource.resourceId);
            break;
          default:
            this.logger.warn(`Unknown resource operation: ${operation}`);
        }
      } catch (error) {
        this.logger.error(`Failed to propagate resource ${operation} to StateAggregator:`, error);
        this.emit('resource:cluster-update', {
          resourceId: resource.resourceId,
          resourceType: resource.resourceType,
          ownerNodeId: resource.nodeId,
          state: resource.state,
          health: resource.health,
          operation,
          timestamp: Date.now()
        });
      }
    }
  }

  /**
   * Propagate resource events directly to cluster members
   */
  private async propagateResourceEventToCluster(
    eventType: string,
    resource: ResourceMetadata,
    previousResource?: ResourceMetadata
  ): Promise<void> {
    if (!this.clusterManager) {
      return;
    }

    const members = this.clusterManager.membership.getAllMembers()
      .filter(m => m.status === 'ALIVE' && m.id !== this.clusterManager!.localNodeId);

    if (members.length === 0) {
      return;
    }

    const clusterEvent = {
      type: 'resource:cluster-event',
      eventType,
      resource,
      previousResource,
      sourceNodeId: this.clusterManager.localNodeId,
      timestamp: Date.now()
    };

    try {
      await this.clusterManager.sendCustomMessage(
        'resource:cluster-event',
        clusterEvent,
        members.map(m => m.id)
      );

      this.logger.info(`Propagated ${eventType} for ${resource.resourceId} to ${members.length} cluster members`);
    } catch (error) {
      this.logger.error(`Failed to propagate ${eventType} to cluster:`, error);
    }
  }

  /**
   * Handle resource migration from cluster state changes
   */
  private handleResourceMigration(resourceId: string, resourceState: any): void {
    this.emit('resource:cluster-migrated', {
      resourceId,
      fromNodeId: this.nodeId,
      toNodeId: resourceState.ownerNodeId,
      reason: resourceState.migrationReason || 'cluster-rebalancing'
    });
  }

  /**
   * Get cluster-wide resource placement suggestions
   */
  async getResourcePlacementSuggestion(resourceMetadata: ResourceMetadata): Promise<string> {
    if (this.resourceTopologyManager) {
      try {
        const distribution = await this.resourceTopologyManager.getResourceDistribution(
          resourceMetadata.resourceId,
          resourceMetadata.resourceType
        );

        return distribution.recommendedDistribution?.primaryNode || distribution.currentDistribution.primaryNode;
      } catch (error) {
        this.logger.warn(`Failed to get placement recommendation for ${resourceMetadata.resourceId}:`, error);
      }
    }

    return this.nodeId;
  }

  /**
   * Get the distributed semantics configuration
   */
  getSemanticsConfig(): DistributedSemanticsConfig {
    return this.semanticsConfig;
  }

  /**
   * Update the distributed semantics configuration
   */
  updateSemanticsConfig(config: DistributedSemanticsConfig): void {
    this.semanticsConfig = config;
  }

  /**
   * Check if a specific feature flag is enabled
   */
  private isFeatureEnabled(flag: keyof DistributedSemanticsFlags): boolean {
    return this.semanticsConfig.isEnabled(flag);
  }

  /**
   * Log with correlation context if observability tracing is enabled
   */
  private logWithContext(message: string, correlationId?: string, metadata?: any): void {
    if (this.isFeatureEnabled('obs.trace')) {
      const logData = {
        message,
        nodeId: this.nodeId,
        timestamp: Date.now(),
        correlationId,
        ...metadata
      };
      this.logger.info(JSON.stringify(logData));
    } else {
      this.logger.info(message);
    }
  }

  async destroyResource(resourceId: string): Promise<void> {
    const resource = await this.getResource(resourceId);
    if (!resource) {
      throw new Error(`Resource '${resourceId}' not found`);
    }
    await this.entityRegistry.releaseEntity(resourceId);
    this.emit('resource:destroyed', resource);
  }

  async listResources(): Promise<ResourceMetadata[]> {
    return this.entityRegistry.getAllKnownEntities()
      .filter((entity: EntityRecord) => this.isResourceEntity(entity))
      .map((entity: EntityRecord) => this.entityToResource(entity));
  }

  /**
   * Write a resource operation to the WAL for persistence.
   * No-op if no walWriter was provided (in-memory only mode).
   */
  private async writeToWAL(operation: ResourceWALOperation, resourceId: string, resourceMetadata: ResourceMetadata): Promise<void> {
    if (!this.walWriter) {
      return;
    }

    const walData: ResourceWALData = {
      operation,
      resourceId,
      resourceMetadata,
    };

    const entityUpdate: EntityUpdate = {
      entityId: resourceId,
      timestamp: Date.now(),
      version: resourceMetadata.version ?? 1,
      operation,
      ownerNodeId: resourceMetadata.nodeId,
      metadata: { resourceWAL: walData },
    };

    await this.walWriter.append(entityUpdate);
  }

  /**
   * Replay WAL entries to reconstruct in-memory resource state after a restart.
   *
   * Call this **before** {@link start} so that the registry is fully hydrated
   * before accepting new operations. Only entries tagged with resource WAL
   * metadata are replayed; all others are skipped.
   *
   * @param walReader - Reader providing ordered WAL entries to replay.
   * @returns The number of entries that were successfully replayed.
   */
  async recoverFromWAL(walReader: WALReader): Promise<{ entriesReplayed: number }> {
    let entriesReplayed = 0;

    await walReader.replay(async (entry: WALEntry) => {
      const walData = entry.data?.metadata?.resourceWAL as ResourceWALData | undefined;
      if (!walData) {
        // Not a resource WAL entry, skip
        return;
      }

      const { operation, resourceId, resourceMetadata } = walData;

      switch (operation) {
        case 'CREATE': {
          // Add directly to entity registry, bypassing placement/validation logic
          await this.entityRegistry.proposeEntity(
            resourceId,
            {
              resourceType: resourceMetadata.resourceType,
              resourceMetadata: resourceMetadata,
              registryType: 'resource',
            }
          );
          entriesReplayed++;
          break;
        }
        case 'UPDATE': {
          // Check if entity exists before updating (CREATE should have come first)
          const existing = this.entityRegistry.getEntity(resourceId);
          if (existing) {
            await this.entityRegistry.updateEntity(resourceId, {
              resourceType: resourceMetadata.resourceType,
              resourceMetadata: resourceMetadata,
              registryType: 'resource',
            });
          } else {
            // If entity doesn't exist yet (e.g., out-of-order), treat as create
            await this.entityRegistry.proposeEntity(
              resourceId,
              {
                resourceType: resourceMetadata.resourceType,
                resourceMetadata: resourceMetadata,
                registryType: 'resource',
              }
            );
          }
          entriesReplayed++;
          break;
        }
        case 'DELETE': {
          const entity = this.entityRegistry.getEntity(resourceId);
          if (entity) {
            await this.entityRegistry.releaseEntity(resourceId);
          }
          entriesReplayed++;
          break;
        }
        default:
          this.logger.warn(`Unknown WAL operation: ${operation}`);
      }
    });

    return { entriesReplayed };
  }
}
