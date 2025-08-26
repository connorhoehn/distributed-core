import { ConnectionManager } from '../connections/ConnectionManager';
import { Transport } from '../transport/Transport';
import { ResourceAttachmentService } from '../resources/attachment/ResourceAttachmentService';
import { ResourceManager } from '../resources/management/ResourceManager';
import { ClusterFanoutRouter } from '../resources/distribution/ClusterFanoutRouter';
import { ClusterManager } from '../cluster/ClusterManager';
import { ResourceOperation, VectorClock } from '../resources/core/ResourceOperation';

export interface ClientConnectionConfig {
  nodeId: string;
  enableAuth?: boolean;
  rateLimits?: {
    maxConnectionsPerMinute?: number;
    maxMessagesPerSecond?: number;
  };
}

/**
 * ClientConnectionService - Phase 6: Client Port
 * 
 * Responsibilities:
 * - Start ConnectionManager and client message handling
 * - Route client messages to resource management ports
 * - Handle client authentication and rate limiting
 * - Manage client connection lifecycle
 */
export class ClientConnectionService {
  private isStarted = false;

  constructor(
    private config: ClientConnectionConfig,
    private connectionManager: ConnectionManager,
    private clientTransport: Transport,
    private resourceAttachment?: ResourceAttachmentService,
    private resourceManager?: ResourceManager,
    private clusterFanoutRouter?: ClusterFanoutRouter,
    private clusterManager?: ClusterManager
  ) {}

  /**
   * Start client connection handling
   */
  async start(): Promise<void> {
    console.log('[CLIENT] Starting client connection service...');

    try {
      // ConnectionManager doesn't have start/stop methods - it's always active
      // The client transport should already be started by NetworkService

      // Set up client message routing if resource components are available
      if (this.resourceAttachment && this.resourceManager && this.clusterFanoutRouter && this.clusterManager) {
        this.setupClientMessageRouting();
      }

      // Set up connection lifecycle handlers
      this.setupConnectionLifecycle();

      this.isStarted = true;
      console.log('[CLIENT] Client connection service started');

    } catch (error) {
      console.error('[CLIENT] Failed to start client connection service:', error);
      throw new Error(`Client connection phase failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Stop client connection service
   */
  async stop(): Promise<void> {
    if (!this.isStarted) return;

    console.log('[CLIENT] Stopping client connection service...');
    
    try {
      // ConnectionManager doesn't have stop method - connections are managed by transport
      this.isStarted = false;
      console.log('[CLIENT] Client connection service stopped');
    } catch (error) {
      console.error('[CLIENT] Error stopping client connection service:', error);
      throw error;
    }
  }

  /**
   * Set up routing from client messages to resource management
   */
  private setupClientMessageRouting(): void {
    console.log('[CLIENT] Setting up client message routing to resource ports...');

    // Route client messages through proper resource management ports
    this.connectionManager.on('message', async (connectionId: string, message: any) => {
      try {
        // Handle resource operations (subscribe, publish, etc.)
        if (this.isResourceMessage(message)) {
          await this.handleResourceMessage(connectionId, message);
        }
      } catch (error) {
        console.error('[CLIENT] Failed to route client message:', error);
        
        // Send error response to client
        await this.connectionManager.send(connectionId, {
          type: 'error',
          error: 'Failed to process message',
          correlationId: message.correlationId
        });
      }
    });
  }

  /**
   * Set up connection lifecycle management
   */
  private setupConnectionLifecycle(): void {
    this.connectionManager.on('connection:opened', (connectionId: string, metadata: any) => {
      console.log(`[CLIENT] New client connection: ${connectionId}`);
      
      // Apply rate limiting if configured
      if (this.config.rateLimits) {
        // Rate limiting logic would go here
      }
    });

    this.connectionManager.on('connection:closed', (connectionId: string) => {
      console.log(`[CLIENT] Client connection closed: ${connectionId}`);
      
      // Clean up any resource attachments for this connection
      if (this.resourceAttachment) {
        // Resource attachment service should handle cleanup automatically
      }
    });
  }

  /**
   * Check if message is a resource operation
   */
  private isResourceMessage(message: any): boolean {
    const resourceTypes = ['subscribe', 'unsubscribe', 'publish', 'join', 'leave', 'resource:request'];
    return resourceTypes.includes(message.type);
  }

  /**
   * Handle resource-related messages through proper ports
   */
  private async handleResourceMessage(connectionId: string, message: any): Promise<void> {
    const resourceId = message.resourceId || message.room || message.channel;
    if (!resourceId) {
      throw new Error('Resource ID required for resource operations');
    }

    // Handle subscription operations through ResourceAttachmentService
    if (message.type === 'subscribe' || message.type === 'join') {
      await this.resourceAttachment!.attach(connectionId, resourceId, message.filters);
      
      // Send confirmation to client
      await this.connectionManager.send(connectionId, {
        type: 'subscribed',
        resourceId,
        correlationId: message.correlationId
      });
    }
    
    else if (message.type === 'unsubscribe' || message.type === 'leave') {
      await this.resourceAttachment!.detach(connectionId, resourceId);
      
      // Send confirmation to client
      await this.connectionManager.send(connectionId, {
        type: 'unsubscribed',
        resourceId,
        correlationId: message.correlationId
      });
    }
    
    // Handle publish operations through ResourceManager → ClusterFanoutRouter
    else if (message.type === 'publish' || message.type === 'resource:request') {
      await this.handlePublishMessage(connectionId, message, resourceId);
    }
  }

  /**
   * Handle publish messages through resource management ports
   */
  private async handlePublishMessage(connectionId: string, message: any, resourceId: string): Promise<void> {
    // Create resource operation
    const operation = this.createResourceOperation('UPDATE', {
      resourceId,
      nodeId: this.config.nodeId,
      payload: message.payload || message.data,
      connectionId,
      timestamp: Date.now()
    });

    // Route through cluster using ClusterFanoutRouter
    const routes = await this.clusterFanoutRouter!.route(resourceId, {
      preferPrimary: true,
      replicationFactor: 2,
      useGossipFallback: true
    });

    // Send to remote nodes via ClusterManager communication port
    for (const route of routes) {
      if (route.nodeId !== this.config.nodeId && route.nodeId !== '*') {
        await this.clusterManager!.getCommunication().sendCustomMessage(
          'resource:operation',
          { operation, resourceId, correlationId: operation.correlationId },
          [route.nodeId]
        );
      }
    }

    // Update local resource through ResourceManager port
    const resourceRegistry = (this.resourceManager as any).resourceRegistry;
    if (resourceRegistry) {
      await resourceRegistry.updateResource(resourceId, operation.payload);
    }

    // Send confirmation to client
    await this.connectionManager.send(connectionId, {
      type: 'published',
      resourceId,
      correlationId: message.correlationId
    });
  }

  /**
   * Create a proper ResourceOperation
   */
  private createResourceOperation(type: 'CREATE' | 'UPDATE' | 'DELETE', resource: any): ResourceOperation {
    const vectorClock: VectorClock = {
      nodeId: resource.nodeId || 'unknown',
      vector: new Map(),
      increment: function() { return this; },
      compare: function() { return 0; },
      merge: function(other) { return this; }
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

  /**
   * Get connection statistics
   */
  getStats(): {
    activeConnections: number;
    totalMessages: number;
    isStarted: boolean;
  } {
    return {
      activeConnections: this.connectionManager.getActiveConnectionCount(),
      totalMessages: 0, // Would need to track this in ConnectionManager
      isStarted: this.isStarted
    };
  }
}
