import { EventEmitter } from 'events';
import { EntityRegistry, EntityRecord } from '../entity/types';
import { EntityRegistryFactory, EntityRegistryType } from '../entity/EntityRegistryFactory';
import {
  ResourceMetadata,
  ResourceTypeDefinition,
  ResourceEvent,
  ResourceEventType,
  ResourceState,
  ResourceHealth,
  DistributionStrategy
} from './types';

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
}

/**
 * ResourceRegistry: A facade over EntityRegistry for resource management
 * 
 * This bridges the gap between the existing EntityRegistry infrastructure
 * and the new ResourceMetadata system, allowing us to leverage the
 * distributed entity management capabilities for generic resources.
 */
export class ResourceRegistry extends EventEmitter {
  private entityRegistry: EntityRegistry;
  private resourceTypes = new Map<string, ResourceTypeDefinition>();
  private nodeId: string;
  private isRunning = false;

  constructor(config: ResourceRegistryConfig) {
    super();
    this.nodeId = config.nodeId;
    
    // Create the underlying EntityRegistry using the factory
    this.entityRegistry = EntityRegistryFactory.create({
      type: config.entityRegistryType,
      nodeId: config.nodeId,
      ...config.entityRegistryConfig
    });

    // Bridge entity events to resource events
    this.setupEntityEventBridge();
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

    return this.entityToResource(updatedEntity);
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
      .filter(entity => this.isResourceEntity(entity) && entity.metadata?.resourceType === resourceType)
      .map(entity => this.entityToResource(entity));
  }

  /**
   * Get all resources owned by a specific node
   */
  getResourcesByNode(nodeId: string): ResourceMetadata[] {
    const entities = this.entityRegistry.getEntitiesByNode(nodeId);
    return entities
      .filter(entity => this.isResourceEntity(entity))
      .map(entity => this.entityToResource(entity));
  }

  /**
   * Get all local resources (owned by this node)
   */
  getLocalResources(): ResourceMetadata[] {
    const entities = this.entityRegistry.getLocalEntities();
    return entities
      .filter(entity => this.isResourceEntity(entity))
      .map(entity => this.entityToResource(entity));
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
          metadata: { entity: entity }
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
          metadata: { entity: entity }
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
          metadata: { entity: entity }
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
          metadata: { entity: entity }
        };
        this.emit('resource:migrated', resource, event);
      }
    });
  }
}
