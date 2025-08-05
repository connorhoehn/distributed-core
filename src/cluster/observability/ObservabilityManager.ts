import { EventEmitter } from 'events';
import { ClusterTopologyManager, RoomMetadata, NodeCapacity, EnhancedClusterTopology } from '../topology/ClusterTopologyManager';
import { ClusterManager } from '../ClusterManager';
import { StateAggregator } from '../aggregation/StateAggregator';
import { MetricsTracker } from '../../monitoring/metrics/MetricsTracker';

/**
 * Room placement and management recommendations
 */
export interface RoomPlacementRecommendation {
  roomId: string;
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
    totalCapacity: NodeCapacity['capacity'];
    currentUtilization: number;
    bottlenecks: string[];
  };
  projectedDemand: {
    timeHorizon: 'immediate' | '1hour' | '6hours' | '24hours';
    expectedLoad: number;
    expectedRooms: number;
    expectedParticipants: number;
  };
  recommendations: {
    scaleUp: boolean;
    scaleDown: boolean;
    addNodes: number;
    removeNodes: string[];
    redistributeRooms: RoomPlacementRecommendation[];
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
    totalRooms: number;
    totalParticipants: number;
    messagesPerSecond: number;
    averageLatency: number;
    clusterHealth: 'healthy' | 'warning' | 'critical';
  };
  regions: {
    [region: string]: {
      nodes: number;
      rooms: number;
      participants: number;
      health: number;
      latency: number;
    };
  };
  hotspots: {
    highTrafficRooms: Array<{
      roomId: string;
      participants: number;
      messageRate: number;
      node: string;
    }>;
    overloadedNodes: Array<{
      nodeId: string;
      cpuUsage: number;
      memoryUsage: number;
      roomCount: number;
    }>;
  };
  trends: {
    participantGrowth: number; // percentage change
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
  roomTypes?: string[];
  
  // Metrics filtering
  minHealth?: number;
  maxUtilization?: number;
  
  // Time-based filtering
  since?: number;
  until?: number;
  
  // Projection and grouping
  groupBy?: 'region' | 'zone' | 'role' | 'roomType';
  includeMetrics?: boolean;
  includeHistory?: boolean;
  includeProjections?: boolean;
}

/**
 * ObservabilityManager provides comprehensive cluster observability and management APIs
 * 
 * This manager builds on top of ClusterTopologyManager to provide:
 * - Real-time dashboard APIs for monitoring UIs
 * - Advanced querying and filtering of cluster topology
 * - Predictive scaling analysis and recommendations
 * - Room placement optimization
 * - Geographic distribution optimization
 * - Performance trend analysis and alerting
 */
export class ObservabilityManager extends EventEmitter {
  private topologyManager: ClusterTopologyManager;
  private cluster: ClusterManager;
  private dashboardUpdateInterval?: NodeJS.Timeout;
  private lastDashboard?: ClusterDashboard;
  
  // Historical data for trend analysis
  private historicalTopologies: EnhancedClusterTopology[] = [];
  private maxHistorySize = 100;
  
  // Configuration
  private dashboardUpdateIntervalMs = 10000; // 10 seconds
  
  constructor(
    topologyManager: ClusterTopologyManager,
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
    this.topologyManager.on('topology-updated', (topology) => {
      this.handleTopologyUpdate(topology);
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
    
    // Listen to topology events with bound handler
    this.topologyManager.on('topology-updated', this.handleTopologyUpdate.bind(this));
    
    this.emit('started');
  }    /**
   * Stop the observability system
   */
  async stop(): Promise<void> {
    // Stop intervals
    if (this.dashboardUpdateInterval) {
      clearInterval(this.dashboardUpdateInterval);
      this.dashboardUpdateInterval = undefined;
    }
    
    // Remove event listeners to prevent memory leaks
    this.topologyManager.removeListener('topology-updated', this.handleTopologyUpdate.bind(this));
    
    // Stop topology manager
    await this.topologyManager.stop();
    
    this.emit('stopped');
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
    topology: EnhancedClusterTopology;
    filteredNodes: NodeCapacity[];
    filteredRooms: RoomMetadata[];
    aggregatedMetrics?: any;
  }> {
    const topology = await this.topologyManager.getClusterTopology();
    
    // Apply filters (implementation would depend on how we store this data)
    // For now, return the full topology
    return {
      topology,
      filteredNodes: [], // Would be filtered based on query
      filteredRooms: [], // Would be filtered based on query
      aggregatedMetrics: query.includeMetrics ? this.calculateAggregatedMetrics(topology) : undefined
    };
  }

  /**
   * Get room placement recommendations for optimization
   */
  async getRoomPlacementRecommendations(
    optimizeFor: 'performance' | 'cost' | 'availability' | 'latency' = 'performance'
  ): Promise<RoomPlacementRecommendation[]> {
    const topology = await this.topologyManager.getClusterTopology();
    const recommendations: RoomPlacementRecommendation[] = [];
    
    // Analyze each room for potential optimization
    // This is a simplified implementation - real optimization would be more complex
    
    return recommendations;
  }

  /**
   * Get comprehensive cluster scaling analysis
   */
  async getScalingAnalysis(timeHorizon: '1hour' | '6hours' | '24hours' = '6hours'): Promise<ClusterScalingAnalysis> {
    const topology = await this.topologyManager.getClusterTopology();
    const historical = this.getHistoricalTrends();
    
    // Calculate projected demand based on historical trends
    const projectedDemand = this.calculateProjectedDemand(historical, timeHorizon);
    
    // Analyze current state
    const currentState = {
      totalNodes: topology.totalNodes,
      totalCapacity: topology.clusterCapacity.totalCapacity,
      currentUtilization: topology.clusterCapacity.utilizationPercentage,
      bottlenecks: topology.clusterCapacity.bottlenecks
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
      rooms: number;
      participants: number;
      averageLatency: number;
      crossRegionLatency: Record<string, number>;
      recommendations: string[];
    }>;
    optimization: {
      suggestNewRegions: string[];
      redistributeRooms: Array<{
        roomId: string;
        fromRegion: string;
        toRegion: string;
        expectedLatencyImprovement: number;
      }>;
    };
  }> {
    const topology = await this.topologyManager.getClusterTopology();
    
    const regions: any = {};
    
    // Analyze each region
    for (const region of topology.geographic.regions) {
      const regionHealth = topology.geographic.regionHealth[region] || 0;
      const crossRegionLatency = topology.geographic.crossRegionLatency[region] || {};
      
      regions[region] = {
        nodes: topology.nodeDistribution.byRegion[region] || 0,
        rooms: topology.rooms.byRegion[region] || 0,
        participants: 0, // Would need to aggregate from room data
        averageLatency: Object.values(crossRegionLatency).reduce((a, b) => a + b, 0) / Object.values(crossRegionLatency).length || 0,
        crossRegionLatency,
        recommendations: this.generateRegionRecommendations(region, regionHealth, crossRegionLatency)
      };
    }
    
    return {
      regions,
      optimization: {
        suggestNewRegions: [],
        redistributeRooms: []
      }
    };
  }

  /**
   * Get performance trends and predictions
   */
  async getPerformanceTrends(): Promise<{
    trends: {
      participants: { current: number; trend: 'up' | 'down' | 'stable'; rate: number };
      messageVolume: { current: number; trend: 'up' | 'down' | 'stable'; rate: number };
      nodeHealth: { current: number; trend: 'up' | 'down' | 'stable'; rate: number };
      latency: { current: number; trend: 'up' | 'down' | 'stable'; rate: number };
    };
    predictions: {
      nextHour: { participants: number; messageVolume: number };
      next6Hours: { participants: number; messageVolume: number };
      next24Hours: { participants: number; messageVolume: number };
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
   * Register a room with the observability system
   */
  async registerRoom(roomMetadata: RoomMetadata): Promise<void> {
    await this.topologyManager.registerRoom(roomMetadata);
  }

  /**
   * Update room metrics
   */
  async updateRoomMetrics(
    roomId: string,
    metrics: { participantCount?: number; messageRate?: number; lastActivity?: number }
  ): Promise<void> {
    await this.topologyManager.updateRoomMetadata(roomId, metrics);
  }

  /**
   * Register node capacity
   */
  async registerNodeCapacity(capacity: NodeCapacity): Promise<void> {
    await this.topologyManager.registerNodeCapacity(capacity);
  }

  /**
   * Private helper methods
   */

  private async buildDashboard(): Promise<ClusterDashboard> {
    const topology = await this.topologyManager.getClusterTopology();
    const healthReport = await this.topologyManager.getNodeHealthReport();
    
    // Build overview
    const overview = {
      totalNodes: topology.totalNodes,
      healthyNodes: topology.aliveNodes,
      totalRooms: topology.rooms.total,
      totalParticipants: topology.clusterCapacity.totalUtilization.totalParticipants,
      messagesPerSecond: 0, // Would need to aggregate from metrics
      averageLatency: 0, // Would need to calculate from network metrics
      clusterHealth: topology.overallHealth.status
    };
    
    // Build regions data
    const regions: ClusterDashboard['regions'] = {};
    for (const region of topology.geographic.regions) {
      regions[region] = {
        nodes: topology.nodeDistribution.byRegion[region] || 0,
        rooms: topology.rooms.byRegion[region] || 0,
        participants: 0, // Would aggregate from room data
        health: topology.geographic.regionHealth[region] || 0,
        latency: 0 // Would calculate from cross-region latency
      };
    }
    
    // Identify hotspots
    const hotspots = {
      highTrafficRooms: [], // Would identify from room metrics
      overloadedNodes: healthReport.overloaded.map(node => ({
        nodeId: node.nodeId,
        cpuUsage: node.utilization.cpuUsage,
        memoryUsage: node.utilization.memoryUsage,
        roomCount: node.utilization.activeRooms
      }))
    };
    
    // Calculate trends
    const trends = {
      participantGrowth: 0, // Would calculate from historical data
      messageVolumeGrowth: 0, // Would calculate from historical data
      nodeHealthTrend: 'stable' as const // Would calculate from historical data
    };
    
    // Generate alerts
    const alerts = topology.overallHealth.issues.map(issue => ({
      severity: 'warning' as const,
      message: issue,
      timestamp: Date.now(),
      category: 'health' as const
    }));
    
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

  private handleTopologyUpdate(topology: EnhancedClusterTopology): void {
    // Store in historical data
    this.historicalTopologies.push(topology);
    if (this.historicalTopologies.length > this.maxHistorySize) {
      this.historicalTopologies.shift();
    }
    
    // Emit events for real-time updates
    this.emit('topology-changed', topology);
    
    // Check for alerts
    if (topology.overallHealth.status === 'critical') {
      this.emit('health-alert', {
        severity: 'critical',
        message: 'Cluster health is critical',
        issues: topology.overallHealth.issues
      });
    }
    
    if (topology.scalingRecommendations.urgency === 'critical') {
      this.emit('scaling-alert', {
        severity: 'critical',
        message: 'Immediate scaling action required',
        recommendations: topology.scalingRecommendations.recommendedActions
      });
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

  private calculateAggregatedMetrics(topology: EnhancedClusterTopology): any {
    // Calculate aggregated metrics across the cluster
    return {
      totalCapacity: topology.clusterCapacity.totalCapacity,
      totalUtilization: topology.clusterCapacity.totalUtilization,
      utilizationPercentage: topology.clusterCapacity.utilizationPercentage,
      healthScore: topology.overallHealth.score
    };
  }

  private getHistoricalTrends(): EnhancedClusterTopology[] {
    return this.historicalTopologies.slice(-20); // Last 20 updates
  }

  private calculateProjectedDemand(
    historical: EnhancedClusterTopology[],
    timeHorizon: string
  ): ClusterScalingAnalysis['projectedDemand'] {
    // Simple linear projection based on recent trends
    const recent = historical.slice(-5);
    if (recent.length < 2) {
      return {
        timeHorizon: timeHorizon as any,
        expectedLoad: 0,
        expectedRooms: 0,
        expectedParticipants: 0
      };
    }
    
    const firstSnapshot = recent[0];
    const lastSnapshot = recent[recent.length - 1];
    const timeDiff = lastSnapshot.timestamp - firstSnapshot.timestamp;
    
    if (timeDiff === 0) {
      return {
        timeHorizon: timeHorizon as any,
        expectedLoad: lastSnapshot.clusterCapacity.utilizationPercentage,
        expectedRooms: lastSnapshot.rooms.total,
        expectedParticipants: lastSnapshot.clusterCapacity.totalUtilization.totalParticipants
      };
    }
    
    // Calculate growth rates
    const roomGrowthRate = (lastSnapshot.rooms.total - firstSnapshot.rooms.total) / timeDiff;
    const participantGrowthRate = (
      lastSnapshot.clusterCapacity.totalUtilization.totalParticipants - 
      firstSnapshot.clusterCapacity.totalUtilization.totalParticipants
    ) / timeDiff;
    
    // Project forward based on time horizon
    const projectionMs = timeHorizon === '1hour' ? 3600000 : 
                        timeHorizon === '6hours' ? 21600000 : 86400000;
    
    return {
      timeHorizon: timeHorizon as any,
      expectedLoad: lastSnapshot.clusterCapacity.utilizationPercentage,
      expectedRooms: Math.max(0, lastSnapshot.rooms.total + (roomGrowthRate * projectionMs)),
      expectedParticipants: Math.max(0, 
        lastSnapshot.clusterCapacity.totalUtilization.totalParticipants + 
        (participantGrowthRate * projectionMs)
      )
    };
  }

  private generateScalingRecommendations(
    currentState: any,
    projectedDemand: any,
    topology: EnhancedClusterTopology
  ): ClusterScalingAnalysis['recommendations'] {
    const recommendations = topology.scalingRecommendations;
    
    return {
      scaleUp: recommendations.needsScaling && recommendations.scaleDirection === 'up',
      scaleDown: recommendations.needsScaling && recommendations.scaleDirection === 'down',
      addNodes: recommendations.scaleDirection === 'up' ? 
        Math.ceil(currentState.totalNodes * 0.2) : 0,
      removeNodes: [],
      redistributeRooms: [],
      urgency: recommendations.urgency
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
    
    const avgLatency = Object.values(crossRegionLatency).reduce((a, b) => a + b, 0) / 
                      Object.values(crossRegionLatency).length;
    
    if (avgLatency > 200) {
      recommendations.push(`High cross-region latency from ${region} - consider edge optimization`);
    }
    
    return recommendations;
  }

  private calculateTrends(historical: EnhancedClusterTopology[]): any {
    if (historical.length < 2) {
      return {
        participants: { current: 0, trend: 'stable', rate: 0 },
        messageVolume: { current: 0, trend: 'stable', rate: 0 },
        nodeHealth: { current: 1, trend: 'stable', rate: 0 },
        latency: { current: 0, trend: 'stable', rate: 0 }
      };
    }
    
    const recent = historical[historical.length - 1];
    const previous = historical[historical.length - 2];
    
    return {
      participants: {
        current: recent.clusterCapacity.totalUtilization.totalParticipants,
        trend: recent.clusterCapacity.totalUtilization.totalParticipants > 
               previous.clusterCapacity.totalUtilization.totalParticipants ? 'up' : 
               recent.clusterCapacity.totalUtilization.totalParticipants < 
               previous.clusterCapacity.totalUtilization.totalParticipants ? 'down' : 'stable',
        rate: recent.clusterCapacity.totalUtilization.totalParticipants - 
              previous.clusterCapacity.totalUtilization.totalParticipants
      },
      messageVolume: { current: 0, trend: 'stable' as const, rate: 0 },
      nodeHealth: {
        current: recent.overallHealth.score,
        trend: recent.overallHealth.score > previous.overallHealth.score ? 'up' : 
               recent.overallHealth.score < previous.overallHealth.score ? 'down' : 'stable',
        rate: recent.overallHealth.score - previous.overallHealth.score
      },
      latency: { current: 0, trend: 'stable' as const, rate: 0 }
    };
  }

  private generatePredictions(trends: any, historical: EnhancedClusterTopology[]): any {
    const current = historical[historical.length - 1];
    
    return {
      nextHour: {
        participants: Math.max(0, current.clusterCapacity.totalUtilization.totalParticipants + trends.participants.rate),
        messageVolume: 0
      },
      next6Hours: {
        participants: Math.max(0, current.clusterCapacity.totalUtilization.totalParticipants + (trends.participants.rate * 6)),
        messageVolume: 0
      },
      next24Hours: {
        participants: Math.max(0, current.clusterCapacity.totalUtilization.totalParticipants + (trends.participants.rate * 24)),
        messageVolume: 0
      }
    };
  }

  private detectTrendAlerts(trends: any, historical: EnhancedClusterTopology[]): any[] {
    const alerts: any[] = [];
    
    if (trends.participants.trend === 'up' && trends.participants.rate > 1000) {
      alerts.push({
        type: 'trend',
        severity: 'warning',
        message: 'Rapid participant growth detected',
        metric: 'participants',
        value: trends.participants.current
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
