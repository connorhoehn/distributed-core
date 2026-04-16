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
import { StateAggregator } from '../../cluster/reconciliation/StateAggregator';
import { ResourceTopologyManager } from '../../cluster/topology/ResourceTopologyManager';
import { StateDelta } from '../../cluster/delta-sync/StateDelta';
import { ClusterManager } from '../../cluster/ClusterManager';
import { DistributedSemanticsConfig, DistributedSemanticsFlags, globalSemanticsConfig } from '../../communication/semantics/DistributedSemanticsConfig';


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
export interface ResourceRegistryConfig {
  nodeId: string;
  entityRegistryType: EntityRegistryType;
  entityRegistryConfig?: any;
  stateAggregator?: StateAggregator;
  resourceTopologyManager?: ResourceTopologyManager;
  clusterManager?: ClusterManager;
  semanticsConfig?: DistributedSemanticsConfig;
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
export class ResourceRegistry extends EventEmitter {
  private entityRegistry: EntityRegistry;
  private resourceTypes = new Map<string, ResourceTypeDefinition>();
  private nodeId: string;
  private isRunning = false;
  private stateAggregator?: StateAggregator;
  private resourceTopologyManager?: ResourceTopologyManager;
  private clusterManager?: ClusterManager;
  private semanticsConfig: DistributedSemanticsConfig;

  constructor(config: ResourceRegistryConfig) {
    super();
    this.nodeId = config.nodeId;
    this.semanticsConfig = config.semanticsConfig || globalSemanticsConfig;
    this.stateAggregator = config.stateAggregator;
    this.resourceTopologyManager = config.resourceTopologyManager;
    this.clusterManager = config.clusterManager;

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
   * Create a new resource using the entity system
   */
  async createResource(resourceMetadata: ResourceMetadata): Promise<ResourceMetadata> {
    if (!this.isRunning) {
      throw new Error('ResourceRegistry is not running. Call start() first.');
    }

    // Validate resource type is registered
    const typeDefinition = this.resourceTypes.get(resourceMetadata.resourceType);
    if (!typeDefinition) {
      throw new Error(`Resource type '${resourceMetadata.resourceType}' is not registered`);
    }

    // Get optimal placement suggestion from topology manager
    const suggestedNodeId = await this.getResourcePlacementSuggestion(resourceMetadata);

    // If placement suggests a different node, create resource there instead
    if (suggestedNodeId !== this.nodeId) {
      console.log(`🎯 [ResourceRegistry] Topology suggests creating ${resourceMetadata.resourceType} ${resourceMetadata.resourceId} on node ${suggestedNodeId} instead of ${this.nodeId}`);
      return await this.createResourceOnNode(suggestedNodeId, resourceMetadata);
    }

    // Create resource locally as topology suggests this node is optimal
    console.log(`🎯 [ResourceRegistry] Creating ${resourceMetadata.resourceType} ${resourceMetadata.resourceId} locally on optimal node ${this.nodeId}`);

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

    // Call lifecycle hook
    if (typeDefinition.onResourceCreated) {
      await typeDefinition.onResourceCreated(resource);
    }

    return resource;
  }

  /**
   * Create a resource on a specific remote node
   */
  private async createResourceOnNode(targetNodeId: string, resourceMetadata: ResourceMetadata): Promise<ResourceMetadata> {
    // Clone the resource metadata and set the correct nodeId
    const remoteResourceMetadata = {
      ...resourceMetadata,
      nodeId: targetNodeId
    };

    // Send create request to the target node via cluster communication
    const createRequest = {
      type: 'resource:create-request',
      payload: {
        resourceMetadata: remoteResourceMetadata,
        requestId: `create-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        sourceNodeId: this.nodeId
      }
    };

    try {
      // Send to target node and wait for response
      await this.clusterManager?.sendCustomMessage('resource:create-request', createRequest.payload, [targetNodeId]);

      // For now, return the resource metadata (in a full implementation, we'd wait for confirmation)
      // The actual resource creation will be handled by the target node's ResourceRegistry
      console.log(`📨 [ResourceRegistry] Sent create request for ${resourceMetadata.resourceType} ${resourceMetadata.resourceId} to node ${targetNodeId}`);

      return remoteResourceMetadata;
    } catch (error) {
      console.error(`❌ [ResourceRegistry] Failed to create resource on node ${targetNodeId}:`, error);
      // Fallback: create locally if remote creation fails
      console.log(`🔄 [ResourceRegistry] Falling back to local creation for ${resourceMetadata.resourceId}`);
      return await this.createResourceLocally(resourceMetadata);
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
        console.log(`📥 [ResourceRegistry] Remote resource ${resourceMetadata.resourceId} already exists, skipping creation`);
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
      console.log(`📥 [ResourceRegistry] Successfully added remote resource ${resource.resourceId} to EntityRegistry`);

      return resource;
    } catch (error) {
      console.error(`❌ [ResourceRegistry] Failed to create remote resource ${resourceMetadata.resourceId}:`, error);
      throw error;
    }
  }

  /**
   * Handle remote resource creation request from another node
   */
  private async handleRemoteResourceCreationRequest(payload: any, senderId: string): Promise<void> {
    try {
      const { resourceMetadata, requestId, sourceNodeId } = payload;

      console.log(`📨 [ResourceRegistry] Received create request for ${resourceMetadata.resourceType} ${resourceMetadata.resourceId} from node ${sourceNodeId}`);

      // Create the resource locally
      const createdResource = await this.createResourceLocally(resourceMetadata);

      console.log(`✅ [ResourceRegistry] Successfully created ${resourceMetadata.resourceType} ${resourceMetadata.resourceId} on behalf of node ${sourceNodeId}`);

      // Send confirmation back to the requesting node (optional)
      if (this.clusterManager) {
        await this.clusterManager.sendCustomMessage('resource:create-response', {
          requestId,
          success: true,
          resourceMetadata: createdResource,
          targetNodeId: sourceNodeId
        }, [sourceNodeId]);
      }
    } catch (error) {
      console.error(`❌ [ResourceRegistry] Failed to handle remote creation request from ${senderId}:`, error);

      // Send error response (optional)
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

      console.log(`📨 [ResourceRegistry] Received cluster event ${eventType} for ${resource.resourceId} from node ${sourceNodeId}`);

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
          console.warn(`Unknown cluster resource event type: ${eventType}`);
      }

    } catch (error) {
      console.error(`❌ [ResourceRegistry] Failed to handle cluster resource event from ${senderId}:`, error);
    }
  }

  /**
   * Get a resource by ID
   */
  getResource(resourceId: string): ResourceMetadata | null {
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
   * Update a resource
   */
  async updateResource(resourceId: string, updates: Partial<ResourceMetadata>): Promise<ResourceMetadata> {
    if (!this.isRunning) {
      throw new Error('ResourceRegistry is not running. Call start() first.');
    }

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

    // Emit resource:updated event locally with previous state for external listeners
    this.emit('resource:updated', finalResource, existingResource);

    // ALSO propagate to cluster members directly
    await this.propagateResourceEventToCluster('resource:updated', finalResource, existingResource);

    return finalResource;
  }

  /**
   * Remove a resource
   */
  async removeResource(resourceId: string): Promise<void> {
    if (!this.isRunning) {
      throw new Error('ResourceRegistry is not running. Call start() first.');
    }

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
            console.warn(`Unknown resource operation: ${operation}`);
        }
      } catch (error) {
        console.error(`Failed to propagate resource ${operation} to StateAggregator:`, error);
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

      console.log(`📡 Propagated ${eventType} for ${resource.resourceId} to ${members.length} cluster members`);
    } catch (error) {
      console.error(`❌ Failed to propagate ${eventType} to cluster:`, error);
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
        console.warn(`Failed to get placement recommendation for ${resourceMetadata.resourceId}:`, error);
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
      console.log('[ResourceRegistry]', JSON.stringify(logData));
    } else {
      console.log('[ResourceRegistry]', message);
    }
  }

  async destroyResource(resourceId: string): Promise<void> {
    const resource = this.getResource(resourceId);
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
}
