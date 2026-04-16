import { EventEmitter } from 'events';
import { ResourceMetadata, ResourceState, ResourceHealth } from '../types';
import { ResourceRegistry } from '../core/ResourceRegistry';
import { IClusterNode } from '../../cluster/ClusterEventBus';
import { ResourceAttachmentService } from '../attachment/ResourceAttachmentService';
import { DeliveryGuard } from '../../communication/delivery/DeliveryGuard';


export interface SubscriptionFilter {
  resourceIds?: string[];
  resourceTypes?: string[];
  states?: ResourceState[];
  healthStatus?: ResourceHealth[];
  nodeIds?: string[];
  tags?: string[];
  metadata?: Record<string, any>;
}

export interface ResourceSubscription {
  subscriptionId: string;
  clientId: string;
  nodeId: string;
  filter: SubscriptionFilter;
  createdAt: number;
  lastActivity: number;
  isActive: boolean;
}

export interface SubscriptionEvent {
  eventType: 'resource:created' | 'resource:updated' | 'resource:destroyed' | 'resource:state-changed';
  resource: ResourceMetadata;
  previousState?: any;
  timestamp: number;
  subscriptionId: string;
}

/**
 * Manages client subscriptions to resource events across the cluster
 * Handles subscription lifecycle, event filtering, and cross-node coordination
 */
export class ResourceSubscriptionManager extends EventEmitter {
  private subscriptions = new Map<string, ResourceSubscription>(); // subscriptionId -> subscription
  private clientSubscriptions = new Map<string, Set<string>>(); // clientId -> subscriptionIds
  private resourceSubscriptions = new Map<string, Set<string>>(); // resourceId -> subscriptionIds
  private nodeSubscriptions = new Map<string, Set<string>>(); // nodeId -> subscriptionIds
  
  private cleanupInterval?: any;
  private maxInactiveTime: number;
  private attachmentService?: ResourceAttachmentService;
  private deliveryGuard?: DeliveryGuard;
  
  constructor(
    private resourceRegistry: ResourceRegistry,
    private clusterManager: IClusterNode,
    private config: {
      maxInactiveTime?: number;
      cleanupInterval?: number;
      attachmentService?: ResourceAttachmentService;
      deliveryGuard?: DeliveryGuard;
    } = {}
  ) {
    super();
    this.maxInactiveTime = config.maxInactiveTime || 300000; // 5 minutes
    this.attachmentService = config.attachmentService;
    this.deliveryGuard = config.deliveryGuard;
    
    this.setupEventHandlers();
    this.startCleanupTask(config.cleanupInterval || 60000); // 1 minute
  }

  /**
   * Create a new resource subscription
   */
  async subscribe(
    clientId: string,
    filter: SubscriptionFilter,
    subscriptionId?: string
  ): Promise<string> {
    const subId = subscriptionId || `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const subscription: ResourceSubscription = {
      subscriptionId: subId,
      clientId,
      nodeId: this.clusterManager.localNodeId,
      filter,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      isActive: true
    };
    
    // Store subscription
    this.subscriptions.set(subId, subscription);
    
    // Update client index
    if (!this.clientSubscriptions.has(clientId)) {
      this.clientSubscriptions.set(clientId, new Set());
    }
    this.clientSubscriptions.get(clientId)!.add(subId);
    
    // Update resource indexes for matching resources
    this.updateResourceIndexes(subscription);
    
    // Propagate subscription to other cluster members if needed
    await this.propagateSubscriptionToCluster(subscription, 'create');
    
    console.log(`📋 Created subscription ${subId} for client ${clientId} with filter:`, filter);
    this.emit('subscription:created', subscription);
    
    return subId;
  }

  /**
   * Attach a connection to a resource subscription for direct delivery
   */
  async attachConnection(connId: string, subscription: ResourceSubscription): Promise<void> {
    if (!this.attachmentService) {
      console.warn('No attachment service configured - connection attachment skipped');
      return;
    }

    try {
      // Convert subscription filter to attachment filter
      const attachmentFilter = {
        resourceType: subscription.filter.resourceTypes?.[0],
        eventTypes: ['resource:created', 'resource:updated', 'resource:destroyed', 'resource:state-changed'],
        tags: subscription.filter.tags ? { tags: subscription.filter.tags.join(',') } : undefined
      };

      await this.attachmentService.attach(connId, subscription.subscriptionId, attachmentFilter);
      console.log(`🔗 Attached connection ${connId} to subscription ${subscription.subscriptionId}`);
    } catch (error) {
      console.error(`Failed to attach connection ${connId} to subscription:`, error);
    }
  }

  /**
   * Cancel a subscription
   */
  async unsubscribe(subscriptionId: string): Promise<boolean> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return false;
    }
    
    // Mark as inactive
    subscription.isActive = false;
    
    // Remove from indexes
    this.removeFromIndexes(subscription);
    
    // Remove from storage
    this.subscriptions.delete(subscriptionId);
    
    // Update client index
    const clientSubs = this.clientSubscriptions.get(subscription.clientId);
    if (clientSubs) {
      clientSubs.delete(subscriptionId);
      if (clientSubs.size === 0) {
        this.clientSubscriptions.delete(subscription.clientId);
      }
    }
    
    // Propagate to cluster
    await this.propagateSubscriptionToCluster(subscription, 'delete');
    
    console.log(`🗑️ Cancelled subscription ${subscriptionId} for client ${subscription.clientId}`);
    this.emit('subscription:cancelled', subscription);
    
    return true;
  }

  /**
   * Update subscription activity timestamp
   */
  updateSubscriptionActivity(subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription || !subscription.isActive) {
      return false;
    }
    
    subscription.lastActivity = Date.now();
    return true;
  }

  /**
   * Get all subscriptions for a client
   */
  getClientSubscriptions(clientId: string): ResourceSubscription[] {
    const subscriptionIds = this.clientSubscriptions.get(clientId);
    if (!subscriptionIds) {
      return [];
    }
    
    return Array.from(subscriptionIds)
      .map(id => this.subscriptions.get(id))
      .filter((sub): sub is ResourceSubscription => sub !== undefined && sub.isActive);
  }

  /**
   * Get subscription by ID
   */
  getSubscription(subscriptionId: string): ResourceSubscription | undefined {
    return this.subscriptions.get(subscriptionId);
  }

  /**
   * Get all active subscriptions
   */
  getAllSubscriptions(): ResourceSubscription[] {
    return Array.from(this.subscriptions.values()).filter(sub => sub.isActive);
  }

  /**
   * Get subscription statistics
   */
  getSubscriptionStats(): {
    totalSubscriptions: number;
    activeSubscriptions: number;
    uniqueClients: number;
    subscriptionsByNode: Record<string, number>;
  } {
    const allSubs = Array.from(this.subscriptions.values());
    const activeSubs = allSubs.filter(sub => sub.isActive);
    const uniqueClients = new Set(activeSubs.map(sub => sub.clientId)).size;
    
    const subscriptionsByNode: Record<string, number> = {};
    for (const sub of activeSubs) {
      subscriptionsByNode[sub.nodeId] = (subscriptionsByNode[sub.nodeId] || 0) + 1;
    }
    
    return {
      totalSubscriptions: allSubs.length,
      activeSubscriptions: activeSubs.length,
      uniqueClients,
      subscriptionsByNode
    };
  }

  private setupEventHandlers(): void {
    // Listen for resource events and notify subscribers
    this.resourceRegistry.on('resource:created', (resource: ResourceMetadata) => {
      this.notifySubscribers('resource:created', resource);
    });

    this.resourceRegistry.on('resource:updated', (resource: ResourceMetadata, previous?: ResourceMetadata) => {
      this.notifySubscribers('resource:updated', resource, previous);
      
      // Also check for state changes
      if (previous && previous.state !== resource.state) {
        this.notifySubscribers('resource:state-changed', resource, previous);
      }
    });

    this.resourceRegistry.on('resource:destroyed', (resource: ResourceMetadata) => {
      this.notifySubscribers('resource:destroyed', resource);
    });

    // Handle cross-cluster subscription events
    this.clusterManager.on('custom-message', async ({ message, senderId }: { message: any, senderId: string }) => {
      if (message.type === 'subscription:event') {
        await this.handleClusterSubscriptionEvent(message, senderId);
      } else if (message.type === 'subscription:sync') {
        await this.handleSubscriptionSync(message, senderId);
      }
    });
  }

  private async notifySubscribers(
    eventType: SubscriptionEvent['eventType'],
    resource: ResourceMetadata,
    previousState?: any
  ): Promise<void> {
    const matchingSubscriptions = this.findMatchingSubscriptions(resource);
    
    for (const subscription of matchingSubscriptions) {
      const event: SubscriptionEvent = {
        eventType,
        resource,
        previousState,
        timestamp: Date.now(),
        subscriptionId: subscription.subscriptionId
      };
      
      // Update activity
      subscription.lastActivity = Date.now();
      
      // Use ResourceAttachmentService for actual delivery if available
      if (this.attachmentService) {
        try {
          // Create a simple ResourceOperation for the event
          const operation = {
            opId: `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            resourceId: resource.resourceId,
            type: 'UPDATE' as const,
            version: 1,
            timestamp: Date.now(),
            originNodeId: this.clusterManager.localNodeId,
            payload: event,
            vectorClock: {
              nodeId: this.clusterManager.localNodeId,
              vector: new Map([[this.clusterManager.localNodeId, 1]]),
              increment: function() { return this; },
              compare: function() { return 0; },
              merge: function() { return this; }
            },
            correlationId: `corr-${Date.now()}`,
            leaseTerm: 1 // Default lease term
          };

          await this.attachmentService.deliverLocal(
            subscription.subscriptionId,
            operation,
            `corr-${operation.opId}`
          );
        } catch (error) {
          console.error(`Failed to deliver via attachment service:`, error);
          // Fallback to event emission
          this.emit('subscription:event', event);
          this.emit(`subscription:${subscription.subscriptionId}`, event);
        }
      } else {
        // Fallback to local event emission
        this.emit('subscription:event', event);
        this.emit(`subscription:${subscription.subscriptionId}`, event);
      }
      
      console.log(`📨 Notified subscription ${subscription.subscriptionId} of ${eventType} for resource ${resource.resourceId}`);
    }
  }

  private findMatchingSubscriptions(resource: ResourceMetadata): ResourceSubscription[] {
    const matchingSubscriptions: ResourceSubscription[] = [];
    
    for (const subscription of this.subscriptions.values()) {
      if (!subscription.isActive) continue;
      
      if (this.subscriptionMatches(subscription.filter, resource)) {
        matchingSubscriptions.push(subscription);
      }
    }
    
    return matchingSubscriptions;
  }

  private subscriptionMatches(filter: SubscriptionFilter, resource: ResourceMetadata): boolean {
    // Resource ID filter
    if (filter.resourceIds && !filter.resourceIds.includes(resource.resourceId)) {
      return false;
    }
    
    // Resource type filter
    if (filter.resourceTypes && !filter.resourceTypes.includes(resource.resourceType)) {
      return false;
    }
    
    // State filter
    if (filter.states && !filter.states.includes(resource.state)) {
      return false;
    }
    
    // Health filter
    if (filter.healthStatus && !filter.healthStatus.includes(resource.health)) {
      return false;
    }
    
    // Node filter
    if (filter.nodeIds && !filter.nodeIds.includes(resource.nodeId!)) {
      return false;
    }
    
    // Tags filter (check if resource has all required tags)
    if (filter.tags) {
      const resourceTags = Object.keys(resource.applicationData?.tags || {});
      if (!filter.tags.every(tag => resourceTags.includes(tag))) {
        return false;
      }
    }
    
    // Metadata filter (check if resource metadata contains required fields)
    if (filter.metadata) {
      for (const [key, value] of Object.entries(filter.metadata)) {
        if (resource.applicationData?.[key] !== value) {
          return false;
        }
      }
    }
    
    return true;
  }

  private updateResourceIndexes(subscription: ResourceSubscription): void {
    // If subscription has specific resource IDs, index them
    if (subscription.filter.resourceIds) {
      for (const resourceId of subscription.filter.resourceIds) {
        if (!this.resourceSubscriptions.has(resourceId)) {
          this.resourceSubscriptions.set(resourceId, new Set());
        }
        this.resourceSubscriptions.get(resourceId)!.add(subscription.subscriptionId);
      }
    }
    
    // Index by node if specified
    if (subscription.filter.nodeIds) {
      for (const nodeId of subscription.filter.nodeIds) {
        if (!this.nodeSubscriptions.has(nodeId)) {
          this.nodeSubscriptions.set(nodeId, new Set());
        }
        this.nodeSubscriptions.get(nodeId)!.add(subscription.subscriptionId);
      }
    }
  }

  private removeFromIndexes(subscription: ResourceSubscription): void {
    // Remove from resource indexes
    if (subscription.filter.resourceIds) {
      for (const resourceId of subscription.filter.resourceIds) {
        const subs = this.resourceSubscriptions.get(resourceId);
        if (subs) {
          subs.delete(subscription.subscriptionId);
          if (subs.size === 0) {
            this.resourceSubscriptions.delete(resourceId);
          }
        }
      }
    }
    
    // Remove from node indexes
    if (subscription.filter.nodeIds) {
      for (const nodeId of subscription.filter.nodeIds) {
        const subs = this.nodeSubscriptions.get(nodeId);
        if (subs) {
          subs.delete(subscription.subscriptionId);
          if (subs.size === 0) {
            this.nodeSubscriptions.delete(nodeId);
          }
        }
      }
    }
  }

  private async propagateSubscriptionToCluster(
    subscription: ResourceSubscription,
    operation: 'create' | 'delete'
  ): Promise<void> {
    const members = this.clusterManager.getAliveMembers()
      .filter(m => m.id !== this.clusterManager.localNodeId);
    
    if (members.length === 0) return;
    
    const message = {
      type: 'subscription:sync',
      operation,
      subscription,
      sourceNodeId: this.clusterManager.localNodeId,
      timestamp: Date.now()
    };
    
    try {
      await this.clusterManager.sendCustomMessage(
        'subscription:sync',
        message,
        members.map(m => m.id)
      );
    } catch (error) {
      console.error('Failed to propagate subscription to cluster:', error);
    }
  }

  private async handleClusterSubscriptionEvent(message: any, senderId: string): Promise<void> {
    // Handle subscription events from other nodes
    const event = message as SubscriptionEvent;
    
    // Find local subscriptions that match this event
    const matchingSubscriptions = this.findMatchingSubscriptions(event.resource);
    
    for (const subscription of matchingSubscriptions) {
      this.emit(`subscription:${subscription.subscriptionId}`, event);
    }
  }

  private async handleSubscriptionSync(message: any, senderId: string): Promise<void> {
    // Handle subscription sync from other nodes
    const { operation, subscription } = message;
    
    if (operation === 'create') {
      // Store remote subscription for cross-cluster awareness
      this.subscriptions.set(subscription.subscriptionId, subscription);
    } else if (operation === 'delete') {
      // Remove remote subscription
      this.subscriptions.delete(subscription.subscriptionId);
    }
  }

  private startCleanupTask(intervalMs: number): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveSubscriptions();
    }, intervalMs);
  }

  private cleanupInactiveSubscriptions(): void {
    const now = Date.now();
    const expiredSubscriptions: string[] = [];
    
    for (const [subscriptionId, subscription] of this.subscriptions) {
      if (subscription.isActive && (now - subscription.lastActivity) > this.maxInactiveTime) {
        expiredSubscriptions.push(subscriptionId);
      }
    }
    
    for (const subscriptionId of expiredSubscriptions) {
      console.log(`🧹 Cleaning up inactive subscription: ${subscriptionId}`);
      this.unsubscribe(subscriptionId);
    }
    
    if (expiredSubscriptions.length > 0) {
      console.log(`🧹 Cleaned up ${expiredSubscriptions.length} inactive subscriptions`);
    }
  }

  /**
   * Cleanup resources when shutting down
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.subscriptions.clear();
    this.clientSubscriptions.clear();
    this.resourceSubscriptions.clear();
    this.nodeSubscriptions.clear();
    
    this.removeAllListeners();
  }
}
