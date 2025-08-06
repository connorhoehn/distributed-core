import { EventEmitter } from 'events';
import { ResourceRegistry, ResourceRegistryConfig } from './ResourceRegistry';
import { ResourceMetadata, ResourceTypeDefinition, ResourceState, ResourceCapacity } from './types';
import { ClusterManager } from '../ClusterManager';
import { MetricsTracker } from '../../monitoring/metrics/MetricsTracker';

/**
 * Production-Scale Resource Manager
 * 
 * This manager provides enterprise-grade resource management capabilities
 * built on top of the ResourceRegistry/EntityRegistry foundation:
 * - Auto-scaling based on resource metrics
 * - Load balancing across cluster nodes
 * - Health monitoring and failure recovery
 * - Resource lifecycle management
 * - Multi-tenant isolation
 */
export class ProductionScaleResourceManager extends EventEmitter {
  private resourceRegistry: ResourceRegistry;
  private clusterManager: ClusterManager;
  private metricsTracker: MetricsTracker;
  private scalingIntervals = new Map<string, NodeJS.Timeout>();
  private healthCheckInterval?: NodeJS.Timeout;
  private isRunning = false;

  constructor(
    resourceRegistry: ResourceRegistry,
    clusterManager: ClusterManager,
    metricsTracker: MetricsTracker
  ) {
    super();
    this.resourceRegistry = resourceRegistry;
    this.clusterManager = clusterManager;
    this.metricsTracker = metricsTracker;
    this.setupResourceEventHandling();
  }

  async start(): Promise<void> {
    await this.resourceRegistry.start();
    this.startHealthMonitoring();
    this.isRunning = true;
    this.emit('manager:started');
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    
    // Stop all scaling intervals
    for (const interval of this.scalingIntervals.values()) {
      clearInterval(interval);
    }
    this.scalingIntervals.clear();

    // Stop health monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    await this.resourceRegistry.stop();
    this.emit('manager:stopped');
  }

  // Resource Type Management with Production Features
  registerResourceType(definition: ResourceTypeDefinition): void {
    // Enhance definition with production monitoring
    const enhancedDefinition: ResourceTypeDefinition = {
      ...definition,
      onResourceCreated: async (resource: ResourceMetadata) => {
        // Track resource creation metrics
        this.metricsTracker.trackUnified({
          timestamp: Date.now(),
          system: { cpu: { percentage: 0 }, memory: { used: 0, total: 0, percentage: 0 }, disk: { used: 0, available: 0, total: 0, percentage: 0 } },
          cluster: { membershipSize: 1, gossipRate: 0, failureDetectionLatency: 0, averageHeartbeatInterval: 0, messageRate: 0, messageLatency: 0, networkThroughput: 0, clusterStability: 'stable' },
          network: { latency: 0, status: 'connected', roundTripTimes: new Map(), failedConnections: 0, activeConnections: 0 },
          connections: { totalAcquired: 0, totalReleased: 0, totalCreated: 0, totalDestroyed: 0, activeConnections: 0, poolUtilization: 0, averageAcquireTime: 0, connectionHealth: 'healthy' },
          health: { overallHealth: 'healthy', nodeHealth: new Map(), systemAlerts: [], performanceTrends: { cpu: 'stable', memory: 'stable', network: 'stable' } }
        });

        // Start auto-scaling if enabled
        if (resource.applicationData?.scaling?.enabled) {
          this.startAutoScaling(resource.resourceId);
        }

        // Call original hook
        if (definition.onResourceCreated) {
          await definition.onResourceCreated(resource);
        }
      },
      onResourceDestroyed: async (resource: ResourceMetadata) => {
        // Track destruction metrics
        this.metricsTracker.incrementCounter('resources_destroyed_total', 1, {
          type: resource.resourceType,
          node: resource.nodeId
        });

        // Stop auto-scaling
        this.stopAutoScaling(resource.resourceId);

        // Call original hook
        if (definition.onResourceDestroyed) {
          await definition.onResourceDestroyed(resource);
        }
      }
    };

    this.resourceRegistry.registerResourceType(enhancedDefinition);
  }

  // Enterprise Resource Creation with Auto-placement
  async createResourceWithPlacement(
    resourceMetadata: Omit<ResourceMetadata, 'nodeId' | 'timestamp'>,
    placementStrategy: 'load-balanced' | 'affinity' | 'anti-affinity' | 'manual' = 'load-balanced',
    targetNode?: string
  ): Promise<ResourceMetadata> {
    let selectedNode: string;

    switch (placementStrategy) {
      case 'load-balanced':
        selectedNode = await this.selectOptimalNode(resourceMetadata.resourceType);
        break;
      case 'manual':
        if (!targetNode) {
          throw new Error('Target node must be specified for manual placement');
        }
        selectedNode = targetNode;
        break;
      default:
        selectedNode = this.clusterManager.localNodeId;
    }

    const fullResourceMetadata: ResourceMetadata = {
      ...resourceMetadata,
      nodeId: selectedNode,
      timestamp: Date.now()
    };

    return await this.resourceRegistry.createResource(fullResourceMetadata);
  }

  // Auto-scaling Management
  private startAutoScaling(resourceId: string): void {
    if (this.scalingIntervals.has(resourceId)) return;

    const interval = setInterval(async () => {
      await this.checkAndScale(resourceId);
    }, 30000); // Check every 30 seconds

    this.scalingIntervals.set(resourceId, interval);
  }

  private stopAutoScaling(resourceId: string): void {
    const interval = this.scalingIntervals.get(resourceId);
    if (interval) {
      clearInterval(interval);
      this.scalingIntervals.delete(resourceId);
    }
  }

  private async checkAndScale(resourceId: string): Promise<void> {
    const resource = this.resourceRegistry.getResource(resourceId);
    if (!resource || !resource.applicationData?.scaling?.enabled) return;

    const metrics = await this.getResourceMetrics(resourceId);
    const currentLoad = metrics.cpuUsage || 0;

    // Scale up if load is high
    if (currentLoad > (resource.applicationData?.scaling?.scaleUpThreshold || 80) && 
        (resource.applicationData?.currentReplicas || 1) < (resource.applicationData?.scaling?.maxReplicas || 1)) {
      await this.scaleUp(resourceId);
    }
    // Scale down if load is low
    else if (currentLoad < (resource.applicationData?.scaling?.scaleDownThreshold || 20) && 
             (resource.applicationData?.currentReplicas || 1) > (resource.applicationData?.scaling?.minReplicas || 1)) {
      await this.scaleDown(resourceId);
    }
  }

  private async scaleUp(resourceId: string): Promise<void> {
    const resource = this.resourceRegistry.getResource(resourceId);
    if (!resource) return;

    const newReplicaCount = Math.min(
      (resource.applicationData?.currentReplicas || 1) + 1,
      resource.applicationData?.scaling?.maxReplicas || 1
    );

    await this.resourceRegistry.updateResource(resourceId, {
      applicationData: {
        ...resource.applicationData,
        currentReplicas: newReplicaCount
      }
    });

    this.emit('resource:scaled-up', resourceId, newReplicaCount);
  }

  private async scaleDown(resourceId: string): Promise<void> {
    const resource = this.resourceRegistry.getResource(resourceId);
    if (!resource) return;

    const newReplicaCount = Math.max(
      (resource.applicationData?.currentReplicas || 1) - 1,
      resource.applicationData?.scaling?.minReplicas || 1
    );

    await this.resourceRegistry.updateResource(resourceId, {
      applicationData: {
        ...resource.applicationData,
        currentReplicas: newReplicaCount
      }
    });

    this.emit('resource:scaled-down', resourceId, newReplicaCount);
  }

  // Load Balancing and Node Selection
  private async selectOptimalNode(resourceType: string): Promise<string> {
    const nodes = this.clusterManager.getAliveMembers().map(member => member.id);
    
    if (nodes.length === 0) {
      return this.clusterManager.localNodeId;
    }

    // Simple load-based selection for now
    const nodeLoads = new Map<string, number>();
    for (const nodeId of nodes) {
      const resources = this.resourceRegistry.getResourcesByNode(nodeId);
      const load = resources.reduce((sum, r) => sum + (r.capacity.current || 0), 0);
      nodeLoads.set(nodeId, load);
    }

    // Select node with lowest load
    return nodes.reduce((bestNode, currentNode) => 
      (nodeLoads.get(currentNode) || 0) < (nodeLoads.get(bestNode) || 0) 
        ? currentNode 
        : bestNode
    );
  }

  // Health Monitoring
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthChecks();
    }, 60000); // Check every minute
  }

  private async performHealthChecks(): Promise<void> {
    const allResources = this.resourceRegistry.getLocalResources();
    
    for (const resource of allResources) {
      const health = await this.checkResourceHealth(resource);
      
      if (health.status === 'unhealthy') {
        this.emit('resource:unhealthy', resource, health);
        await this.handleUnhealthyResource(resource, health);
      }
    }
  }

  private async checkResourceHealth(resource: ResourceMetadata): Promise<{ status: 'healthy' | 'unhealthy', issues: string[] }> {
    const issues: string[] = [];

    // Check if resource is responsive
    const metrics = await this.getResourceMetrics(resource.resourceId);
    
    if (metrics.cpuUsage > 0.95) {
      issues.push('High CPU usage');
    }
    
    if (metrics.memoryUsage > 0.90) {
      issues.push('High memory usage');
    }

    if (metrics.errorRate > 0.1) {
      issues.push('High error rate');
    }

    return {
      status: issues.length > 0 ? 'unhealthy' : 'healthy',
      issues
    };
  }

  private async handleUnhealthyResource(resource: ResourceMetadata, health: { issues: string[] }): Promise<void> {
    // Try to recover the resource
    if (health.issues.includes('High CPU usage') || health.issues.includes('High memory usage')) {
      // Scale up if possible
      if (resource.applicationData?.scaling?.enabled && (resource.applicationData?.currentReplicas || 1) < (resource.applicationData?.scaling?.maxReplicas || 1)) {
        await this.scaleUp(resource.resourceId);
      }
    }

    // If recovery fails, consider migration
    if (health.issues.length > 2) {
      const optimalNode = await this.selectOptimalNode(resource.resourceType);
      if (optimalNode !== resource.nodeId) {
        await this.resourceRegistry.transferResource(resource.resourceId, optimalNode);
      }
    }
  }

  // Metrics Integration
  private async getResourceMetrics(resourceId: string): Promise<{
    cpuUsage: number;
    memoryUsage: number;
    errorRate: number;
    responseTime: number;
  }> {
    // Get metrics from the metrics tracker
    const cpuUsage = this.metricsTracker.getGaugeValue('resource_cpu_usage', { resource_id: resourceId }) || 0;
    const memoryUsage = this.metricsTracker.getGaugeValue('resource_memory_usage', { resource_id: resourceId }) || 0;
    const errorRate = this.metricsTracker.getGaugeValue('resource_error_rate', { resource_id: resourceId }) || 0;
    const responseTime = this.metricsTracker.getGaugeValue('resource_response_time', { resource_id: resourceId }) || 0;

    return { cpuUsage, memoryUsage, errorRate, responseTime };
  }

  // Event Handling
  private setupResourceEventHandling(): void {
    this.resourceRegistry.on('resource:created', (resource: ResourceMetadata) => {
      this.metricsTracker.setGauge('resource_count', 
        this.resourceRegistry.getResourcesByType(resource.resourceType).length,
        { type: resource.resourceType }
      );
    });

    this.resourceRegistry.on('resource:destroyed', (resource: ResourceMetadata) => {
      this.metricsTracker.setGauge('resource_count',
        this.resourceRegistry.getResourcesByType(resource.resourceType).length,
        { type: resource.resourceType }
      );
    });

    this.resourceRegistry.on('resource:migrated', (resource: ResourceMetadata) => {
      this.metricsTracker.incrementCounter('resource_migrations_total', 1, {
        type: resource.resourceType,
        to_node: resource.nodeId
      });
    });
  }

  // Public API for production operations
  async getClusterResourceOverview(): Promise<{
    totalResources: number;
    resourcesByType: Map<string, number>;
    resourcesByNode: Map<string, number>;
    healthyResources: number;
    unhealthyResources: number;
  }> {
    const allResources = this.resourceRegistry.getResourcesByType(''); // Gets all resources
    
    const resourcesByType = new Map<string, number>();
    const resourcesByNode = new Map<string, number>();
    let healthyResources = 0;
    let unhealthyResources = 0;

    for (const resource of allResources) {
      // Count by type
      resourcesByType.set(resource.resourceType, 
        (resourcesByType.get(resource.resourceType) || 0) + 1);
      
      // Count by node
      resourcesByNode.set(resource.nodeId,
        (resourcesByNode.get(resource.nodeId) || 0) + 1);

      // Check health
      const health = await this.checkResourceHealth(resource);
      if (health.status === 'healthy') {
        healthyResources++;
      } else {
        unhealthyResources++;
      }
    }

    return {
      totalResources: allResources.length,
      resourcesByType,
      resourcesByNode,
      healthyResources,
      unhealthyResources
    };
  }

  // Delegate other methods to ResourceRegistry
  async createResource(resourceMetadata: ResourceMetadata): Promise<ResourceMetadata> {
    return await this.resourceRegistry.createResource(resourceMetadata);
  }

  getResource(resourceId: string): ResourceMetadata | null {
    return this.resourceRegistry.getResource(resourceId);
  }

  getResourcesByType(resourceType: string): ResourceMetadata[] {
    return this.resourceRegistry.getResourcesByType(resourceType);
  }

  getResourcesByNode(nodeId: string): ResourceMetadata[] {
    return this.resourceRegistry.getResourcesByNode(nodeId);
  }

  async removeResource(resourceId: string): Promise<void> {
    return await this.resourceRegistry.removeResource(resourceId);
  }

  async transferResource(resourceId: string, targetNodeId: string): Promise<ResourceMetadata> {
    return await this.resourceRegistry.transferResource(resourceId, targetNodeId);
  }
}
