import { EventEmitter } from 'events';
import { ResourceMetadata, ResourceState, ResourceHealth } from '../types';
import { ResourceRegistry } from '../core/ResourceRegistry';
import { ResourceSubscriptionManager } from '../management/ResourceSubscriptionManager';
import { ClusterManager } from '../../cluster/ClusterManager';

export enum ResourceLifecycleEventType {
  // Basic lifecycle
  CREATED = 'resource:created',
  UPDATED = 'resource:updated',
  DELETED = 'resource:deleted',
  
  // State transitions
  STATE_CHANGED = 'resource:state-changed',
  INITIALIZING = 'resource:initializing',
  ACTIVATING = 'resource:activating',
  SCALING = 'resource:scaling',
  MIGRATING = 'resource:migrating',
  TERMINATING = 'resource:terminating',
  ERROR_STATE = 'resource:error',
  
  // Health events
  HEALTH_CHANGED = 'resource:health-changed',
  HEALTH_DEGRADED = 'resource:health-degraded',
  HEALTH_RECOVERED = 'resource:health-recovered',
  HEALTH_CRITICAL = 'resource:health-critical',
  
  // Performance events
  PERFORMANCE_DEGRADED = 'resource:performance-degraded',
  CAPACITY_THRESHOLD_REACHED = 'resource:capacity-threshold',
  HIGH_LATENCY_DETECTED = 'resource:high-latency',
  ERROR_RATE_ELEVATED = 'resource:error-rate-elevated',
  
  // Cluster events
  OWNERSHIP_TRANSFERRED = 'resource:ownership-transferred',
  REPLICA_ADDED = 'resource:replica-added',
  REPLICA_REMOVED = 'resource:replica-removed',
  CROSS_NODE_ACCESS = 'resource:cross-node-access',
  
  // Application events
  APPLICATION_EVENT = 'resource:application-event'
}

export interface ResourceLifecycleEvent {
  eventId: string;
  eventType: ResourceLifecycleEventType;
  resourceId: string;
  resourceType: string;
  nodeId: string;
  timestamp: number;
  data: {
    resource?: ResourceMetadata;
    previousState?: any;
    currentState?: any;
    metadata?: Record<string, any>;
    reason?: string;
    triggeredBy?: string;
  };
  severity: 'low' | 'medium' | 'high' | 'critical';
  tags?: string[];
}

export interface EventFilter {
  resourceIds?: string[];
  resourceTypes?: string[];
  eventTypes?: ResourceLifecycleEventType[];
  severity?: ResourceLifecycleEvent['severity'][];
  nodeIds?: string[];
  timeRange?: {
    start: number;
    end: number;
  };
  tags?: string[];
}

/**
 * Comprehensive resource lifecycle event system
 * Tracks all resource state changes, health events, and performance issues
 */
export class ResourceLifecycleEventSystem extends EventEmitter {
  private eventHistory = new Map<string, ResourceLifecycleEvent>(); // eventId -> event
  private resourceEvents = new Map<string, ResourceLifecycleEvent[]>(); // resourceId -> events
  private eventSubscriptions = new Map<string, EventFilter>(); // subscriptionId -> filter
  private maxHistorySize: number;
  
  constructor(
    private resourceRegistry: ResourceRegistry,
    private subscriptionManager: ResourceSubscriptionManager,
    private clusterManager: ClusterManager,
    config: { maxHistorySize?: number } = {}
  ) {
    super();
    this.maxHistorySize = config.maxHistorySize || 10000;
    this.setupEventHandlers();
  }

  /**
   * Emit a resource lifecycle event
   */
  emitResourceEvent(
    eventType: ResourceLifecycleEventType,
    resourceId: string,
    resourceType: string,
    data: ResourceLifecycleEvent['data'],
    severity: ResourceLifecycleEvent['severity'] = 'medium',
    tags?: string[]
  ): void {
    const event: ResourceLifecycleEvent = {
      eventId: `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      eventType,
      resourceId,
      resourceType,
      nodeId: this.clusterManager.localNodeId,
      timestamp: Date.now(),
      data,
      severity,
      tags
    };

    // Store in history
    this.storeEvent(event);
    
    // Emit to local listeners
    this.emit('resource-lifecycle-event', event);
    this.emit(eventType, event);
    
    // Notify subscribed clients
    this.notifyEventSubscribers(event);
    
    // Propagate to cluster if significant
    if (severity === 'high' || severity === 'critical') {
      this.propagateEventToCluster(event);
    }

    console.log(`📋 Resource event: ${eventType} for ${resourceId} (${severity})`);
  }

  /**
   * Subscribe to specific events with filters
   */
  subscribeToEvents(
    subscriptionId: string,
    filter: EventFilter,
    callback: (event: ResourceLifecycleEvent) => void
  ): void {
    this.eventSubscriptions.set(subscriptionId, filter);
    this.on(`subscription:${subscriptionId}`, callback);
  }

  /**
   * Unsubscribe from events
   */
  unsubscribeFromEvents(subscriptionId: string): void {
    this.eventSubscriptions.delete(subscriptionId);
    this.removeAllListeners(`subscription:${subscriptionId}`);
  }

  /**
   * Query event history with filters
   */
  queryEvents(filter: EventFilter): ResourceLifecycleEvent[] {
    let events = Array.from(this.eventHistory.values());
    
    // Apply filters
    if (filter.resourceIds) {
      events = events.filter(e => filter.resourceIds!.includes(e.resourceId));
    }
    
    if (filter.resourceTypes) {
      events = events.filter(e => filter.resourceTypes!.includes(e.resourceType));
    }
    
    if (filter.eventTypes) {
      events = events.filter(e => filter.eventTypes!.includes(e.eventType));
    }
    
    if (filter.severity) {
      events = events.filter(e => filter.severity!.includes(e.severity));
    }
    
    if (filter.nodeIds) {
      events = events.filter(e => filter.nodeIds!.includes(e.nodeId));
    }
    
    if (filter.timeRange) {
      events = events.filter(e => 
        e.timestamp >= filter.timeRange!.start && e.timestamp <= filter.timeRange!.end
      );
    }
    
    if (filter.tags) {
      events = events.filter(e => 
        e.tags && filter.tags!.some(tag => e.tags!.includes(tag))
      );
    }
    
    return events.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get events for specific resource
   */
  getResourceEventHistory(resourceId: string): ResourceLifecycleEvent[] {
    return this.resourceEvents.get(resourceId) || [];
  }

  /**
   * Get critical events in time range
   */
  getCriticalEvents(timeRangeMs = 3600000): ResourceLifecycleEvent[] { // Last hour by default
    const now = Date.now();
    return this.queryEvents({
      severity: ['critical'],
      timeRange: {
        start: now - timeRangeMs,
        end: now
      }
    });
  }

  /**
   * Get health change events for monitoring
   */
  getHealthEvents(resourceId?: string): ResourceLifecycleEvent[] {
    const filter: EventFilter = {
      eventTypes: [
        ResourceLifecycleEventType.HEALTH_CHANGED,
        ResourceLifecycleEventType.HEALTH_DEGRADED,
        ResourceLifecycleEventType.HEALTH_RECOVERED,
        ResourceLifecycleEventType.HEALTH_CRITICAL
      ]
    };
    
    if (resourceId) {
      filter.resourceIds = [resourceId];
    }
    
    return this.queryEvents(filter);
  }

  /**
   * Get performance events for analysis
   */
  getPerformanceEvents(resourceId?: string): ResourceLifecycleEvent[] {
    const filter: EventFilter = {
      eventTypes: [
        ResourceLifecycleEventType.PERFORMANCE_DEGRADED,
        ResourceLifecycleEventType.HIGH_LATENCY_DETECTED,
        ResourceLifecycleEventType.ERROR_RATE_ELEVATED,
        ResourceLifecycleEventType.CAPACITY_THRESHOLD_REACHED
      ]
    };
    
    if (resourceId) {
      filter.resourceIds = [resourceId];
    }
    
    return this.queryEvents(filter);
  }

  /**
   * Get event statistics
   */
  getEventStats(): {
    totalEvents: number;
    eventsByType: Record<string, number>;
    eventsBySeverity: Record<string, number>;
    recentCriticalEvents: number;
  } {
    const events = Array.from(this.eventHistory.values());
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    
    const eventsByType: Record<string, number> = {};
    const eventsBySeverity: Record<string, number> = {};
    let recentCriticalEvents = 0;
    
    for (const event of events) {
      // Count by type
      eventsByType[event.eventType] = (eventsByType[event.eventType] || 0) + 1;
      
      // Count by severity
      eventsBySeverity[event.severity] = (eventsBySeverity[event.severity] || 0) + 1;
      
      // Count recent critical events
      if (event.severity === 'critical' && event.timestamp > oneHourAgo) {
        recentCriticalEvents++;
      }
    }
    
    return {
      totalEvents: events.length,
      eventsByType,
      eventsBySeverity,
      recentCriticalEvents
    };
  }

  private setupEventHandlers(): void {
    // Listen to ResourceRegistry events and enhance them
    this.resourceRegistry.on('resource:created', (resource: ResourceMetadata) => {
      this.emitResourceEvent(
        ResourceLifecycleEventType.CREATED,
        resource.resourceId,
        resource.resourceType,
        { resource, reason: 'Resource created' },
        'medium',
        ['creation', 'lifecycle']
      );
    });

    this.resourceRegistry.on('resource:updated', (resource: ResourceMetadata, previous?: ResourceMetadata) => {
      // Check for state changes
      if (previous && previous.state !== resource.state) {
        this.emitResourceEvent(
          ResourceLifecycleEventType.STATE_CHANGED,
          resource.resourceId,
          resource.resourceType,
          { 
            resource, 
            previousState: previous.state, 
            currentState: resource.state,
            reason: 'State transition'
          },
          'medium',
          ['state-change', 'lifecycle']
        );
        
        // Emit specific state events
        this.emitStateSpecificEvents(resource, previous.state);
      }

      // Check for health changes
      if (previous && previous.health !== resource.health) {
        const severity = resource.health === ResourceHealth.UNHEALTHY ? 'high' : 'medium';
        this.emitResourceEvent(
          ResourceLifecycleEventType.HEALTH_CHANGED,
          resource.resourceId,
          resource.resourceType,
          {
            resource,
            previousState: previous.health,
            currentState: resource.health,
            reason: 'Health status changed'
          },
          severity,
          ['health-change', 'monitoring']
        );
        
        // Emit specific health events
        this.emitHealthSpecificEvents(resource, previous.health);
      }

      // General update event
      this.emitResourceEvent(
        ResourceLifecycleEventType.UPDATED,
        resource.resourceId,
        resource.resourceType,
        { resource, previousState: previous, reason: 'Resource updated' },
        'low',
        ['update', 'lifecycle']
      );
      
      // Check for performance issues
      this.checkPerformanceDegradation(resource);
    });

    this.resourceRegistry.on('resource:destroyed', (resource: ResourceMetadata) => {
      this.emitResourceEvent(
        ResourceLifecycleEventType.DELETED,
        resource.resourceId,
        resource.resourceType,
        { resource, reason: 'Resource destroyed' },
        'medium',
        ['deletion', 'lifecycle']
      );
    });

    // Handle cluster events
    this.clusterManager.on('custom-message', async ({ message, senderId }: { message: any, senderId: string }) => {
      if (message.type === 'resource:lifecycle-event') {
        await this.handleClusterLifecycleEvent(message, senderId);
      }
    });
  }

  private emitStateSpecificEvents(resource: ResourceMetadata, previousState: ResourceState): void {
    const currentState = resource.state;
    
    switch (currentState) {
      case ResourceState.INITIALIZING:
        this.emitResourceEvent(
          ResourceLifecycleEventType.INITIALIZING,
          resource.resourceId,
          resource.resourceType,
          { resource, previousState, reason: 'Resource initializing' },
          'low',
          ['initialization', 'state']
        );
        break;
        
      case ResourceState.ACTIVE:
        this.emitResourceEvent(
          ResourceLifecycleEventType.ACTIVATING,
          resource.resourceId,
          resource.resourceType,
          { resource, previousState, reason: 'Resource activated' },
          'medium',
          ['activation', 'state']
        );
        break;
        
      case ResourceState.SCALING:
        this.emitResourceEvent(
          ResourceLifecycleEventType.SCALING,
          resource.resourceId,
          resource.resourceType,
          { resource, previousState, reason: 'Resource scaling' },
          'medium',
          ['scaling', 'state']
        );
        break;
        
      case ResourceState.MIGRATING:
        this.emitResourceEvent(
          ResourceLifecycleEventType.MIGRATING,
          resource.resourceId,
          resource.resourceType,
          { resource, previousState, reason: 'Resource migrating' },
          'high',
          ['migration', 'state']
        );
        break;
        
      case ResourceState.TERMINATING:
        this.emitResourceEvent(
          ResourceLifecycleEventType.TERMINATING,
          resource.resourceId,
          resource.resourceType,
          { resource, previousState, reason: 'Resource terminating' },
          'high',
          ['termination', 'state']
        );
        break;
        
      case ResourceState.ERROR:
        this.emitResourceEvent(
          ResourceLifecycleEventType.ERROR_STATE,
          resource.resourceId,
          resource.resourceType,
          { resource, previousState, reason: 'Resource entered error state' },
          'critical',
          ['error', 'state']
        );
        break;
    }
  }

  private emitHealthSpecificEvents(resource: ResourceMetadata, previousHealth: ResourceHealth): void {
    const currentHealth = resource.health;
    
    if (currentHealth === ResourceHealth.DEGRADED && previousHealth === ResourceHealth.HEALTHY) {
      this.emitResourceEvent(
        ResourceLifecycleEventType.HEALTH_DEGRADED,
        resource.resourceId,
        resource.resourceType,
        { resource, previousState: previousHealth, reason: 'Health degraded' },
        'high',
        ['health', 'degradation']
      );
    } else if (currentHealth === ResourceHealth.HEALTHY && previousHealth !== ResourceHealth.HEALTHY) {
      this.emitResourceEvent(
        ResourceLifecycleEventType.HEALTH_RECOVERED,
        resource.resourceId,
        resource.resourceType,
        { resource, previousState: previousHealth, reason: 'Health recovered' },
        'medium',
        ['health', 'recovery']
      );
    } else if (currentHealth === ResourceHealth.UNHEALTHY) {
      this.emitResourceEvent(
        ResourceLifecycleEventType.HEALTH_CRITICAL,
        resource.resourceId,
        resource.resourceType,
        { resource, previousState: previousHealth, reason: 'Health critical' },
        'critical',
        ['health', 'critical']
      );
    }
  }

  private checkPerformanceDegradation(resource: ResourceMetadata): void {
    const performance = resource.performance;
    
    // Check latency threshold
    if (performance?.latency && performance.latency > 1000) { // 1 second
      this.emitResourceEvent(
        ResourceLifecycleEventType.HIGH_LATENCY_DETECTED,
        resource.resourceId,
        resource.resourceType,
        { 
          resource, 
          metadata: { latency: performance.latency },
          reason: 'High latency detected'
        },
        'high',
        ['performance', 'latency', 'alert']
      );
    }
    
    // Check error rate
    if (performance?.errorRate && performance.errorRate > 0.1) { // 10%
      this.emitResourceEvent(
        ResourceLifecycleEventType.ERROR_RATE_ELEVATED,
        resource.resourceId,
        resource.resourceType,
        {
          resource,
          metadata: { errorRate: performance.errorRate },
          reason: 'Elevated error rate detected'
        },
        'high',
        ['performance', 'errors', 'alert']
      );
    }

    // Check capacity utilization
    const capacity = resource.capacity;
    if (capacity && capacity.current && capacity.maximum) {
      const utilization = capacity.current / capacity.maximum;
      if (utilization > 0.9) { // 90%
        this.emitResourceEvent(
          ResourceLifecycleEventType.CAPACITY_THRESHOLD_REACHED,
          resource.resourceId,
          resource.resourceType,
          {
            resource,
            metadata: { utilization, current: capacity.current, maximum: capacity.maximum },
            reason: 'Capacity threshold reached'
          },
          'high',
          ['capacity', 'scaling', 'alert']
        );
      }
    }

    // Overall performance degradation check
    if (performance && (
      (performance.latency > 500) || 
      (performance.errorRate > 0.05) || 
      (performance.throughput < 10)
    )) {
      this.emitResourceEvent(
        ResourceLifecycleEventType.PERFORMANCE_DEGRADED,
        resource.resourceId,
        resource.resourceType,
        {
          resource,
          metadata: {
            latency: performance.latency,
            errorRate: performance.errorRate,
            throughput: performance.throughput
          },
          reason: 'Performance degradation detected'
        },
        'medium',
        ['performance', 'degradation']
      );
    }
  }

  private storeEvent(event: ResourceLifecycleEvent): void {
    // Store in global history
    this.eventHistory.set(event.eventId, event);
    
    // Store in resource-specific history
    if (!this.resourceEvents.has(event.resourceId)) {
      this.resourceEvents.set(event.resourceId, []);
    }
    this.resourceEvents.get(event.resourceId)!.push(event);
    
    // Maintain history size limits
    if (this.eventHistory.size > this.maxHistorySize) {
      const oldestEventId = Array.from(this.eventHistory.keys())[0];
      const oldestEvent = this.eventHistory.get(oldestEventId);
      
      this.eventHistory.delete(oldestEventId);
      
      // Also remove from resource history
      if (oldestEvent) {
        const resourceHistory = this.resourceEvents.get(oldestEvent.resourceId);
        if (resourceHistory) {
          const index = resourceHistory.findIndex(e => e.eventId === oldestEventId);
          if (index !== -1) {
            resourceHistory.splice(index, 1);
          }
        }
      }
    }
  }

  private notifyEventSubscribers(event: ResourceLifecycleEvent): void {
    for (const [subscriptionId, filter] of this.eventSubscriptions) {
      if (this.eventMatchesFilter(event, filter)) {
        this.emit(`subscription:${subscriptionId}`, event);
      }
    }
  }

  private eventMatchesFilter(event: ResourceLifecycleEvent, filter: EventFilter): boolean {
    if (filter.resourceIds && !filter.resourceIds.includes(event.resourceId)) return false;
    if (filter.resourceTypes && !filter.resourceTypes.includes(event.resourceType)) return false;
    if (filter.eventTypes && !filter.eventTypes.includes(event.eventType)) return false;
    if (filter.severity && !filter.severity.includes(event.severity)) return false;
    if (filter.nodeIds && !filter.nodeIds.includes(event.nodeId)) return false;
    
    if (filter.timeRange) {
      if (event.timestamp < filter.timeRange.start || event.timestamp > filter.timeRange.end) {
        return false;
      }
    }
    
    if (filter.tags && event.tags) {
      if (!filter.tags.some(tag => event.tags!.includes(tag))) return false;
    }
    
    return true;
  }

  private propagateEventToCluster(event: ResourceLifecycleEvent): void {
    // Send significant events to all cluster members
    const members = this.clusterManager.membership.getAllMembers()
      .filter(m => m.status === 'ALIVE' && m.id !== this.clusterManager.localNodeId);
    
    if (members.length > 0) {
      this.clusterManager.sendCustomMessage(
        'resource:lifecycle-event', 
        event, 
        members.map(m => m.id)
      ).catch(error => {
        console.error('Failed to propagate lifecycle event to cluster:', error);
      });
    }
  }

  private async handleClusterLifecycleEvent(message: any, senderId: string): Promise<void> {
    const event = message as ResourceLifecycleEvent;
    
    // Store remote event in history
    this.storeEvent(event);
    
    // Emit locally for any subscribers
    this.emit('resource-lifecycle-event', event);
    this.emit(event.eventType, event);
    
    // Notify local subscribers
    this.notifyEventSubscribers(event);
  }
}
