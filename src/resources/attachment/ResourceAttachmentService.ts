import { ConnectionManager } from '../../connections/ConnectionManager';
import { ResourceOperation } from '../core/ResourceOperation';
import { Principal } from '../security/ResourceAuthorizationService';
import { BoundedQueue, OutboundQueue, BackpressureConfig } from '../../connections/ConnectionBackpressure';
import { Logger } from '../../common/logger';


export interface SubscriptionFilter {
  resourceType?: string;
  tags?: Record<string, string>;
  eventTypes?: string[];
}

interface ResourceAttachment {
  connectionId: string;
  resourceId: string;
  filter?: SubscriptionFilter;
  attachedAt: number;
  principal?: Principal;
}

export interface DeliveryStats {
  attempted: number;
  delivered: number;
  failed: number;
  filtered: number;
}

/**
 * ResourceAttachmentService bridges resources and connections
 * 
 * Responsibilities:
 * - Track which connections are attached to which resources
 * - Deliver resource operations to local connections with flow control
 * - Handle connection disconnects and update resource membership
 * - Apply authorization and backpressure at delivery time
 */
export class ResourceAttachmentService {
  private connectionManager: ConnectionManager;
  private attachments: Map<string, ResourceAttachment> = new Map(); // connectionId -> attachment
  private resourceConnections: Map<string, Set<string>> = new Map(); // resourceId -> connectionIds
  private deliveryQueues: Map<string, OutboundQueue> = new Map(); // connectionId -> queue
  private listeners: Map<string, Function[]> = new Map(); // Simple event system
  private logger = Logger.create('ResourceAttachmentService');

  constructor(connectionManager: ConnectionManager, private flowConfig?: BackpressureConfig) {
    this.connectionManager = connectionManager;
    
    // Default flow control config
    this.flowConfig = this.flowConfig || {
      maxQueuePerConnection: 2048,
      writeTimeoutMs: 5000,
      dropPolicy: 'oldest',
      slowConsumerThresholdMs: 30000,
      maxRetries: 3
    };
    
    // Listen for connection disconnects (will implement manual polling for now)
    // TODO: Add proper disconnect event handling to ConnectionManager
  }

  // Simple event emitter methods
  emit(event: string, data: any): void {
    const handlers = this.listeners.get(event) || [];
    handlers.forEach(handler => {
      try {
        handler(data);
      } catch (error) {
        this.logger.error(`Error in event handler for ${event}:`, error);
      }
    });
  }

  on(event: string, handler: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(handler);
  }

  /**
   * Attach a connection to a resource for event delivery
   */
  async attach(connId: string, resourceId: string, filter?: SubscriptionFilter): Promise<void> {
    const attachment: ResourceAttachment = {
      connectionId: connId,
      resourceId,
      filter,
      attachedAt: Date.now(),
      principal: this.extractPrincipalFromConnection(connId)
    };

    // Store attachment
    this.attachments.set(connId, attachment);

    // Update resource -> connections mapping
    if (!this.resourceConnections.has(resourceId)) {
      this.resourceConnections.set(resourceId, new Set());
    }
    this.resourceConnections.get(resourceId)!.add(connId);

    this.logger.info(`Attached connection ${connId} to resource ${resourceId}`);
    this.emit('attachment:created', { connId, resourceId, filter });
  }

  /**
   * Detach a connection from a resource
   */
  async detach(connId: string, resourceId: string): Promise<void> {
    const attachment = this.attachments.get(connId);
    if (!attachment || attachment.resourceId !== resourceId) {
      return;
    }

    // Remove attachment
    this.attachments.delete(connId);

    // Update resource -> connections mapping
    const connections = this.resourceConnections.get(resourceId);
    if (connections) {
      connections.delete(connId);
      if (connections.size === 0) {
        this.resourceConnections.delete(resourceId);
      }
    }

    this.logger.info(`Detached connection ${connId} from resource ${resourceId}`);
    this.emit('attachment:removed', { connId, resourceId });
  }

  /**
   * Get all local connections attached to a resource
   */
  async members(resourceId: string): Promise<ReadonlySet<string>> {
    const connections = this.resourceConnections.get(resourceId);
    return connections ? new Set(connections) : new Set();
  }

  /**
   * Deliver a resource operation to all local connections attached to the resource
   * Uses proper enqueue/deliver semantics with flow control
   */
  async deliverLocal(
    resourceId: string, 
    op: ResourceOperation, 
    correlationId: string
  ): Promise<DeliveryStats> {
    const stats: DeliveryStats = {
      attempted: 0,
      delivered: 0,
      failed: 0,
      filtered: 0
    };

    const connections = this.resourceConnections.get(resourceId);
    if (!connections || connections.size === 0) {
      return stats;
    }

    const deliveryMessage = {
      type: 'resource:operation',
      resourceId,
      operation: op,
      correlationId,
      timestamp: Date.now()
    };

    for (const connId of connections) {
      stats.attempted++;

      try {
        const attachment = this.attachments.get(connId);
        if (!attachment) {
          stats.filtered++;
          continue;
        }

        // Apply filter if present
        if (attachment.filter && !this.matchesFilter(op, attachment.filter)) {
          stats.filtered++;
          continue;
        }

        // Enqueue message with flow control
        const queue = this.getOrCreateDeliveryQueue(connId);
        const result = queue.offer(deliveryMessage, { opId: op.opId, priority: 1 });

        if (result === 'enqueued') {
          // Attempt immediate delivery if connection is available
          const connection = this.connectionManager.getConnection(connId);
          if (connection && connection.isActive()) {
            await this.deliverQueuedMessages(connId, connection);
            stats.delivered++;
          } else {
            stats.failed++;
          }
        } else {
          // Message was dropped due to backpressure
          stats.failed++;
          this.logger.warn(`Message ${op.opId} ${result} for connection ${connId}`);
        }

      } catch (error) {
        this.logger.error(`Failed to deliver to connection ${connId}:`, error);
        stats.failed++;
      }
    }

    this.logger.info(`Delivered operation ${op.opId} to ${stats.delivered}/${stats.attempted} local connections for resource ${resourceId}`);
    this.emit('delivery:completed', { resourceId, operation: op, stats });

    return stats;
  }

  /**
   * Get or create delivery queue for a connection
   */
  private getOrCreateDeliveryQueue(connId: string): OutboundQueue {
    let queue = this.deliveryQueues.get(connId);
    if (!queue) {
      queue = new BoundedQueue(this.flowConfig!, connId);
      this.deliveryQueues.set(connId, queue);
    }
    return queue;
  }

  /**
   * Deliver all queued messages for a connection
   */
  private async deliverQueuedMessages(connId: string, connection: any): Promise<void> {
    const queue = this.deliveryQueues.get(connId);
    if (!queue) return;

    await queue.drain(async (data) => {
      await connection.send(data);
    });
  }

  /**
   * Handle connection disconnect - clean up all attachments and queues
   */
  async onDisconnect(connId: string): Promise<void> {
    const attachment = this.attachments.get(connId);
    if (!attachment) {
      return;
    }

    await this.detach(connId, attachment.resourceId);
    
    // Clean up delivery queue
    const queue = this.deliveryQueues.get(connId);
    if (queue) {
      queue.clear();
      this.deliveryQueues.delete(connId);
    }
    
    this.logger.info(`Cleaned up attachments and queues for disconnected connection ${connId}`);
    this.emit('connection:disconnected', { connId, resourceId: attachment.resourceId });
  }

  /**
   * Get attachment info for a connection
   */
  getAttachment(connId: string): ResourceAttachment | undefined {
    return this.attachments.get(connId);
  }

  /**
   * Get all connections attached to a resource with their attachment info
   */
  getResourceAttachments(resourceId: string): ResourceAttachment[] {
    const connections = this.resourceConnections.get(resourceId);
    if (!connections) {
      return [];
    }

    return Array.from(connections)
      .map(connId => this.attachments.get(connId))
      .filter((attachment): attachment is ResourceAttachment => !!attachment);
  }

  /**
   * Extract principal from connection metadata
   */
  private extractPrincipalFromConnection(connId: string): Principal | undefined {
    const connection = this.connectionManager.getConnection(connId);
    if (!connection) {
      return undefined;
    }

    // Extract principal from session metadata
    const userId = connection.session.getTag('userId');
    
    if (userId && typeof userId === 'string') {
      return {
        id: userId,
        type: 'user',
        attributes: {
          connectionId: connId
        }
      };
    }

    return undefined;
  }

  /**
   * Check if operation matches subscription filter
   */
  private matchesFilter(op: ResourceOperation, filter: SubscriptionFilter): boolean {
    // If no filter, allow all
    if (!filter) {
      return true;
    }

    // Check resource type if specified
    if (filter.resourceType && op.payload?.resourceType !== filter.resourceType) {
      return false;
    }

    // Check event types if specified
    if (filter.eventTypes && !filter.eventTypes.includes(op.type)) {
      return false;
    }

    // Check tags if specified
    if (filter.tags && op.payload?.tags) {
      for (const [key, value] of Object.entries(filter.tags)) {
        if (op.payload.tags[key] !== value) {
          return false;
        }
      }
    }

    return true;
  }
}
