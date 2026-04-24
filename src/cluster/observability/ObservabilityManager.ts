import { EventEmitter } from 'events';
import { ResourceTopologyManager, NodeResourceCapacity, ResourceClusterTopology } from '../topology/ResourceTopologyManager';
import { ClusterManager } from '../ClusterManager';
import { ResourceMetadata } from '../resources/types';
import { MetricsTracker } from '../../monitoring/metrics/MetricsTracker';

/**
 * Resource placement and management recommendations
 */
export interface ResourcePlacementRecommendation {
  resourceId: string;
  currentPlacement: {
    primaryNode: string;
    replicaNodes: string[];
  };
  recommendedPlacement: {
    primaryNode: string;
    replicaNodes: string[];
  };
  reasoning: string[];
  confidence: number; // 0-1
  estimatedMigrationCost: number;
  estimatedPerformanceGain: number;
}

/**
 * Cluster scaling analysis
 */
export interface ClusterScalingAnalysis {
  currentState: {
    totalNodes: number;
    totalCapacity: NodeResourceCapacity['capacity'];
    currentUtilization: number;
    bottlenecks: string[];
  };
  projectedDemand: {
    timeHorizon: 'immediate' | '1hour' | '6hours' | '24hours';
    expectedLoad: number;
    expectedResources: number;
    expectedConnections: number;
  };
  recommendations: {
    scaleUp: boolean;
    scaleDown: boolean;
    addNodes: number;
    removeNodes: string[];
    redistributeResources: ResourcePlacementRecommendation[];
    urgency: 'low' | 'medium' | 'high' | 'critical';
  };
  costAnalysis: {
    currentCost: number;
    projectedCost: number;
    savings: number;
    efficiency: number;
  };
}

/**
 * Real-time cluster dashboard data
 */
export interface ClusterDashboard {
  overview: {
    totalNodes: number;
    healthyNodes: number;
    totalResources: number;
    totalConnections: number;
    messagesPerSecond: number;
    averageLatency: number;
    clusterHealth: 'healthy' | 'warning' | 'critical';
  };
  regions: {
    [region: string]: {
      nodes: number;
      resources: number;
      connections: number;
      health: number;
      latency: number;
    };
  };
  hotspots: {
    highTrafficResources: Array<{
      resourceId: string;
      connections: number;
      messageRate: number;
      node: string;
    }>;
    overloadedNodes: Array<{
      nodeId: string;
      cpuUsage: number;
      memoryUsage: number;
      resourceCount: number;
    }>;
  };
  trends: {
    connectionGrowth: number; // percentage change
    messageVolumeGrowth: number;
    nodeHealthTrend: 'improving' | 'stable' | 'degrading';
  };
  alerts: Array<{
    severity: 'info' | 'warning' | 'error' | 'critical';
    message: string;
    timestamp: number;
    category: 'performance' | 'capacity' | 'health' | 'security';
  }>;
}

/**
 * Advanced topology query interface
 */
export interface TopologyQuery {
  // Filtering
  regions?: string[];
  zones?: string[];
  nodeRoles?: string[];
  resourceTypes?: string[];

  // Metrics filtering
  minHealth?: number;
  maxUtilization?: number;

  // Time-based filtering
  since?: number;
  until?: number;

  // Projection and grouping
  groupBy?: 'region' | 'zone' | 'role' | 'resourceType';
  includeMetrics?: boolean;
  includeHistory?: boolean;
  includeProjections?: boolean;
}

/**
 * ObservabilityManager provides comprehensive cluster observability and management APIs
 *
 * This manager builds on top of ResourceTopologyManager to provide:
 * - Real-time dashboard APIs for monitoring UIs
 * - Advanced querying and filtering of cluster topology
 * - Predictive scaling analysis and recommendations
 * - Resource placement optimization
 * - Geographic distribution optimization
 * - Performance trend analysis and alerting
 */
export class ObservabilityManager extends EventEmitter {
  private topologyManager: ResourceTopologyManager;
  private cluster: ClusterManager;
  private dashboardUpdateInterval?: NodeJS.Timeout;
  private lastDashboard?: ClusterDashboard;

  /**
   * Emit both legacy and canonical event names during the deprecation window.
   * Callers should migrate to the new name; old name support will be removed in
   * a future release.
   *
   * NOTE: `error` is deliberately excluded from dual-emit. Node's EventEmitter
   * throws on unhandled `error` events; renaming to `lifecycle:error` while
   * keeping a silent `error` alias would suppress that safety mechanism.
   */
  private emitRenamed(oldName: string, newName: string, ...args: unknown[]): void {
    this.emit(newName, ...args);
    this.emit(oldName, ...args);
  }

  // Historical data for trend analysis
  private historicalTopologies: ResourceClusterTopology[] = [];
  private maxHistorySize = 100;

  // Configuration
  private dashboardUpdateIntervalMs = 10000; // 10 seconds

  constructor(
    topologyManager: ResourceTopologyManager,
    cluster: ClusterManager,
    config?: {
      dashboardUpdateIntervalMs?: number;
      maxHistorySize?: number;
    }
  ) {
    super();
    this.topologyManager = topologyManager;
    this.cluster = cluster;

    if (config) {
      this.dashboardUpdateIntervalMs = config.dashboardUpdateIntervalMs || this.dashboardUpdateIntervalMs;
      this.maxHistorySize = config.maxHistorySize || this.maxHistorySize;
    }

    // Listen to topology updates
    this.topologyManager.on('topology:updated', () => {
      this.handleTopologyUpdate();
    });
  }

  /**
   * Start the observability system
   */
  async start(): Promise<void> {
    // Start topology manager
    await this.topologyManager.start();

    // Start periodic dashboard updates with bound function
    this.dashboardUpdateInterval = setInterval(
      this.updateDashboard.bind(this),
      this.dashboardUpdateIntervalMs
    );

    // Unref the interval so it doesn't keep the process alive
    this.dashboardUpdateInterval.unref();

    this.emitRenamed('started', 'lifecycle:started');
  }

  /**
   * Stop the observability system
   */
  async stop(): Promise<void> {
    // Stop intervals
    if (this.dashboardUpdateInterval) {
      clearInterval(this.dashboardUpdateInterval);
      this.dashboardUpdateInterval = undefined;
    }

    // Stop topology manager
    await this.topologyManager.stop();

    this.emitRenamed('stopped', 'lifecycle:stopped');
  }

  /**
   * Get real-time cluster dashboard
   */
  async getDashboard(): Promise<ClusterDashboard> {
    if (this.lastDashboard) {
      return this.lastDashboard;
    }

    return await this.buildDashboard();
  }

  /**
   * Query cluster topology with advanced filtering
   */
  async queryTopology(query: TopologyQuery = {}): Promise<{
    topology: ResourceClusterTopology;
    filteredNodes: NodeResourceCapacity[];
    filteredResources: ResourceMetadata[];
    aggregatedMetrics?: any;
  }> {
    const topology = await this.topologyManager.getResourceTopology();

    // Apply filters (implementation would depend on how we store this data)
    // For now, return the full topology
    return {
      topology,
      filteredNodes: [], // Would be filtered based on query
      filteredResources: [], // Would be filtered based on query
      aggregatedMetrics: query.includeMetrics ? this.calculateAggregatedMetrics(topology) : undefined
    };
  }

  /**
   * Get resource placement recommendations for optimization
   */
  async getResourcePlacementRecommendations(
    optimizeFor: 'performance' | 'cost' | 'availability' | 'latency' = 'performance'
  ): Promise<ResourcePlacementRecommendation[]> {
    const topology = await this.topologyManager.getResourceTopology();
    const recommendations: ResourcePlacementRecommendation[] = [];

    // Analyze each resource for potential optimization
    // This is a simplified implementation - real optimization would be more complex

    return recommendations;
  }

  /**
   * Get comprehensive cluster scaling analysis
   */
  async getScalingAnalysis(timeHorizon: '1hour' | '6hours' | '24hours' = '6hours'): Promise<ClusterScalingAnalysis> {
    const topology = await this.topologyManager.getResourceTopology();
    const historical = this.getHistoricalTrends();

    // Calculate projected demand based on historical trends
    const projectedDemand = this.calculateProjectedDemand(historical, timeHorizon);

    // Analyze current state
    const totalCapacity = this.aggregateNodeCapacity(topology.nodes);
    const currentState = {
      totalNodes: topology.nodes.length,
      totalCapacity,
      currentUtilization: topology.performance.utilizationRate,
      bottlenecks: [] as string[]
    };

    // Generate recommendations
    const recommendations = this.generateScalingRecommendations(currentState, projectedDemand, topology);

    // Calculate cost analysis
    const costAnalysis = this.calculateCostAnalysis(currentState, recommendations);

    return {
      currentState,
      projectedDemand,
      recommendations,
      costAnalysis
    };
  }

  /**
   * Get geographic distribution analysis
   */
  async getGeographicAnalysis(): Promise<{
    regions: Record<string, {
      nodes: number;
      resources: number;
      connections: number;
      averageLatency: number;
      crossRegionLatency: Record<string, number>;
      recommendations: string[];
    }>;
    optimization: {
      suggestNewRegions: string[];
      redistributeResources: Array<{
        resourceId: string;
        fromRegion: string;
        toRegion: string;
        expectedLatencyImprovement: number;
      }>;
    };
  }> {
    const topology = await this.topologyManager.getResourceTopology();

    const regions: any = {};

    // Analyze each region based on node distribution
    const regionNodes = new Map<string, NodeResourceCapacity[]>();
    for (const node of topology.nodes) {
      const region = node.region;
      if (!regionNodes.has(region)) {
        regionNodes.set(region, []);
      }
      regionNodes.get(region)!.push(node);
    }

    for (const [region, nodes] of regionNodes) {
      const regionResourceCount = nodes.reduce((sum, n) => sum + n.utilization.activeResources, 0);

      regions[region] = {
        nodes: nodes.length,
        resources: regionResourceCount,
        connections: nodes.reduce((sum, n) => sum + n.utilization.totalConnections, 0),
        averageLatency: 0,
        crossRegionLatency: {},
        recommendations: this.generateRegionRecommendations(region, 1.0, {})
      };
    }

    return {
      regions,
      optimization: {
        suggestNewRegions: [],
        redistributeResources: []
      }
    };
  }

  /**
   * Get performance trends and predictions
   */
  async getPerformanceTrends(): Promise<{
    trends: {
      connections: { current: number; trend: 'up' | 'down' | 'stable'; rate: number };
      messageVolume: { current: number; trend: 'up' | 'down' | 'stable'; rate: number };
      nodeHealth: { current: number; trend: 'up' | 'down' | 'stable'; rate: number };
      latency: { current: number; trend: 'up' | 'down' | 'stable'; rate: number };
    };
    predictions: {
      nextHour: { connections: number; messageVolume: number };
      next6Hours: { connections: number; messageVolume: number };
      next24Hours: { connections: number; messageVolume: number };
    };
    alerts: Array<{
      type: 'trend' | 'threshold' | 'anomaly';
      severity: 'info' | 'warning' | 'critical';
      message: string;
      metric: string;
      value: number;
      threshold?: number;
    }>;
  }> {
    const historical = this.getHistoricalTrends();

    // Calculate trends from historical data
    const trends = this.calculateTrends(historical);

    // Generate predictions
    const predictions = this.generatePredictions(trends, historical);

    // Detect alerts
    const alerts = this.detectTrendAlerts(trends, historical);

    return { trends, predictions, alerts };
  }

  /**
   * Register a resource with the observability system
   */
  async registerResource(resourceType: string, config: {
    defaultReplicationFactor?: number;
    defaultShardingStrategy?: string;
    capacityLimits?: {
      maxInstancesPerNode?: number;
      maxConnectionsPerInstance?: number;
    };
    placementConstraints?: {
      allowedZones?: string[];
      allowedRegions?: string[];
      affinityRules?: string[];
      antiAffinityRules?: string[];
    };
  }): Promise<void> {
    this.topologyManager.registerResourceType(resourceType, config);
  }

  /**
   * Update resource metrics
   */
  async updateResourceMetrics(
    resourceId: string,
    metrics: { connectionCount?: number; messageRate?: number; lastActivity?: number }
  ): Promise<void> {
    // Resource metrics are tracked through the ResourceRegistry
    // This method provides a convenience API for observability
    this.emit('resource-metrics-updated', { resourceId, metrics });
  }

  /**
   * Register node capacity
   */
  async registerNodeCapacity(capacity: NodeResourceCapacity): Promise<void> {
    // Node capacity is tracked through ResourceTopologyManager
    this.emit('node-capacity-registered', capacity);
  }

  /**
   * Private helper methods
   */

  private async buildDashboard(): Promise<ClusterDashboard> {
    const topology = await this.topologyManager.getResourceTopology();

    // Build overview
    const healthyNodeCount = topology.nodes.filter(n => n.health.status === 'healthy').length;
    const totalConnections = topology.nodes.reduce((sum, n) => sum + n.utilization.totalConnections, 0);

    const healthStatus: 'healthy' | 'warning' | 'critical' =
      topology.clusterHealth.isHealthy ? 'healthy' :
      topology.clusterHealth.healthRatio >= 0.5 ? 'warning' : 'critical';

    const overview = {
      totalNodes: topology.nodes.length,
      healthyNodes: healthyNodeCount,
      totalResources: topology.resources.total,
      totalConnections: totalConnections,
      messagesPerSecond: 0, // Would need to aggregate from metrics
      averageLatency: topology.performance.averageLatency,
      clusterHealth: healthStatus
    };

    // Build regions data
    const regions: ClusterDashboard['regions'] = {};
    const regionNodes = new Map<string, NodeResourceCapacity[]>();
    for (const node of topology.nodes) {
      if (!regionNodes.has(node.region)) {
        regionNodes.set(node.region, []);
      }
      regionNodes.get(node.region)!.push(node);
    }

    for (const [region, nodes] of regionNodes) {
      regions[region] = {
        nodes: nodes.length,
        resources: nodes.reduce((sum, n) => sum + n.utilization.activeResources, 0),
        connections: nodes.reduce((sum, n) => sum + n.utilization.totalConnections, 0),
        health: nodes.filter(n => n.health.status === 'healthy').length / nodes.length,
        latency: 0 // Would calculate from cross-region latency
      };
    }

    // Identify hotspots
    const overloadedNodes = topology.nodes
      .filter(n => n.health.status === 'degraded' || n.health.status === 'unhealthy')
      .map(node => ({
        nodeId: node.nodeId,
        cpuUsage: node.utilization.cpuUsage,
        memoryUsage: node.utilization.memoryUsage,
        resourceCount: node.utilization.activeResources
      }));

    const hotspots = {
      highTrafficResources: [] as Array<{ resourceId: string; connections: number; messageRate: number; node: string }>,
      overloadedNodes
    };

    // Calculate trends
    const trends = {
      connectionGrowth: 0, // Would calculate from historical data
      messageVolumeGrowth: 0, // Would calculate from historical data
      nodeHealthTrend: 'stable' as const // Would calculate from historical data
    };

    // Generate alerts
    const alerts: ClusterDashboard['alerts'] = [];
    if (!topology.clusterHealth.isHealthy) {
      alerts.push({
        severity: 'warning',
        message: 'Cluster health is degraded',
        timestamp: Date.now(),
        category: 'health'
      });
    }

    const dashboard: ClusterDashboard = {
      overview,
      regions,
      hotspots,
      trends,
      alerts
    };

    this.lastDashboard = dashboard;
    return dashboard;
  }

  private async handleTopologyUpdate(): Promise<void> {
    try {
      const topology = await this.topologyManager.getResourceTopology();

      // Store in historical data
      this.historicalTopologies.push(topology);
      if (this.historicalTopologies.length > this.maxHistorySize) {
        this.historicalTopologies.shift();
      }

      // Emit events for real-time updates
      this.emit('topology-changed', topology);

      // Check for alerts
      if (!topology.clusterHealth.isHealthy && topology.clusterHealth.healthRatio < 0.5) {
        this.emit('health-alert', {
          severity: 'critical',
          message: 'Cluster health is critical',
          issues: []
        });
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  private async updateDashboard(): Promise<void> {
    try {
      const dashboard = await this.buildDashboard();
      this.emit('dashboard-updated', dashboard);
    } catch (error) {
      this.emit('error', error);
    }
  }

  private calculateAggregatedMetrics(topology: ResourceClusterTopology): any {
    // Calculate aggregated metrics across the cluster
    return {
      totalResources: topology.resources.total,
      healthyResources: topology.resources.healthy,
      performance: topology.performance,
      healthScore: topology.clusterHealth.healthRatio
    };
  }

  private getHistoricalTrends(): ResourceClusterTopology[] {
    return this.historicalTopologies.slice(-20); // Last 20 updates
  }

  private aggregateNodeCapacity(nodes: NodeResourceCapacity[]): NodeResourceCapacity['capacity'] {
    return nodes.reduce(
      (total, node) => ({
        maxResources: total.maxResources + node.capacity.maxResources,
        maxResourceConnections: total.maxResourceConnections + node.capacity.maxResourceConnections,
        maxBandwidth: total.maxBandwidth + node.capacity.maxBandwidth,
        cpuCores: total.cpuCores + node.capacity.cpuCores,
        memoryGB: total.memoryGB + node.capacity.memoryGB,
        diskGB: total.diskGB + node.capacity.diskGB
      }),
      { maxResources: 0, maxResourceConnections: 0, maxBandwidth: 0, cpuCores: 0, memoryGB: 0, diskGB: 0 }
    );
  }

  private calculateProjectedDemand(
    historical: ResourceClusterTopology[],
    timeHorizon: string
  ): ClusterScalingAnalysis['projectedDemand'] {
    // Simple linear projection based on recent trends
    const recent = historical.slice(-5);
    if (recent.length < 2) {
      return {
        timeHorizon: timeHorizon as any,
        expectedLoad: 0,
        expectedResources: 0,
        expectedConnections: 0
      };
    }

    const firstSnapshot = recent[0];
    const lastSnapshot = recent[recent.length - 1];
    const timeDiff = lastSnapshot.timestamp - firstSnapshot.timestamp;

    if (timeDiff === 0) {
      return {
        timeHorizon: timeHorizon as any,
        expectedLoad: lastSnapshot.performance.utilizationRate,
        expectedResources: lastSnapshot.resources.total,
        expectedConnections: lastSnapshot.nodes.reduce((sum, n) => sum + n.utilization.totalConnections, 0)
      };
    }

    // Calculate growth rates
    const resourceGrowthRate = (lastSnapshot.resources.total - firstSnapshot.resources.total) / timeDiff;
    const lastConnections = lastSnapshot.nodes.reduce((sum, n) => sum + n.utilization.totalConnections, 0);
    const firstConnections = firstSnapshot.nodes.reduce((sum, n) => sum + n.utilization.totalConnections, 0);
    const connectionGrowthRate = (lastConnections - firstConnections) / timeDiff;

    // Project forward based on time horizon
    const projectionMs = timeHorizon === '1hour' ? 3600000 :
                        timeHorizon === '6hours' ? 21600000 : 86400000;

    return {
      timeHorizon: timeHorizon as any,
      expectedLoad: lastSnapshot.performance.utilizationRate,
      expectedResources: Math.max(0, lastSnapshot.resources.total + (resourceGrowthRate * projectionMs)),
      expectedConnections: Math.max(0, lastConnections + (connectionGrowthRate * projectionMs))
    };
  }

  private generateScalingRecommendations(
    currentState: any,
    projectedDemand: any,
    topology: ResourceClusterTopology
  ): ClusterScalingAnalysis['recommendations'] {
    const needsScaling = topology.performance.utilizationRate > 0.8;
    const scaleDirection = topology.performance.utilizationRate > 0.8 ? 'up' : 'down';

    return {
      scaleUp: needsScaling && scaleDirection === 'up',
      scaleDown: needsScaling && scaleDirection === 'down',
      addNodes: scaleDirection === 'up' ?
        Math.ceil(currentState.totalNodes * 0.2) : 0,
      removeNodes: [],
      redistributeResources: [],
      urgency: topology.performance.utilizationRate > 0.9 ? 'critical' :
               topology.performance.utilizationRate > 0.8 ? 'high' :
               topology.performance.utilizationRate > 0.6 ? 'medium' : 'low'
    };
  }

  private calculateCostAnalysis(
    currentState: any,
    recommendations: any
  ): ClusterScalingAnalysis['costAnalysis'] {
    // Simplified cost analysis
    const currentCost = currentState.totalNodes * 100; // $100 per node
    const projectedCost = currentCost + (recommendations.addNodes * 100);

    return {
      currentCost,
      projectedCost,
      savings: Math.max(0, currentCost - projectedCost),
      efficiency: currentState.currentUtilization
    };
  }

  private generateRegionRecommendations(
    region: string,
    health: number,
    crossRegionLatency: Record<string, number>
  ): string[] {
    const recommendations: string[] = [];

    if (health < 0.8) {
      recommendations.push(`Region ${region} health is low - consider adding nodes`);
    }

    const latencyValues = Object.values(crossRegionLatency);
    if (latencyValues.length > 0) {
      const avgLatency = latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length;

      if (avgLatency > 200) {
        recommendations.push(`High cross-region latency from ${region} - consider edge optimization`);
      }
    }

    return recommendations;
  }

  private calculateTrends(historical: ResourceClusterTopology[]): any {
    if (historical.length < 2) {
      return {
        connections: { current: 0, trend: 'stable', rate: 0 },
        messageVolume: { current: 0, trend: 'stable', rate: 0 },
        nodeHealth: { current: 1, trend: 'stable', rate: 0 },
        latency: { current: 0, trend: 'stable', rate: 0 }
      };
    }

    const recent = historical[historical.length - 1];
    const previous = historical[historical.length - 2];

    const recentConnections = recent.nodes.reduce((sum, n) => sum + n.utilization.totalConnections, 0);
    const previousConnections = previous.nodes.reduce((sum, n) => sum + n.utilization.totalConnections, 0);

    return {
      connections: {
        current: recentConnections,
        trend: recentConnections > previousConnections ? 'up' :
               recentConnections < previousConnections ? 'down' : 'stable',
        rate: recentConnections - previousConnections
      },
      messageVolume: { current: 0, trend: 'stable' as const, rate: 0 },
      nodeHealth: {
        current: recent.clusterHealth.healthRatio,
        trend: recent.clusterHealth.healthRatio > previous.clusterHealth.healthRatio ? 'up' :
               recent.clusterHealth.healthRatio < previous.clusterHealth.healthRatio ? 'down' : 'stable',
        rate: recent.clusterHealth.healthRatio - previous.clusterHealth.healthRatio
      },
      latency: { current: recent.performance.averageLatency, trend: 'stable' as const, rate: 0 }
    };
  }

  private generatePredictions(trends: any, historical: ResourceClusterTopology[]): any {
    if (historical.length === 0) {
      return {
        nextHour: { connections: 0, messageVolume: 0 },
        next6Hours: { connections: 0, messageVolume: 0 },
        next24Hours: { connections: 0, messageVolume: 0 }
      };
    }

    const current = historical[historical.length - 1];
    const currentConnections = current.nodes.reduce((sum, n) => sum + n.utilization.totalConnections, 0);

    return {
      nextHour: {
        connections: Math.max(0, currentConnections + trends.connections.rate),
        messageVolume: 0
      },
      next6Hours: {
        connections: Math.max(0, currentConnections + (trends.connections.rate * 6)),
        messageVolume: 0
      },
      next24Hours: {
        connections: Math.max(0, currentConnections + (trends.connections.rate * 24)),
        messageVolume: 0
      }
    };
  }

  private detectTrendAlerts(trends: any, historical: ResourceClusterTopology[]): any[] {
    const alerts: any[] = [];

    if (trends.connections.trend === 'up' && trends.connections.rate > 1000) {
      alerts.push({
        type: 'trend',
        severity: 'warning',
        message: 'Rapid connection growth detected',
        metric: 'connections',
        value: trends.connections.current
      });
    }

    if (trends.nodeHealth.trend === 'down' && trends.nodeHealth.rate < -0.1) {
      alerts.push({
        type: 'trend',
        severity: 'critical',
        message: 'Node health declining rapidly',
        metric: 'nodeHealth',
        value: trends.nodeHealth.current
      });
    }

    return alerts;
  }
}
