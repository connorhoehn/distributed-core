import { EventEmitter } from 'events';
import { ResourceRegistry } from '../core/ResourceRegistry';
import { IClusterNode } from '../../cluster/ClusterEventBus';
import { ResourceMetadata } from '../../resources/types';
import { StateDelta, StateDeltaManager, ResourceDelta } from '../../cluster/delta-sync/StateDelta';
import { StateReconciler, ResourceConflict } from '../../cluster/reconciliation/StateReconciler';
import { DistributedSemanticsConfig, DistributedSemanticsFlags, globalSemanticsConfig } from '../../communication/semantics/DistributedSemanticsConfig';
import { ResourceOperation } from '../core/ResourceOperation';
import { OperationDeduplicator } from '../../communication/deduplication/OperationDeduplicator';
import { CausalOrderingEngine } from '../../communication/ordering/CausalOrderingEngine';
import { ResourceAttachmentService } from '../attachment/ResourceAttachmentService';
import { NodeRoute } from '../distribution/ClusterFanoutRouter';
import { DeliveryTracker } from './DeliveryTracker';
import { Logger } from '../../common/logger';


/**
 * ResourceDistributionEngine - Connects ResourceRegistry to cluster distribution infrastructure
 * 
 * This bridges the gap between local resource creation and cluster-wide distribution
 * using your existing cluster infrastructure including gossip protocols.
 */
export class ResourceDistributionEngine extends EventEmitter {
  private logger = Logger.create('ResourceDistributionEngine');
  private resourceRegistry: ResourceRegistry;
  private clusterManager: IClusterNode;
  private deltaSyncManager: StateDeltaManager;
  private stateReconciler: StateReconciler;
  private semanticsConfig: DistributedSemanticsConfig;
  
  // Deduplication and causal ordering components
  private operationDeduplicator?: OperationDeduplicator;
  private causalOrderingEngine?: CausalOrderingEngine;
  private attachmentService?: ResourceAttachmentService;
  private deliveryTracker?: DeliveryTracker;
  
  private isRunning = false;
  private isApplyingRemoteOperation = false;
  private resourceStore = new Map<string, ResourceMetadata>(); // Local resource cache
  private pendingConflicts = new Map<string, ResourceConflict>(); // Track conflicts awaiting resolution
  
  constructor(
    resourceRegistry: ResourceRegistry,
    clusterManager: IClusterNode,
    stateReconciler?: StateReconciler,
    semanticsConfig?: DistributedSemanticsConfig,
    options?: {
      operationDeduplicator?: OperationDeduplicator;
      causalOrderingEngine?: CausalOrderingEngine;
      attachmentService?: ResourceAttachmentService;
      deliveryTracker?: DeliveryTracker;
    }
  ) {
    super();
    this.resourceRegistry = resourceRegistry;
    this.clusterManager = clusterManager;
    this.semanticsConfig = semanticsConfig || globalSemanticsConfig;
    this.operationDeduplicator = options?.operationDeduplicator;
    this.causalOrderingEngine = options?.causalOrderingEngine;
    this.attachmentService = options?.attachmentService;
    this.deliveryTracker = options?.deliveryTracker;
    this.stateReconciler = stateReconciler || new StateReconciler({
      defaultStrategies: {
        version: 'last-writer-wins',
        stats: 'max-value',
        metadata: 'union-merge',
        missing: 'last-writer-wins'
      },
      fieldStrategies: new Map(),
      customResolvers: new Map(),
      enableAutoResolution: true,
      requireConfirmation: false,
      maxRetries: 3,
      resolutionTimeout: 30000
    });
    
    this.deltaSyncManager = new StateDeltaManager({
      maxDeltaSize: 100,
      includeFullServices: true,
      enableCausality: true,
      compressionThreshold: 1024,
      enableEncryption: false
    });
    
    this.setupEventHandlers();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.logger.info(`Started for node ${this.clusterManager.localNodeId}`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    this.logger.info('Stopped');
  }

  private setupEventHandlers(): void {
    // Listen for local resource creation
    this.resourceRegistry.on('resource:created', async (resource: ResourceMetadata) => {
      if (this.isApplyingRemoteOperation) return;
      await this.distributeResourceToCluster(resource, 'add');
    });

    // Listen for local resource updates
    this.resourceRegistry.on('resource:updated', async (resource: ResourceMetadata) => {
      if (this.isApplyingRemoteOperation) return;
      await this.distributeResourceToCluster(resource, 'modify');
    });

    // Listen for cluster membership changes
    this.clusterManager.on('member:joined', async (nodeId: string) => {
      await this.syncResourcesWithNode(nodeId);
    });

    // Listen for incoming StateDelta messages via cluster manager
    this.clusterManager.on('custom-message', async ({ message, senderId }: { message: any, senderId: string }) => {
      if (message.type === 'resource:delta') {
        await this.handleIncomingResourceDelta(message as StateDelta, senderId);
      }
    });

    // Listen for incoming ACK/NACK messages and forward to DeliveryTracker
    this.clusterManager.on('custom-message', async ({ message, senderId }: { message: any, senderId: string }) => {
      if (message.type === 'resource-operation-ack' && this.deliveryTracker) {
        const { opId, status, reason } = message.payload ?? message;
        if (status === 'acked') {
          this.deliveryTracker.receiveAck(opId, senderId);
        } else {
          this.deliveryTracker.receiveNack(opId, senderId, reason ?? 'unknown');
        }
      }
    });
  }

  /**
   * Distribute a resource to all cluster members using StateDelta via gossip
   */
  private async distributeResourceToCluster(resource: ResourceMetadata, operation: 'add' | 'modify' | 'delete'): Promise<void> {
    if (!this.isRunning) return;

    try {
      // Store locally for add/modify operations
      if (operation !== 'delete') {
        this.resourceStore.set(resource.resourceId, resource);
      } else {
        this.resourceStore.delete(resource.resourceId);
      }

      // Increment local causal clock for outgoing distribution
      if (this.causalOrderingEngine) {
        this.causalOrderingEngine.incrementClock();
      }

      // Generate StateDelta for the resource
      const delta = this.deltaSyncManager.generateResourceDelta(
        operation,
        resource,
        this.clusterManager.localNodeId
      );

      // Get all cluster members except ourselves
      const members = this.clusterManager.getAliveMembers()
        .filter(member => member.id !== this.clusterManager.localNodeId);

      this.logger.info(`Distributing ${resource.resourceType} ${resource.resourceId} (${operation}) to ${members.length} nodes via StateDelta + Gossip`);

      // Send StateDelta to all cluster members via custom messages
      await this.clusterManager.sendCustomMessage(
        'resource:delta',
        delta,
        members.map(m => m.id)
      );

      this.emit('resource:distributed', resource, members.map(m => m.id));
    } catch (error) {
      this.logger.error(`Failed to distribute resource ${resource.resourceId}:`, error);
    }
  }

  /**
   * Handle incoming resource StateDelta from other nodes with conflict resolution
   */
  private async handleIncomingResourceDelta(delta: StateDelta, sourceNodeId: string): Promise<void> {
    try {
      // Only process deltas from other nodes
      if (sourceNodeId === this.clusterManager.localNodeId) {
        return;
      }

      this.logger.info(`Received StateDelta from ${sourceNodeId} with ${delta.resources.length} resource operations`);

      // Process each resource operation in the delta
      for (const resourceOp of delta.resources) {
        const resourceId = resourceOp.resourceId;
        const existingResource = this.resourceStore.get(resourceId);

        // Check for conflicts
        if (existingResource && resourceOp.resource && this.detectResourceConflict(existingResource, resourceOp.resource)) {
          this.logger.warn(`Detected resource conflict for ${resourceId}`);
          await this.handleResourceConflict(resourceId, existingResource, resourceOp.resource, sourceNodeId);
        } else {
          // No conflict, use processIncomingOperation for dedup/causal ordering
          if (resourceOp.resource) {
            // Convert ResourceDelta to ResourceOperation
            const operation: ResourceOperation = {
              opId: `delta-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              resourceId: resourceOp.resourceId,
              type: resourceOp.operation === 'add' ? 'CREATE' : 
                    resourceOp.operation === 'modify' ? 'UPDATE' : 'DELETE',
              version: 1, // Default version since ResourceMetadata doesn't have version field
              timestamp: resourceOp.resource.timestamp || Date.now(),
              originNodeId: sourceNodeId,
              payload: resourceOp.resource,
              vectorClock: {
                nodeId: sourceNodeId,
                vector: new Map([[sourceNodeId, 1]]),
                increment: function() { return this; },
                compare: function() { return 0; },
                merge: function() { return this; }
              },
              correlationId: `delta-${resourceOp.resourceId}-${sourceNodeId}`,
              leaseTerm: 1 // Default lease term
            };

            await this.processIncomingOperation(operation);
          } else {
            // Fallback to original method for deletes without resource data
            await this.applyResourceOperation(resourceOp, sourceNodeId);
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to handle incoming StateDelta:', error);
    }
  }

  /**
   * Detect if there's a conflict between two resource versions
   */
  private detectResourceConflict(existing: ResourceMetadata, incoming: ResourceMetadata): boolean {
    // Simple conflict detection based on timestamps and different content
    if (existing.timestamp !== incoming.timestamp) {
      // Check if they're significantly different (not just metadata changes)
      const existingContentHash = this.getResourceContentHash(existing);
      const incomingContentHash = this.getResourceContentHash(incoming);
      return existingContentHash !== incomingContentHash;
    }
    return false;
  }

  /**
   * Handle resource conflict using StateReconciler
   */
  private async handleResourceConflict(
    resourceId: string,
    existing: ResourceMetadata,
    incoming: ResourceMetadata,
    sourceNodeId: string
  ): Promise<void> {
    this.isApplyingRemoteOperation = true;
    try {
      // Create conflict data structure
      const conflictingVersions = new Map<string, ResourceMetadata>();
      conflictingVersions.set(this.clusterManager.localNodeId, existing);
      conflictingVersions.set(sourceNodeId, incoming);

      const conflict = this.stateReconciler.createResourceConflict(
        resourceId,
        conflictingVersions,
        'version',
        `Resource ${resourceId} has conflicting versions between nodes ${this.clusterManager.localNodeId} and ${sourceNodeId}`
      );

      // Store pending conflict
      this.pendingConflicts.set(resourceId, conflict);

      // Resolve the conflict using StateReconciler
      const resolvedResource = await this.stateReconciler.resolveResourceConflict(conflict, 'last-writer-wins');

      this.logger.info(`Resolved conflict for ${resourceId} using last-writer-wins strategy`);

      // Apply the resolved resource
      this.resourceStore.set(resourceId, resolvedResource);

      // Emit the resolved resource locally
      this.resourceRegistry.emit('resource:created', resolvedResource);

      // Remove from pending conflicts
      this.pendingConflicts.delete(resourceId);

      this.emit('resource:conflict-resolved', resolvedResource, conflict);
    } catch (error) {
      this.logger.error(`Failed to resolve conflict for ${resourceId}:`, error);
    } finally {
      this.isApplyingRemoteOperation = false;
    }
  }

  /**
   * Apply a resource operation without conflicts
   */
  private async applyResourceOperation(resourceOp: ResourceDelta, sourceNodeId: string): Promise<void> {
    this.isApplyingRemoteOperation = true;
    try {
      switch (resourceOp.operation) {
        case 'add':
        case 'modify':
          if (resourceOp.resource) {
            this.resourceStore.set(resourceOp.resourceId, resourceOp.resource);
            this.logger.info(`Applied ${resourceOp.operation} for ${resourceOp.resource.resourceType} ${resourceOp.resourceId} from ${sourceNodeId}`);

            // CRITICAL FIX: Add remote resource to local EntityRegistry
            await this.addRemoteResourceToEntityRegistry(resourceOp.resource, resourceOp.operation);

            // Emit the resource event locally to trigger application handlers
            const eventType = resourceOp.operation === 'add' ? 'resource:created' : 'resource:updated';
            this.resourceRegistry.emit(eventType, resourceOp.resource);
            this.emit('resource:received', resourceOp.resource, sourceNodeId);
          }
          break;
        case 'delete':
          this.resourceStore.delete(resourceOp.resourceId);
          this.logger.info(`Applied delete for ${resourceOp.resourceId} from ${sourceNodeId}`);

          // CRITICAL FIX: Remove remote resource from EntityRegistry
          await this.removeRemoteResourceFromEntityRegistry(resourceOp.resourceId);

          this.resourceRegistry.emit('resource:destroyed', { resourceId: resourceOp.resourceId });
          this.emit('resource:deleted', resourceOp.resourceId, sourceNodeId);
          break;
      }
    } catch (error) {
      this.logger.error('Failed to apply resource operation:', error);
    } finally {
      this.isApplyingRemoteOperation = false;
    }
  }

  /**
   * Generate a content hash for conflict detection
   */
  private getResourceContentHash(resource: ResourceMetadata): string {
    const contentForHash = {
      resourceType: resource.resourceType,
      capacity: resource.capacity,
      performance: resource.performance,
      state: resource.state,
      health: resource.health
    };
    return JSON.stringify(contentForHash);
  }

  /**
   * Sync all local resources with a newly joined node using StateDelta
   */
  private async syncResourcesWithNode(nodeId: string): Promise<void> {
    try {
      if (this.resourceStore.size === 0) return;

      this.logger.info(`Syncing ${this.resourceStore.size} resources with new node ${nodeId} via StateDelta`);

      // Send each resource as a StateDelta to the new node
      for (const resource of this.resourceStore.values()) {
        const delta = this.deltaSyncManager.generateResourceDelta(
          'add',
          resource,
          this.clusterManager.localNodeId
        );

        await this.clusterManager.sendCustomMessage(
          'resource:delta',
          delta,
          [nodeId]
        );
      }
    } catch (error) {
      this.logger.error(`Failed to sync resources with ${nodeId}:`, error);
    }
  }

  /**
   * Get all distributed resources
   */
  getAllResources(): ResourceMetadata[] {
    return Array.from(this.resourceStore.values());
  }

  /**
   * Get resources by type
   */
  getResourcesByType(resourceType: string): ResourceMetadata[] {
    return Array.from(this.resourceStore.values())
      .filter(resource => resource.resourceType === resourceType);
  }

  /**
   * Get resource by ID
   */
  getResource(resourceId: string): ResourceMetadata | undefined {
    return this.resourceStore.get(resourceId);
  }

  /**
   * Get pending conflicts
   */
  getPendingConflicts(): ResourceConflict[] {
    return Array.from(this.pendingConflicts.values());
  }

  /**
   * Add a remote resource to the local EntityRegistry for proper integration
   * This ensures remote resources are accessible via ResourceRegistry methods
   */
  private async addRemoteResourceToEntityRegistry(resource: ResourceMetadata, operation: 'add' | 'modify'): Promise<void> {
    try {
      // Check if resource already exists in EntityRegistry
      const existingEntity = await this.resourceRegistry.getResource(resource.resourceId);
      
      if (operation === 'add' || !existingEntity) {
        // Create a new entity record for the remote resource
        await this.resourceRegistry.createRemoteResource(resource);
        this.logger.info(`Added remote resource ${resource.resourceId} to EntityRegistry`);
      } else if (operation === 'modify' && existingEntity) {
        // Update existing entity with new resource data
        await this.resourceRegistry.updateResource(resource.resourceId, resource);
        this.logger.info(`Updated remote resource ${resource.resourceId} in EntityRegistry`);
      }
    } catch (error) {
      this.logger.error(`Failed to add remote resource ${resource.resourceId} to EntityRegistry:`, error);
      // Continue execution - resource still exists in resourceStore cache
    }
  }

  /**
   * Remove a remote resource from the local EntityRegistry
   */
  private async removeRemoteResourceFromEntityRegistry(resourceId: string): Promise<void> {
    try {
      const existingResource = await this.resourceRegistry.getResource(resourceId);
      if (existingResource) {
        await this.resourceRegistry.removeResource(resourceId);
        this.logger.info(`Removed remote resource ${resourceId} from EntityRegistry`);
      }
    } catch (error) {
      this.logger.error(`Failed to remove remote resource ${resourceId} from EntityRegistry:`, error);
      // Continue execution - resource removed from resourceStore cache anyway
    }
  }

  /**
   * Get StateReconciler for direct access
   */
  getStateReconciler(): StateReconciler {
    return this.stateReconciler;
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
   * Process incoming resource operation with deduplication and causal ordering
   */
  async processIncomingOperation(operation: ResourceOperation): Promise<boolean> {
    try {
      // 1. Check for deduplication
      if (this.operationDeduplicator) {
        const isDuplicate = this.operationDeduplicator.isDuplicate(operation);
        if (isDuplicate) {
          this.logger.debug(`Duplicate operation ${operation.opId} suppressed`);
          return false;
        }
        
        // Mark as processing
        this.operationDeduplicator.markProcessing(operation);
      }

      // 2. Use causal ordering engine to process
      if (this.causalOrderingEngine) {
        await this.causalOrderingEngine.processOperation(operation, async (op) => {
          await this.applyOperationToResource(op);
        });
      } else {
        // 3. Apply operation directly if no causal ordering
        await this.applyOperationToResource(operation);
      }

      // 4. Deliver to local subscribers if attachment service available
      if (this.attachmentService) {
        try {
          await this.attachmentService.deliverLocal(
            operation.resourceId,
            operation,
            operation.correlationId
          );
        } catch (error) {
          this.logger.error(`Failed to deliver operation ${operation.opId} locally:`, error);
        }
      }

      // 5. Mark as completed
      if (this.operationDeduplicator) {
        this.operationDeduplicator.markCompleted(operation, { success: true });
      }

      // 6. Emit event for cross-node subscription notification
      this.emit('remote-resource-operation', operation);

      // 7. Send ACK back to the origin node (best-effort)
      if (operation.originNodeId && operation.originNodeId !== this.clusterManager.localNodeId) {
        try {
          await this.clusterManager.sendCustomMessage(
            'resource-operation-ack',
            { opId: operation.opId, status: 'acked' },
            [operation.originNodeId]
          );
        } catch (ackError) {
          // ACK is best-effort; don't fail the operation if the ACK can't be sent
          this.logger.warn(`Failed to send ACK for ${operation.opId}:`, ackError);
        }
      }

      this.logger.info(`Successfully processed operation ${operation.opId}`);
      return true;

    } catch (error) {
      // Mark as failed
      if (this.operationDeduplicator) {
        this.operationDeduplicator.markFailed(operation, error as Error);
      }

      // Send NACK back to the origin node (best-effort)
      if (operation.originNodeId && operation.originNodeId !== this.clusterManager.localNodeId) {
        try {
          await this.clusterManager.sendCustomMessage(
            'resource-operation-ack',
            { opId: operation.opId, status: 'failed', reason: (error as Error).message },
            [operation.originNodeId]
          );
        } catch (_) {
          // Best-effort NACK
        }
      }

      this.logger.error(`Failed to process operation ${operation.opId}:`, error);
      return false;
    }
  }

  /**
   * Apply operation to resource
   */
  private async applyOperationToResource(operation: ResourceOperation): Promise<void> {
    const { resourceId, type, payload } = operation;

    switch (type) {
      case 'CREATE':
        this.resourceStore.set(resourceId, payload);
        this.logger.debug(`Applied CREATE operation for resource ${resourceId}`);
        break;

      case 'UPDATE':
        if (this.resourceStore.has(resourceId)) {
          const existing = this.resourceStore.get(resourceId)!;
          const updated = { ...existing, ...payload };
          this.resourceStore.set(resourceId, updated);
          this.logger.debug(`Applied UPDATE operation for resource ${resourceId}`);
        }
        break;

      case 'DELETE':
        this.resourceStore.delete(resourceId);
        this.logger.debug(`Applied DELETE operation for resource ${resourceId}`);
        break;

      default:
        this.logger.warn(`Unknown operation type: ${type}`);
    }
  }

  /**
   * Send operation to remote nodes via cluster communication
   * Flow: distribution.sendRemote(env, routes) uses ClusterSender.sendTo(route.nodeId, codec.encode(env))
   */
  async sendRemote(operation: ResourceOperation, routes: NodeRoute[]): Promise<void> {
    try {
      // Increment local causal clock for outgoing operation
      if (this.causalOrderingEngine) {
        this.causalOrderingEngine.incrementClock();
      }

      for (const route of routes) {
        if (route.deliveryMethod === 'direct') { // Only send direct routes (skip gossip)
          try {
            // Send operation via cluster communication
            await this.clusterManager.sendCustomMessage('resource:operation', { operation }, [route.nodeId]);
            
            this.logWithContext(
              `Sent operation ${operation.opId} to remote node ${route.nodeId}`,
              operation.correlationId,
              { placement: route.resourcePlacement, nodeId: route.nodeId }
            );
          } catch (error) {
            this.logger.error(`Failed to send operation to node ${route.nodeId}:`, error);
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to send remote operations:', error);
      throw error;
    }
  }

  /**
   * Receive and process operation from remote nodes
   * Flow: receiveRemote → dedup → causal → apply → attachment.deliverLocal
   */
  async receiveRemote(operation: ResourceOperation): Promise<void> {
    this.logWithContext(
      `Received remote operation ${operation.opId} from ${operation.originNodeId}`,
      operation.correlationId,
      { type: operation.type, resourceId: operation.resourceId }
    );
    
    // Use existing processIncomingOperation which handles dedup/causal/apply
    await this.processIncomingOperation(operation);
  }

  /**
   * Log with correlation context if observability tracing is enabled
   */
  private logWithContext(message: string, correlationId?: string, metadata?: any): void {
    if (this.isFeatureEnabled('obs.trace')) {
      const logData = {
        message,
        nodeId: this.clusterManager.localNodeId,
        timestamp: Date.now(),
        correlationId,
        ...metadata
      };
      this.logger.info(JSON.stringify(logData));
    } else {
      this.logger.info(message);
    }
  }
}
