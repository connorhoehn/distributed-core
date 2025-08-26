import { IClientConnectionService } from '../ports';
import { ConnectionManager } from '../../connections/ConnectionManager';
import { ResourceOperation } from '../../resources/core/ResourceOperation';

/**
 * ClientConnectionService manages client-facing connections and resource message routing
 * Phase 6: Client Port - Contains ALL the wiring logic moved from DistributedNodeFactory
 */
export class ClientConnectionService implements IClientConnectionService {
  readonly name = 'CLIENT';
  
  private resourceMessageHandlers: Array<(connectionId: string, resourceId: string, operation: any) => void> = [];

  constructor(
    private connectionManager: ConnectionManager,
    private resourceAttachment?: any,    // ResourceAttachmentService
    private resourceManager?: any,       // ResourceManager  
    private clusterFanoutRouter?: any,   // ClusterFanoutRouter
    private clusterManager?: any,        // ClusterManager
    private integratedComms?: any        // IntegratedCommunicationLayer
  ) {}

  async run(): Promise<void> {
    this.registerResourceHandlers();
    // Connection manager is already created, just wire up the handlers
  }

  async stop(): Promise<void> {
    // Remove event listeners if needed
    // ConnectionManager lifecycle is managed externally
  }

  registerResourceHandlers(): void {
    if (!this.resourceAttachment || !this.resourceManager || !this.clusterFanoutRouter) {
      return; // Resources disabled
    }

    // === MOVED FROM DistributedNodeFactory.wireComponents() ===
    // WORKFLOW 1: Client Request → ConnectionManager → ResourceAttachmentService → ResourceManager → ClusterFanoutRouter → NetworkTransport → Remote Nodes
    
    this.connectionManager.on('message', async (connectionId: string, message: any) => {
      try {
        // Parse incoming client messages as resource operations
        if (message.type === 'resource:request' || message.type === 'publish' || message.type === 'subscribe') {
          const resourceId = message.resourceId || message.room || message.channel;
          if (!resourceId) return;

          // Step 1: ConnectionManager → ResourceAttachmentService
          if (message.type === 'subscribe' || message.type === 'join') {
            await this.resourceAttachment.attach(connectionId, resourceId, message.filters);
          } else if (message.type === 'unsubscribe' || message.type === 'leave') {
            await this.resourceAttachment.detach(connectionId, resourceId);
          }

          // Step 2: ResourceAttachmentService → ResourceManager (for publish operations)
          if (message.type === 'publish' || message.type === 'resource:request') {
            const operation = this.createResourceOperation('UPDATE', {
              resourceId,
              nodeId: this.clusterManager?.localNodeId || 'unknown',
              payload: message.payload || message.data,
              connectionId,
              timestamp: Date.now()
            });

            // Step 3: ResourceManager → ClusterFanoutRouter → NetworkTransport → Remote Nodes
            const routes = await this.clusterFanoutRouter.route(resourceId, {
              preferPrimary: true,
              replicationFactor: 2,
              useGossipFallback: true
            });
            
            // Send to remote nodes via ClusterManager
            for (const route of routes) {
              if (route.nodeId !== this.clusterManager?.localNodeId && route.nodeId !== '*') {
                await this.clusterManager.getCommunication().sendCustomMessage(
                  'resource:operation',
                  { operation, resourceId, correlationId: operation.correlationId },
                  [route.nodeId]
                );
              }
            }

            // Also trigger local resource update through the integrated comms layer
            if (this.integratedComms) {
              const encoder = new TextEncoder();
              await this.integratedComms.publisher.publishFromClient(connectionId, resourceId, 
                encoder.encode(JSON.stringify(operation.payload)));
            } else {
              // Fallback: trigger through resource manager directly
              const resourceRegistry = this.resourceManager?.resourceRegistry;
              if (resourceRegistry) {
                await resourceRegistry.updateResource(resourceId, operation.payload);
              }
            }

            // Notify resource message handlers
            this.resourceMessageHandlers.forEach(handler => {
              try {
                handler(connectionId, resourceId, operation);
              } catch (error) {
                console.error('Resource message handler error:', error);
              }
            });
          }
        }
      } catch (error) {
        console.error('Failed to process client request workflow:', error);
      }
    });

    // Handle connection cleanup
    this.connectionManager.on('connection:closed', async (connectionId: string) => {
      console.log(`🔗 Connection ${connectionId} closed, resource attachments cleaned up`);
    });

    console.log('✅ Client connection resource handlers registered');
  }

  onResourceMessage(handler: (connectionId: string, resourceId: string, operation: any) => void): void {
    this.resourceMessageHandlers.push(handler);
  }

  /**
   * Create a proper ResourceOperation from resource data
   * MOVED FROM DistributedNodeFactory
   */
  private createResourceOperation(type: 'CREATE' | 'UPDATE' | 'DELETE', resource: any): ResourceOperation {
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
