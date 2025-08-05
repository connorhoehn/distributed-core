import { EventEmitter } from 'events';
import { ClusterManager } from '../ClusterManager';
import { StateAggregator, AggregatedClusterState } from '../aggregation/StateAggregator';
import { ClusterState, LogicalService, PerformanceMetrics } from '../introspection/ClusterIntrospection';
import { ClusterHealth, ClusterTopology, ClusterMetadata, NodeInfo } from '../types';
import { MetricsTracker, UnifiedMetrics } from '../../monitoring/metrics/MetricsTracker';

/**
 * Enhanced room metadata for sharding and HA rules
 */
export interface RoomMetadata {
  roomId: string;
  ownerNode: string;
  participantCount: number;
  messageRate: number;
  created: number;
  lastActivity: number;
  
  // Sharding configuration
  sharding: {
    enabled: boolean;
    maxParticipants?: number;
    shardCount?: number;
    shardNodes?: string[];
    shardingStrategy: 'participant-count' | 'message-rate' | 'geographic' | 'manual';
  };
  
  // High Availability rules
  highAvailability: {
    enabled: boolean;
    replicationFactor: number;
    regions: string[];
    zones: string[];
    requirements: {
      crossRegion: boolean;
      crossZone: boolean;
      isolation: 'none' | 'zone' | 'region' | 'dedicated';
      minNodes?: number;
    };
  };
  
  // Room type configuration
  roomType: {
    type: 'chat' | 'broadcast' | 'conference' | 'private';
    capabilities: string[];
    permissions: {
      canPost: string[]; // roles that can post
      canView: string[]; // roles that can view
      moderators?: string[];
    };
  };
  
  // Performance characteristics
  performance: {
    priority: 'low' | 'normal' | 'high' | 'critical';
    expectedLoad: number;
    maxLatency: number;
    guaranteedDelivery: boolean;
  };
  
  // Geographic and deployment metadata
  geographic: {
    primaryRegion?: string;
    allowedRegions?: string[];
    latencyConstraints?: Record<string, number>; // region -> max latency ms
  };
}

/**
 * Node capacity and resource information
 */
export interface NodeCapacity {
  nodeId: string;
  region: string;
  zone: string;
  role: string;
  
  // Resource limits
  capacity: {
    maxRooms: number;
    maxParticipants: number;
    maxBandwidth: number; // MB/s
    cpuCores: number;
    memoryGB: number;
  };
  
  // Current utilization
  utilization: {
    activeRooms: number;
    totalParticipants: number;
    bandwidthUsage: number;
    cpuUsage: number;
    memoryUsage: number;
    networkLatency: Record<string, number>; // node -> latency
  };
  
  // Capabilities
  capabilities: {
    supportsSharding: boolean;
    supportsHA: boolean;
    supportsBroadcast: boolean;
    maxConcurrentConnections: number;
  };
  
  // Health and availability
  health: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    availability: number; // 0-1
    lastHealthCheck: number;
  };
}

/**
 * Comprehensive cluster topology view
 */
export interface EnhancedClusterTopology {
  // Basic topology
  totalNodes: number;
  aliveNodes: number;
  nodeDistribution: {
    byRegion: Record<string, number>;
    byZone: Record<string, number>;
    byRole: Record<string, number>;
  };
  
  // Room distribution and management
  rooms: {
    total: number;
    byNode: Record<string, number>;
    byRegion: Record<string, number>;
    byType: Record<string, number>;
    shardedRooms: number;
    replicatedRooms: number;
  };
  
  // Capacity and load
  clusterCapacity: {
    totalCapacity: NodeCapacity['capacity'];
    totalUtilization: NodeCapacity['utilization'];
    utilizationPercentage: number;
    bottlenecks: string[];
  };
  
  // Scaling recommendations
  scalingRecommendations: {
    needsScaling: boolean;
    scaleDirection: 'up' | 'down' | 'rebalance';
    reasoning: string[];
    urgency: 'low' | 'medium' | 'high' | 'critical';
    recommendedActions: ScalingAction[];
  };
  
  // Health and performance
  overallHealth: {
    score: number; // 0-1
    status: 'healthy' | 'warning' | 'critical';
    issues: string[];
  };
  
  // Geographic distribution
  geographic: {
    regions: string[];
    crossRegionLatency: Record<string, Record<string, number>>;
    regionHealth: Record<string, number>;
  };
  
  timestamp: number;
}

/**
 * Scaling action recommendations
 */
export interface ScalingAction {
  type: 'add-node' | 'remove-node' | 'shard-room' | 'migrate-room' | 'replicate-room';
  priority: number;
  description: string;
  target?: string; // room ID or node ID
  parameters: Record<string, any>;
  estimatedImpact: {
    capacityChange: number;
    performanceImprovement: number;
    costChange: number;
  };
}

/**
 * Room scaling decision criteria
 */
export interface RoomScalingCriteria {
  maxParticipantsPerRoom: number;
  maxMessageRatePerRoom: number;
  maxLatencyThreshold: number;
  crossRegionReplicationThreshold: number;
  broadcastThreshold: number;
}

/**
 * ClusterTopologyManager provides comprehensive cluster observability and management
 * 
 * Features:
 * - Real-time topology visualization with room distribution
 * - Intelligent scaling recommendations based on load and performance
 * - Room sharding and HA rules management
 * - Geographic distribution and latency optimization
 * - Capacity planning and resource utilization tracking
 * - Anti-entropy driven eventual consistency for topology state
 */
export class ClusterTopologyManager extends EventEmitter {
  private cluster: ClusterManager;
  private stateAggregator: StateAggregator;
  private metricsTracker: MetricsTracker;
  
  // State tracking
  private nodeCapacities = new Map<string, NodeCapacity>();
  private roomMetadata = new Map<string, RoomMetadata>();
  private topologyUpdateInterval?: NodeJS.Timeout;
  private lastTopologyUpdate = 0;
  
  // Configuration
  private updateIntervalMs = 5000;
  private scalingCriteria: RoomScalingCriteria = {
    maxParticipantsPerRoom: 10000,
    maxMessageRatePerRoom: 1000, // messages/second
    maxLatencyThreshold: 500, // ms
    crossRegionReplicationThreshold: 1000, // participants
    broadcastThreshold: 5000 // participants for broadcast optimization
  };

  constructor(
    cluster: ClusterManager,
    stateAggregator: StateAggregator,
    metricsTracker: MetricsTracker,
    config?: {
      updateIntervalMs?: number;
      scalingCriteria?: Partial<RoomScalingCriteria>;
    }
  ) {
    super();
    this.cluster = cluster;
    this.stateAggregator = stateAggregator;
    this.metricsTracker = metricsTracker;
    
    if (config) {
      this.updateIntervalMs = config.updateIntervalMs || this.updateIntervalMs;
      this.scalingCriteria = { ...this.scalingCriteria, ...config.scalingCriteria };
    }
  }

  /**
   * Start topology monitoring and periodic updates
   */
  async start(): Promise<void> {
    // Initialize node capacity tracking
    await this.initializeNodeCapacities();
    
    // Start periodic topology updates with bound function
    this.topologyUpdateInterval = setInterval(
      this.updateTopology.bind(this),
      this.updateIntervalMs
    );
    
    // Unref the interval so it doesn't keep the process alive
    this.topologyUpdateInterval.unref();
    
    // Listen for cluster events with bound handlers
    this.cluster.on('member-joined', this.handleNodeJoined.bind(this));
    this.cluster.on('member-left', this.handleNodeLeft.bind(this));
    this.cluster.on('member-updated', this.handleNodeUpdated.bind(this));
    
    this.emit('started');
  }

  /**
   * Stop topology monitoring
   */
  async stop(): Promise<void> {
    if (this.topologyUpdateInterval) {
      clearInterval(this.topologyUpdateInterval);
      this.topologyUpdateInterval = undefined;
    }
    
    // Remove event listeners to prevent memory leaks
    this.cluster.removeListener('member-joined', this.handleNodeJoined.bind(this));
    this.cluster.removeListener('member-left', this.handleNodeLeft.bind(this));
    this.cluster.removeListener('member-updated', this.handleNodeUpdated.bind(this));
    
    this.emit('stopped');
  }

  /**
   * Get comprehensive cluster topology with eventual consistency
   */
  async getClusterTopology(): Promise<EnhancedClusterTopology> {
    // Collect aggregated cluster state via anti-entropy
    const aggregatedState = await this.stateAggregator.collectClusterState();
    
    // Get current metrics
    const currentMetrics = await this.metricsTracker.getCurrentMetrics();
    
    // Build comprehensive topology
    const topology = await this.buildEnhancedTopology(aggregatedState, currentMetrics || this.createDefaultMetrics());
    
    this.lastTopologyUpdate = Date.now();
    this.emit('topology-updated', topology);
    
    return topology;
  }

  /**
   * Create default metrics when none are available
   */
  private createDefaultMetrics(): UnifiedMetrics {
    return {
      timestamp: Date.now(),
      system: {
        cpu: { percentage: 0 },
        memory: { used: 0, total: 0, percentage: 0 },
        disk: { used: 0, available: 0, total: 0, percentage: 0 }
      },
      cluster: {
        membershipSize: 0,
        gossipRate: 0,
        failureDetectionLatency: 0,
        averageHeartbeatInterval: 0,
        messageRate: 0,
        messageLatency: 0,
        networkThroughput: 0,
        clusterStability: 'stable' as const
      },
      network: {
        latency: 0,
        status: 'connected' as const,
        roundTripTimes: new Map(),
        failedConnections: 0,
        activeConnections: 0
      },
      connections: {
        totalAcquired: 0,
        totalReleased: 0,
        totalCreated: 0,
        totalDestroyed: 0,
        activeConnections: 0,
        poolUtilization: 0,
        averageAcquireTime: 0,
        connectionHealth: 'healthy' as const
      },
      health: {
        overallHealth: 'healthy' as const,
        nodeHealth: new Map(),
        systemAlerts: [],
        performanceTrends: {
          cpu: 'stable' as const,
          memory: 'stable' as const,
          network: 'stable' as const
        }
      }
    };
  }

  /**
   * Register room metadata for management and scaling decisions
   */
  async registerRoom(roomMetadata: RoomMetadata): Promise<void> {
    this.roomMetadata.set(roomMetadata.roomId, roomMetadata);
    
    // Check if room needs immediate attention
    const scalingActions = await this.analyzeRoomScaling(roomMetadata);
    if (scalingActions.length > 0) {
      this.emit('room-scaling-needed', {
        roomId: roomMetadata.roomId,
        actions: scalingActions
      });
    }
    
    // Update cluster topology to reflect new room
    this.updateTopologyAsync();
  }

  /**
   * Update room metadata (participant count, message rate, etc.)
   */
  async updateRoomMetadata(
    roomId: string, 
    updates: Partial<Pick<RoomMetadata, 'participantCount' | 'messageRate' | 'lastActivity'>>
  ): Promise<void> {
    const existing = this.roomMetadata.get(roomId);
    if (existing) {
      this.roomMetadata.set(roomId, { ...existing, ...updates });
      
      // Check if scaling is needed
      const updated = this.roomMetadata.get(roomId)!;
      const scalingActions = await this.analyzeRoomScaling(updated);
      if (scalingActions.length > 0) {
        this.emit('room-scaling-needed', {
          roomId,
          actions: scalingActions
        });
      }
    }
  }

  /**
   * Register node capacity information
   */
  async registerNodeCapacity(capacity: NodeCapacity): Promise<void> {
    this.nodeCapacities.set(capacity.nodeId, capacity);
    this.emit('node-capacity-updated', capacity);
  }

  /**
   * Get scaling recommendations for the entire cluster
   */
  async getScalingRecommendations(): Promise<ScalingAction[]> {
    const topology = await this.getClusterTopology();
    return topology.scalingRecommendations.recommendedActions;
  }

  /**
   * Get room distribution recommendations based on HA rules
   */
  async getRoomDistributionRecommendations(roomId: string): Promise<{
    primaryNode: string;
    replicaNodes: string[];
    reasoning: string[];
  }> {
    const roomMetadata = this.roomMetadata.get(roomId);
    if (!roomMetadata) {
      throw new Error(`Room ${roomId} not found`);
    }

    const topology = await this.getClusterTopology();
    const availableNodes = Array.from(this.nodeCapacities.values())
      .filter(node => node.health.status === 'healthy');

    // Get room distribution recommendations based on HA rules
    if (roomMetadata.highAvailability.enabled) {
      return this.calculateHADistribution(roomMetadata, availableNodes, topology);
    }

    // Default to hash ring distribution
    const hashRing = this.cluster.hashRing;
    const primaryNode = hashRing.getNode(roomId);
    
    return {
      primaryNode: primaryNode || availableNodes[0]?.nodeId || '',
      replicaNodes: [],
      reasoning: ['Using consistent hash ring for room distribution']
    };
  }

  /**
   * Analyze if a room needs sharding
   */
  async analyzeRoomSharding(roomId: string): Promise<{
    needsSharding: boolean;
    recommendedShards: number;
    shardingStrategy: RoomMetadata['sharding']['shardingStrategy'];
    reasoning: string[];
  }> {
    const roomMetadata = this.roomMetadata.get(roomId);
    if (!roomMetadata) {
      throw new Error(`Room ${roomId} not found`);
    }

    const reasoning: string[] = [];
    let needsSharding = false;
    let recommendedShards = 1;
    let shardingStrategy: RoomMetadata['sharding']['shardingStrategy'] = 'participant-count';

    // Check participant count
    if (roomMetadata.participantCount > this.scalingCriteria.maxParticipantsPerRoom) {
      needsSharding = true;
      recommendedShards = Math.ceil(roomMetadata.participantCount / this.scalingCriteria.maxParticipantsPerRoom);
      reasoning.push(`Participant count (${roomMetadata.participantCount}) exceeds threshold (${this.scalingCriteria.maxParticipantsPerRoom})`);
    }

    // Check message rate
    if (roomMetadata.messageRate > this.scalingCriteria.maxMessageRatePerRoom) {
      needsSharding = true;
      const messageShards = Math.ceil(roomMetadata.messageRate / this.scalingCriteria.maxMessageRatePerRoom);
      recommendedShards = Math.max(recommendedShards, messageShards);
      shardingStrategy = 'message-rate';
      reasoning.push(`Message rate (${roomMetadata.messageRate}/s) exceeds threshold (${this.scalingCriteria.maxMessageRatePerRoom}/s)`);
    }

    // Check if it's a broadcast room with many viewers
    if (roomMetadata.roomType.type === 'broadcast' && 
        roomMetadata.participantCount > this.scalingCriteria.broadcastThreshold) {
      needsSharding = true;
      recommendedShards = Math.max(recommendedShards, 3); // Typically use 3 shards for broadcasts
      reasoning.push(`Broadcast room with ${roomMetadata.participantCount} participants needs sharding for scalability`);
    }

    return {
      needsSharding,
      recommendedShards,
      shardingStrategy,
      reasoning
    };
  }

  /**
   * Get node health and capacity report
   */
  async getNodeHealthReport(): Promise<{
    healthy: NodeCapacity[];
    degraded: NodeCapacity[];
    unhealthy: NodeCapacity[];
    overloaded: NodeCapacity[];
    recommendations: string[];
  }> {
    const allNodes = Array.from(this.nodeCapacities.values());
    
    const healthy = allNodes.filter(n => n.health.status === 'healthy' && n.utilization.cpuUsage < 0.8);
    const degraded = allNodes.filter(n => n.health.status === 'degraded');
    const unhealthy = allNodes.filter(n => n.health.status === 'unhealthy');
    const overloaded = allNodes.filter(n => n.utilization.cpuUsage >= 0.9 || n.utilization.memoryUsage >= 0.9);
    
    const recommendations: string[] = [];
    
    if (unhealthy.length > 0) {
      recommendations.push(`${unhealthy.length} nodes are unhealthy and need immediate attention`);
    }
    
    if (overloaded.length > 0) {
      recommendations.push(`${overloaded.length} nodes are overloaded - consider adding capacity or redistributing load`);
    }
    
    const totalCapacity = healthy.length + degraded.length;
    if (totalCapacity < 3) {
      recommendations.push('Cluster has fewer than 3 healthy nodes - add nodes for better resilience');
    }

    return {
      healthy,
      degraded,
      unhealthy,
      overloaded,
      recommendations
    };
  }

  /**
   * Private methods for internal operations
   */

  private async initializeNodeCapacities(): Promise<void> {
    // Get current cluster membership
    const membershipEntries = this.cluster.membership.getAllMembers();
    
    for (const entry of membershipEntries) {
      if (entry.status === 'ALIVE') {
        // Initialize with default capacity if not already set
        if (!this.nodeCapacities.has(entry.id)) {
          const defaultCapacity: NodeCapacity = {
            nodeId: entry.id,
            region: entry.metadata?.region || 'unknown',
            zone: entry.metadata?.zone || 'unknown',
            role: entry.metadata?.role || 'worker',
            capacity: {
              maxRooms: 1000,
              maxParticipants: 10000,
              maxBandwidth: 100,
              cpuCores: 4,
              memoryGB: 8
            },
            utilization: {
              activeRooms: 0,
              totalParticipants: 0,
              bandwidthUsage: 0,
              cpuUsage: 0,
              memoryUsage: 0,
              networkLatency: {}
            },
            capabilities: {
              supportsSharding: true,
              supportsHA: true,
              supportsBroadcast: true,
              maxConcurrentConnections: 10000
            },
            health: {
              status: 'healthy',
              availability: 1.0,
              lastHealthCheck: Date.now()
            }
          };
          
          this.nodeCapacities.set(entry.id, defaultCapacity);
        }
      }
    }
  }

  private async updateTopology(): Promise<void> {
    try {
      const topology = await this.getClusterTopology();
      // Topology update is handled in getClusterTopology via event emission
    } catch (error) {
      this.emit('error', error);
    }
  }

  private updateTopologyAsync(): void {
    setImmediate(() => this.updateTopology());
  }

  private async buildEnhancedTopology(
    aggregatedState: AggregatedClusterState,
    currentMetrics: UnifiedMetrics
  ): Promise<EnhancedClusterTopology> {
    const allNodes = Array.from(this.nodeCapacities.values());
    const healthyNodes = allNodes.filter(n => n.health.status === 'healthy');
    
    // Calculate room distribution
    const roomsByNode: Record<string, number> = {};
    const roomsByRegion: Record<string, number> = {};
    const roomsByType: Record<string, number> = {};
    let shardedRooms = 0;
    let replicatedRooms = 0;
    
    for (const room of this.roomMetadata.values()) {
      // Count by owner node
      roomsByNode[room.ownerNode] = (roomsByNode[room.ownerNode] || 0) + 1;
      
      // Count by region
      const nodeCapacity = this.nodeCapacities.get(room.ownerNode);
      if (nodeCapacity) {
        roomsByRegion[nodeCapacity.region] = (roomsByRegion[nodeCapacity.region] || 0) + 1;
      }
      
      // Count by type
      roomsByType[room.roomType.type] = (roomsByType[room.roomType.type] || 0) + 1;
      
      // Count sharded and replicated
      if (room.sharding.enabled) shardedRooms++;
      if (room.highAvailability.enabled) replicatedRooms++;
    }
    
    // Calculate cluster capacity
    const totalCapacity = allNodes.reduce((acc, node) => ({
      maxRooms: acc.maxRooms + node.capacity.maxRooms,
      maxParticipants: acc.maxParticipants + node.capacity.maxParticipants,
      maxBandwidth: acc.maxBandwidth + node.capacity.maxBandwidth,
      cpuCores: acc.cpuCores + node.capacity.cpuCores,
      memoryGB: acc.memoryGB + node.capacity.memoryGB
    }), { maxRooms: 0, maxParticipants: 0, maxBandwidth: 0, cpuCores: 0, memoryGB: 0 });
    
    const totalUtilization = allNodes.reduce((acc, node) => ({
      activeRooms: acc.activeRooms + node.utilization.activeRooms,
      totalParticipants: acc.totalParticipants + node.utilization.totalParticipants,
      bandwidthUsage: acc.bandwidthUsage + node.utilization.bandwidthUsage,
      cpuUsage: acc.cpuUsage + node.utilization.cpuUsage,
      memoryUsage: acc.memoryUsage + node.utilization.memoryUsage,
      networkLatency: {}
    }), { activeRooms: 0, totalParticipants: 0, bandwidthUsage: 0, cpuUsage: 0, memoryUsage: 0, networkLatency: {} });
    
    // Calculate utilization percentage
    const utilizationPercentage = allNodes.length > 0 ? 
      (totalUtilization.cpuUsage / allNodes.length + totalUtilization.memoryUsage / allNodes.length) / 2 : 0;
    
    // Generate scaling recommendations
    const scalingRecommendations = await this.generateScalingRecommendations(
      allNodes, totalCapacity, totalUtilization, aggregatedState
    );
    
    // Calculate overall health
    const healthScore = healthyNodes.length / Math.max(allNodes.length, 1);
    const healthStatus = healthScore > 0.8 ? 'healthy' : healthScore > 0.5 ? 'warning' : 'critical';
    
    return {
      totalNodes: allNodes.length,
      aliveNodes: healthyNodes.length,
      nodeDistribution: {
        byRegion: allNodes.reduce((acc, node) => {
          acc[node.region] = (acc[node.region] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        byZone: allNodes.reduce((acc, node) => {
          acc[node.zone] = (acc[node.zone] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        byRole: allNodes.reduce((acc, node) => {
          acc[node.role] = (acc[node.role] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      },
      rooms: {
        total: this.roomMetadata.size,
        byNode: roomsByNode,
        byRegion: roomsByRegion,
        byType: roomsByType,
        shardedRooms,
        replicatedRooms
      },
      clusterCapacity: {
        totalCapacity,
        totalUtilization,
        utilizationPercentage,
        bottlenecks: this.identifyBottlenecks(allNodes)
      },
      scalingRecommendations,
      overallHealth: {
        score: healthScore,
        status: healthStatus,
        issues: this.identifyHealthIssues(allNodes, aggregatedState)
      },
      geographic: {
        regions: [...new Set(allNodes.map(n => n.region))],
        crossRegionLatency: this.calculateCrossRegionLatency(allNodes),
        regionHealth: this.calculateRegionHealth(allNodes)
      },
      timestamp: Date.now()
    };
  }

  private async generateScalingRecommendations(
    allNodes: NodeCapacity[],
    totalCapacity: NodeCapacity['capacity'],
    totalUtilization: NodeCapacity['utilization'],
    aggregatedState: AggregatedClusterState
  ): Promise<EnhancedClusterTopology['scalingRecommendations']> {
    const actions: ScalingAction[] = [];
    const reasoning: string[] = [];
    let urgency: 'low' | 'medium' | 'high' | 'critical' = 'low';
    let scaleDirection: 'up' | 'down' | 'rebalance' = 'rebalance';
    
    // Check overall utilization
    const overallUtilization = allNodes.length > 0 ? 
      (totalUtilization.cpuUsage / allNodes.length + totalUtilization.memoryUsage / allNodes.length) / 2 : 0;
    
    if (overallUtilization > 0.85) {
      urgency = 'critical';
      scaleDirection = 'up';
      reasoning.push('Cluster utilization above 85% - immediate scaling required');
      actions.push({
        type: 'add-node',
        priority: 1,
        description: 'Add nodes to reduce cluster utilization',
        parameters: { count: Math.ceil(allNodes.length * 0.2) },
        estimatedImpact: {
          capacityChange: 0.2,
          performanceImprovement: 0.3,
          costChange: 0.2
        }
      });
    } else if (overallUtilization > 0.7) {
      urgency = 'high';
      scaleDirection = 'up';
      reasoning.push('Cluster utilization above 70% - scaling recommended');
    }
    
    // Check for room-specific scaling needs
    for (const room of this.roomMetadata.values()) {
      const shardingAnalysis = await this.analyzeRoomSharding(room.roomId);
      if (shardingAnalysis.needsSharding) {
        actions.push({
          type: 'shard-room',
          priority: 2,
          description: `Shard room ${room.roomId} - ${shardingAnalysis.reasoning.join(', ')}`,
          target: room.roomId,
          parameters: {
            shardCount: shardingAnalysis.recommendedShards,
            strategy: shardingAnalysis.shardingStrategy
          },
          estimatedImpact: {
            capacityChange: 0,
            performanceImprovement: 0.4,
            costChange: 0
          }
        });
      }
    }
    
    // Check for underutilized cluster
    if (overallUtilization < 0.3 && allNodes.length > 3) {
      scaleDirection = 'down';
      reasoning.push('Cluster underutilized - consider consolidating resources');
    }
    
    return {
      needsScaling: overallUtilization > 0.7 || actions.length > 0,
      scaleDirection,
      reasoning,
      urgency,
      recommendedActions: actions
    };
  }

  private identifyBottlenecks(nodes: NodeCapacity[]): string[] {
    const bottlenecks: string[] = [];
    
    for (const node of nodes) {
      if (node.utilization.cpuUsage > 0.9) {
        bottlenecks.push(`CPU bottleneck on node ${node.nodeId}`);
      }
      if (node.utilization.memoryUsage > 0.9) {
        bottlenecks.push(`Memory bottleneck on node ${node.nodeId}`);
      }
      if (node.utilization.bandwidthUsage / node.capacity.maxBandwidth > 0.9) {
        bottlenecks.push(`Bandwidth bottleneck on node ${node.nodeId}`);
      }
    }
    
    return bottlenecks;
  }

  private identifyHealthIssues(nodes: NodeCapacity[], aggregatedState: AggregatedClusterState): string[] {
    const issues: string[] = [];
    
    const unhealthyNodes = nodes.filter(n => n.health.status !== 'healthy');
    if (unhealthyNodes.length > 0) {
      issues.push(`${unhealthyNodes.length} nodes are unhealthy`);
    }
    
    if (aggregatedState.partitionInfo.isPartitioned) {
      issues.push('Network partitions detected');
    }
    
    if (aggregatedState.consistencyScore < 0.8) {
      issues.push('Low consistency score - anti-entropy cycles may be needed');
    }
    
    return issues;
  }

  private calculateCrossRegionLatency(nodes: NodeCapacity[]): Record<string, Record<string, number>> {
    const regions = [...new Set(nodes.map(n => n.region))];
    const latencyMap: Record<string, Record<string, number>> = {};
    
    for (const region1 of regions) {
      latencyMap[region1] = {};
      for (const region2 of regions) {
        if (region1 === region2) {
          latencyMap[region1][region2] = 0;
        } else {
          // Calculate average latency between regions
          const region1Nodes = nodes.filter(n => n.region === region1);
          const region2Nodes = nodes.filter(n => n.region === region2);
          
          let totalLatency = 0;
          let count = 0;
          
          for (const node1 of region1Nodes) {
            for (const node2 of region2Nodes) {
              const latency = node1.utilization.networkLatency[node2.nodeId];
              if (latency !== undefined) {
                totalLatency += latency;
                count++;
              }
            }
          }
          
          latencyMap[region1][region2] = count > 0 ? totalLatency / count : 100; // Default 100ms
        }
      }
    }
    
    return latencyMap;
  }

  private calculateRegionHealth(nodes: NodeCapacity[]): Record<string, number> {
    const regionHealth: Record<string, number> = {};
    const regions = [...new Set(nodes.map(n => n.region))];
    
    for (const region of regions) {
      const regionNodes = nodes.filter(n => n.region === region);
      const healthyNodes = regionNodes.filter(n => n.health.status === 'healthy');
      regionHealth[region] = regionNodes.length > 0 ? healthyNodes.length / regionNodes.length : 0;
    }
    
    return regionHealth;
  }

  private async analyzeRoomScaling(roomMetadata: RoomMetadata): Promise<ScalingAction[]> {
    const actions: ScalingAction[] = [];
    
    // Check if sharding is needed
    const shardingAnalysis = await this.analyzeRoomSharding(roomMetadata.roomId);
    if (shardingAnalysis.needsSharding && !roomMetadata.sharding.enabled) {
      actions.push({
        type: 'shard-room',
        priority: 1,
        description: `Enable sharding for room ${roomMetadata.roomId}`,
        target: roomMetadata.roomId,
        parameters: {
          shardCount: shardingAnalysis.recommendedShards,
          strategy: shardingAnalysis.shardingStrategy
        },
        estimatedImpact: {
          capacityChange: 0,
          performanceImprovement: 0.4,
          costChange: 0.1
        }
      });
    }
    
    // Check if HA replication is needed
    if (roomMetadata.participantCount > this.scalingCriteria.crossRegionReplicationThreshold &&
        !roomMetadata.highAvailability.enabled) {
      actions.push({
        type: 'replicate-room',
        priority: 2,
        description: `Enable HA replication for high-traffic room ${roomMetadata.roomId}`,
        target: roomMetadata.roomId,
        parameters: {
          replicationFactor: 2,
          crossRegion: true
        },
        estimatedImpact: {
          capacityChange: -0.1,
          performanceImprovement: 0.2,
          costChange: 0.5
        }
      });
    }
    
    return actions;
  }

  private calculateHADistribution(
    roomMetadata: RoomMetadata,
    availableNodes: NodeCapacity[],
    topology: EnhancedClusterTopology
  ): { primaryNode: string; replicaNodes: string[]; reasoning: string[] } {
    const reasoning: string[] = [];
    const requirements = roomMetadata.highAvailability.requirements;
    
    let candidateNodes = availableNodes.filter(node => {
      // Filter by region if specified
      if (roomMetadata.geographic.allowedRegions) {
        return roomMetadata.geographic.allowedRegions.includes(node.region);
      }
      return true;
    });
    
    // Sort by capacity and health
    candidateNodes.sort((a, b) => {
      const aScore = (1 - a.utilization.cpuUsage) * a.health.availability;
      const bScore = (1 - b.utilization.cpuUsage) * b.health.availability;
      return bScore - aScore;
    });
    
    const primaryNode = candidateNodes[0]?.nodeId || '';
    const replicaNodes: string[] = [];
    
    if (requirements.crossRegion) {
      // Select replicas from different regions
      const primaryRegion = candidateNodes[0]?.region;
      const replicaCandidates = candidateNodes.filter(n => n.region !== primaryRegion);
      
      for (let i = 0; i < roomMetadata.highAvailability.replicationFactor - 1 && i < replicaCandidates.length; i++) {
        replicaNodes.push(replicaCandidates[i].nodeId);
      }
      
      reasoning.push(`Cross-region HA enabled: primary in ${primaryRegion}, replicas in other regions`);
    } else if (requirements.crossZone) {
      // Select replicas from different zones
      const primaryZone = candidateNodes[0]?.zone;
      const replicaCandidates = candidateNodes.filter(n => n.zone !== primaryZone);
      
      for (let i = 0; i < roomMetadata.highAvailability.replicationFactor - 1 && i < replicaCandidates.length; i++) {
        replicaNodes.push(replicaCandidates[i].nodeId);
      }
      
      reasoning.push(`Cross-zone HA enabled: primary in ${primaryZone}, replicas in other zones`);
    } else {
      // Simple replication on different nodes
      for (let i = 1; i < Math.min(roomMetadata.highAvailability.replicationFactor, candidateNodes.length); i++) {
        replicaNodes.push(candidateNodes[i].nodeId);
      }
      
      reasoning.push(`Standard HA replication across ${replicaNodes.length + 1} nodes`);
    }
    
    return { primaryNode, replicaNodes, reasoning };
  }

  private handleNodeJoined(node: NodeInfo): void {
    // Initialize capacity for new node
    if (!this.nodeCapacities.has(node.id)) {
      // This will be handled by initializeNodeCapacities in the next update cycle
      this.updateTopologyAsync();
    }
  }

  private handleNodeLeft(nodeId: string): void {
    this.nodeCapacities.delete(nodeId);
    this.updateTopologyAsync();
  }

  private handleNodeUpdated(node: NodeInfo): void {
    // Update node metadata if capacity exists
    const capacity = this.nodeCapacities.get(node.id);
    if (capacity && node.metadata) {
      capacity.region = node.metadata.region || capacity.region;
      capacity.zone = node.metadata.zone || capacity.zone;
      capacity.role = node.metadata.role || capacity.role;
    }
    this.updateTopologyAsync();
  }
}
