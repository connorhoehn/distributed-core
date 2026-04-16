import { Logger } from '../../common/logger';

/**
 * ResourceWiring handles resource registry events and cluster distribution
 * MOVED FROM DistributedNodeFactory.wireComponents() - Workflow 2
 */
export class ResourceWiring {
  private logger = Logger.create('ResourceWiring');
  constructor(
    private resourceManager: any,        // ResourceManager
    private resourceDistribution: any,   // ResourceDistributionEngine  
    private clusterFanoutRouter: any,    // ClusterFanoutRouter
    private clusterManager: any,         // ClusterManager
    private resourceAttachment: any      // ResourceAttachmentService
  ) {}

  /**
   * Wire up resource registry events for cluster-wide distribution
   * WORKFLOW 2: Local Resource Change → ResourceDistributionEngine → ClusterManager → NetworkTransport → All Cluster Members → ResourceAttachmentService → Local Connections
   */
  setupResourceEventHandlers(): void {
    if (!this.resourceManager || !this.resourceDistribution || !this.clusterFanoutRouter) {
      return;
    }

    // Wire ResourceManager events into ResourceDistributionEngine for cluster-wide propagation
    const resourceRegistry = this.resourceManager.resourceRegistry;
    if (!resourceRegistry) return;

    resourceRegistry.on('resource:created', async (resource: any) => {
      try {
        // Step 1: Local Resource Change → ResourceDistributionEngine
        const operation = this.createResourceOperation('CREATE', resource);
        await this.resourceDistribution.processIncomingOperation(operation);

        // Step 2: ResourceDistributionEngine → ClusterManager → NetworkTransport → All Cluster Members
        const routes = await this.clusterFanoutRouter.route(resource.resourceId, {
          preferPrimary: true,
          replicationFactor: 2,
          useGossipFallback: true
        });
        for (const route of routes) {
          if (route.nodeId !== this.clusterManager.localNodeId && route.nodeId !== '*') {
            await this.clusterManager.getCommunication().sendCustomMessage(
              'resource:cluster-update',
              { operation, resourceId: resource.resourceId, type: 'CREATE' },
              [route.nodeId]
            );
          }
        }
      } catch (error) {
        this.logger.error('Failed to distribute resource creation:', error);
      }
    });

    resourceRegistry.on('resource:updated', async (resource: any) => {
      try {
        const operation = this.createResourceOperation('UPDATE', resource);
        await this.resourceDistribution.processIncomingOperation(operation);

        const routes = await this.clusterFanoutRouter.route(resource.resourceId, {
          preferPrimary: true,
          replicationFactor: 2,
          useGossipFallback: true
        });
        for (const route of routes) {
          if (route.nodeId !== this.clusterManager.localNodeId && route.nodeId !== '*') {
            await this.clusterManager.getCommunication().sendCustomMessage(
              'resource:cluster-update',
              { operation, resourceId: resource.resourceId, type: 'UPDATE' },
              [route.nodeId]
            );
          }
        }
      } catch (error) {
        this.logger.error('Failed to distribute resource update:', error);
      }
    });

    resourceRegistry.on('resource:destroyed', async (resource: any) => {
      try {
        const operation = this.createResourceOperation('DELETE', resource);
        await this.resourceDistribution.processIncomingOperation(operation);

        const routes = await this.clusterFanoutRouter.route(resource.resourceId, {
          preferPrimary: true,
          replicationFactor: 2,
          useGossipFallback: true
        });
        for (const route of routes) {
          if (route.nodeId !== this.clusterManager.localNodeId && route.nodeId !== '*') {
            await this.clusterManager.getCommunication().sendCustomMessage(
              'resource:cluster-update',
              { operation, resourceId: resource.resourceId, type: 'DELETE' },
              [route.nodeId]
            );
          }
        }
      } catch (error) {
        this.logger.error('Failed to distribute resource deletion:', error);
      }
    });
  }

  /**
   * Handle incoming cluster messages for resource updates
   * WORKFLOW 2 Step 3: All Cluster Members → ResourceAttachmentService → Local Connections
   */
  setupClusterMessageHandlers(): void {
    if (!this.resourceAttachment || !this.clusterManager) {
      return;
    }

    // Listen for cluster events via the event emitter interface
    this.clusterManager.on('custom-message', async (data: any) => {
      try {
        // Handle workflow 1 messages (client operations from remote nodes)
        if (data.message && data.message.type === 'resource:operation') {
          // Step 3 of Workflow 1: Remote Nodes → ResourceAttachmentService → Local Connections
          await this.resourceAttachment.deliverLocal(
            data.message.resourceId,
            data.message.operation,
            data.message.correlationId || `remote-${Date.now()}`
          );
        }
        
        // Handle workflow 2 messages (cluster-wide resource changes)
        if (data.message && data.message.type === 'resource:cluster-update') {
          // Step 3 of Workflow 2: All Cluster Members → ResourceAttachmentService → Local Connections
          await this.resourceAttachment.deliverLocal(
            data.message.resourceId,
            data.message.operation,
            `cluster-update-${Date.now()}`
          );

          // Also update local resource registry to keep state consistent
          const resourceRegistry = this.resourceManager?.resourceRegistry;
          if (resourceRegistry && data.message.operation) {
            const { operation } = data.message;
            switch (operation.type) {
              case 'CREATE':
                await resourceRegistry.createResource(operation.resourceId, operation.payload);
                break;
              case 'UPDATE':
                await resourceRegistry.updateResource(operation.resourceId, operation.payload);
                break;
              case 'DELETE':
                await resourceRegistry.destroyResource(operation.resourceId);
                break;
            }
          }
        }
      } catch (error) {
        this.logger.error('Failed to process incoming cluster message:', error);
      }
    });
  }

  /**
   * Create a proper ResourceOperation from resource data
   * MOVED FROM DistributedNodeFactory
   */
  private createResourceOperation(type: 'CREATE' | 'UPDATE' | 'DELETE', resource: any): any {
    // Simple VectorClock implementation
    const vectorClock = {
      nodeId: resource.nodeId || 'unknown',
      vector: new Map(),
      increment: function() { return this; },
      compare: function() { return 0; },
      merge: function(other: any) { return this; }
    };

    return {
      opId: `${type.toLowerCase()}-${resource.resourceId}-${Date.now()}`,
      resourceId: resource.resourceId,
      type: type,
      version: resource.version || 1,
      timestamp: Date.now(),
      originNodeId: resource.nodeId || 'unknown',
      payload: resource,
      vectorClock,
      correlationId: `${type.toLowerCase()}-${Date.now()}`,
      leaseTerm: 1,
      metadata: {}
    };
  }
}
