import { EventEmitter } from 'events';
import { ResourceRegistry } from '../core/ResourceRegistry';
import { ClusterManager } from '../../cluster/ClusterManager';
import { ResourceMetadata } from '../../resources/types';
import { StateDelta, StateDeltaManager, ResourceDelta } from '../../cluster/delta-sync/StateDelta';
import { StateReconciler, ResourceConflict } from '../../cluster/reconciliation/StateReconciler';
import { DistributedSemanticsConfig, DistributedSemanticsFlags, globalSemanticsConfig } from '../../communication/semantics/DistributedSemanticsConfig';
import { ResourceOperation } from '../core/ResourceOperation';
import { OperationDeduplicator } from '../../communication/deduplication/OperationDeduplicator';
import { CausalOrderingEngine } from '../../communication/ordering/CausalOrderingEngine';
import { ResourceAttachmentService } from '../attachment/ResourceAttachmentService';
import { NodeRoute } from '../distribution/ClusterFanoutRouter';


/**
 * ResourceDistributionEngine - Connects ResourceRegistry to cluster distribution infrastructure
 * 
 * This bridges the gap between local resource creation and cluster-wide distribution
 * using your existing cluster infrastructure including gossip protocols.
 */
export class ResourceDistributionEngine extends EventEmitter {
  private resourceRegistry: ResourceRegistry;
  private clusterManager: ClusterManager;
  private deltaSyncManager: StateDeltaManager;
  private stateReconciler: StateReconciler;
  private semanticsConfig: DistributedSemanticsConfig;
  
  // Deduplication and causal ordering components
  private operationDeduplicator?: OperationDeduplicator;
  private causalOrderingEngine?: CausalOrderingEngine;
  private attachmentService?: ResourceAttachmentService;
  
  private isRunning = false;
  private resourceStore = new Map<string, ResourceMetadata>(); // Local resource cache
  private pendingConflicts = new Map<string, ResourceConflict>(); // Track conflicts awaiting resolution
  
  constructor(
    resourceRegistry: ResourceRegistry,
    clusterManager: ClusterManager,
    stateReconciler?: StateReconciler,
    semanticsConfig?: DistributedSemanticsConfig,
    options?: {
      operationDeduplicator?: OperationDeduplicator;
      causalOrderingEngine?: CausalOrderingEngine;
      attachmentService?: ResourceAttachmentService;
    }
  ) {
    super();
    this.resourceRegistry = resourceRegistry;
    this.clusterManager = clusterManager;
    this.semanticsConfig = semanticsConfig || globalSemanticsConfig;
    this.operationDeduplicator = options?.operationDeduplicator;
    this.causalOrderingEngine = options?.causalOrderingEngine;
    this.attachmentService = options?.attachmentService;
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
    console.log(`✅ [ResourceDistributionEngine] Started for node ${this.clusterManager.localNodeId}`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    console.log(`🛑 [ResourceDistributionEngine] Stopped`);
  }

  private setupEventHandlers(): void {
    // Listen for local resource creation
    this.resourceRegistry.on('resource:created', async (resource: ResourceMetadata) => {
      await this.distributeResourceToCluster(resource, 'add');
    });

    // Listen for local resource updates
    this.resourceRegistry.on('resource:updated', async (resource: ResourceMetadata) => {
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

      // Generate StateDelta for the resource
      const delta = this.deltaSyncManager.generateResourceDelta(
        operation,
        resource,
        this.clusterManager.localNodeId
      );

      // Get all cluster members except ourselves
      const members = this.clusterManager.membership.getAllMembers()
        .filter(member => member.status === 'ALIVE' && member.id !== this.clusterManager.localNodeId);

      console.log(`📡 [ResourceDistributionEngine] Distributing ${resource.resourceType} ${resource.resourceId} (${operation}) to ${members.length} nodes via StateDelta + Gossip`);

      // Send StateDelta to all cluster members via custom messages
      await this.clusterManager.sendCustomMessage(
        'resource:delta',
        delta,
        members.map(m => m.id)
      );

      // Also propagate via gossip for redundancy and eventual consistency
      if (this.clusterManager.gossipStrategy && members.length > 0) {
        const gossipPayload = {
          type: 'resource:delta',
          delta,
          sourceNodeId: this.clusterManager.localNodeId,
          timestamp: Date.now()
        };
        
        // Use the gossip strategy to send to a subset of nodes (gossip fanout)
        const gossipTargets = members.slice(0, Math.min(3, members.length)); // Gossip to max 3 nodes
        await this.clusterManager.gossipStrategy.sendGossip(gossipTargets, gossipPayload as any);
        console.log(`🗣️ [ResourceDistributionEngine] Also broadcasted via gossip protocol to ${gossipTargets.length} nodes`);
      }

      this.emit('resource:distributed', resource, members.map(m => m.id));
    } catch (error) {
      console.error(`❌ [ResourceDistributionEngine] Failed to distribute resource ${resource.resourceId}:`, error);
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

      console.log(`📥 [ResourceDistributionEngine] Received StateDelta from ${sourceNodeId} with ${delta.resources.length} resource operations`);

      // Process each resource operation in the delta
      for (const resourceOp of delta.resources) {
        const resourceId = resourceOp.resourceId;
        const existingResource = this.resourceStore.get(resourceId);

        // Check for conflicts
        if (existingResource && resourceOp.resource && this.detectResourceConflict(existingResource, resourceOp.resource)) {
          console.log(`⚠️ [ResourceDistributionEngine] Detected resource conflict for ${resourceId}`);
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
      console.error(`❌ [ResourceDistributionEngine] Failed to handle incoming StateDelta:`, error);
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

      console.log(`✅ [ResourceDistributionEngine] Resolved conflict for ${resourceId} using last-writer-wins strategy`);

      // Apply the resolved resource
      this.resourceStore.set(resourceId, resolvedResource);
      
      // Emit the resolved resource locally
      this.resourceRegistry.emit('resource:created', resolvedResource);
      
      // Remove from pending conflicts
      this.pendingConflicts.delete(resourceId);

      this.emit('resource:conflict-resolved', resolvedResource, conflict);
    } catch (error) {
      console.error(`❌ [ResourceDistributionEngine] Failed to resolve conflict for ${resourceId}:`, error);
    }
  }

  /**
   * Apply a resource operation without conflicts
   */
  private async applyResourceOperation(resourceOp: ResourceDelta, sourceNodeId: string): Promise<void> {
    try {
      switch (resourceOp.operation) {
        case 'add':
        case 'modify':
          if (resourceOp.resource) {
            this.resourceStore.set(resourceOp.resourceId, resourceOp.resource);
            console.log(`📥 [ResourceDistributionEngine] Applied ${resourceOp.operation} for ${resourceOp.resource.resourceType} ${resourceOp.resourceId} from ${sourceNodeId}`);
            
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
          console.log(`📥 [ResourceDistributionEngine] Applied delete for ${resourceOp.resourceId} from ${sourceNodeId}`);
          
          // CRITICAL FIX: Remove remote resource from EntityRegistry
          await this.removeRemoteResourceFromEntityRegistry(resourceOp.resourceId);
          
          this.resourceRegistry.emit('resource:destroyed', { resourceId: resourceOp.resourceId });
          this.emit('resource:deleted', resourceOp.resourceId, sourceNodeId);
          break;
      }
    } catch (error) {
      console.error(`❌ [ResourceDistributionEngine] Failed to apply resource operation:`, error);
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

      console.log(`🔄 [ResourceDistributionEngine] Syncing ${this.resourceStore.size} resources with new node ${nodeId} via StateDelta`);

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
      console.error(`❌ [ResourceDistributionEngine] Failed to sync resources with ${nodeId}:`, error);
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
        console.log(`📥 [ResourceDistributionEngine] Added remote resource ${resource.resourceId} to EntityRegistry`);
      } else if (operation === 'modify' && existingEntity) {
        // Update existing entity with new resource data
        await this.resourceRegistry.updateResource(resource.resourceId, resource);
        console.log(`📥 [ResourceDistributionEngine] Updated remote resource ${resource.resourceId} in EntityRegistry`);
      }
    } catch (error) {
      console.error(`❌ [ResourceDistributionEngine] Failed to add remote resource ${resource.resourceId} to EntityRegistry:`, error);
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
        console.log(`📥 [ResourceDistributionEngine] Removed remote resource ${resourceId} from EntityRegistry`);
      }
    } catch (error) {
      console.error(`❌ [ResourceDistributionEngine] Failed to remove remote resource ${resourceId} from EntityRegistry:`, error);
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
          console.log(`🔄 Duplicate operation ${operation.opId} suppressed`);
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
          console.error(`Failed to deliver operation ${operation.opId} locally:`, error);
        }
      }

      // 5. Mark as completed
      if (this.operationDeduplicator) {
        this.operationDeduplicator.markCompleted(operation, { success: true });
      }

      console.log(`✅ Successfully processed operation ${operation.opId}`);
      return true;

    } catch (error) {
      // Mark as failed
      if (this.operationDeduplicator) {
        this.operationDeduplicator.markFailed(operation, error as Error);
      }

      console.error(`Failed to process operation ${operation.opId}:`, error);
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
        console.log(`📝 Applied CREATE operation for resource ${resourceId}`);
        break;

      case 'UPDATE':
        if (this.resourceStore.has(resourceId)) {
          const existing = this.resourceStore.get(resourceId)!;
          const updated = { ...existing, ...payload };
          this.resourceStore.set(resourceId, updated);
          console.log(`📝 Applied UPDATE operation for resource ${resourceId}`);
        }
        break;

      case 'DELETE':
        this.resourceStore.delete(resourceId);
        console.log(`📝 Applied DELETE operation for resource ${resourceId}`);
        break;

      default:
        console.warn(`Unknown operation type: ${type}`);
    }
  }

  /**
   * Send operation to remote nodes via cluster communication
   * Flow: distribution.sendRemote(env, routes) uses ClusterSender.sendTo(route.nodeId, codec.encode(env))
   */
  async sendRemote(operation: ResourceOperation, routes: NodeRoute[]): Promise<void> {
    try {
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
            console.error(`Failed to send operation to node ${route.nodeId}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Failed to send remote operations:', error);
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
        nodeId: this.clusterManager.getNodeInfo().id,
        timestamp: Date.now(),
        correlationId,
        ...metadata
      };
      console.log('[ResourceDistributionEngine]', JSON.stringify(logData));
    } else {
      console.log('[ResourceDistributionEngine]', message);
    }
  }
}
