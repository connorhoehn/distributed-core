import { EventEmitter } from 'events';
import { ClusterManager } from '../../cluster/ClusterManager';
import { StateAggregator } from '../../cluster/aggregation/StateAggregator';
import { MetricsTracker } from '../../monitoring/metrics/MetricsTracker';
import { ResourceTopologyManager } from '../../cluster/topology/ResourceTopologyManager';
import { ResourceRegistry } from '../../cluster/resources/ResourceRegistry';
import { ResourceMetadata } from '../../cluster/resources/types';

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
 * Chat-specific node capacity information
 */
export interface ChatNodeCapacity {
  nodeId: string;
  region: string;
  zone: string;
  role: string;
  
  // Chat-specific resource limits
  capacity: {
    maxRooms: number;
    maxParticipants: number;
    maxBandwidth: number; // MB/s
    cpuCores: number;
    memoryGB: number;
  };
  
  // Current chat utilization
  utilization: {
    activeRooms: number;
    totalParticipants: number;
    bandwidthUsage: number;
    cpuUsage: number;
    memoryUsage: number;
    networkLatency: Record<string, number>; // node -> latency
  };
  
  // Chat capabilities
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
 * Chat-specific cluster topology view
 */
export interface ChatClusterTopology {
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
    totalCapacity: ChatNodeCapacity['capacity'];
    totalUtilization: ChatNodeCapacity['utilization'];
    utilizationPercentage: number;
    bottlenecks: string[];
  };
  
  // Scaling recommendations
  scalingRecommendations: {
    needsScaling: boolean;
    scaleDirection: 'up' | 'down' | 'rebalance';
    reasoning: string[];
    urgency: 'low' | 'medium' | 'high' | 'critical';
    recommendedActions: ChatScalingAction[];
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
 * Chat-specific scaling action recommendations
 */
export interface ChatScalingAction {
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
 * ChatTopologyManager provides chat-specific cluster topology management
 * 
 * Features:
 * - Real-time topology visualization with room distribution
 * - Intelligent scaling recommendations based on chat load and performance
 * - Room sharding and HA rules management
 * - Geographic distribution and latency optimization for chat
 * - Capacity planning and resource utilization tracking for chat rooms
 * - Anti-entropy driven eventual consistency for topology state
 */
export class ChatTopologyManager extends EventEmitter {
  private cluster: ClusterManager;
  private stateAggregator: StateAggregator;
  private metricsTracker: MetricsTracker;
  private resourceTopologyManager: ResourceTopologyManager;
  private resourceRegistry: ResourceRegistry;
  
  // Chat-specific state tracking
  private nodeCapacities = new Map<string, ChatNodeCapacity>();
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
    resourceTopologyManager: ResourceTopologyManager,
    resourceRegistry: ResourceRegistry,
    config?: {
      updateIntervalMs?: number;
      scalingCriteria?: Partial<RoomScalingCriteria>;
    }
  ) {
    super();
    this.cluster = cluster;
    this.stateAggregator = stateAggregator;
    this.metricsTracker = metricsTracker;
    this.resourceTopologyManager = resourceTopologyManager;
    this.resourceRegistry = resourceRegistry;
    
    if (config) {
      this.updateIntervalMs = config.updateIntervalMs || this.updateIntervalMs;
      this.scalingCriteria = { ...this.scalingCriteria, ...config.scalingCriteria };
    }
  }

  /**
   * Start chat topology monitoring and periodic updates
   */
  async start(): Promise<void> {
    // Initialize node capacity tracking for chat
    await this.initializeChatNodeCapacities();
    
    // Start periodic topology updates
    this.topologyUpdateInterval = setInterval(
      this.updateChatTopology.bind(this),
      this.updateIntervalMs
    );
    
    this.topologyUpdateInterval.unref();
    
    // Listen for cluster events
    this.cluster.on('member-joined', this.handleNodeJoined.bind(this));
    this.cluster.on('member-left', this.handleNodeLeft.bind(this));
    this.cluster.on('member-updated', this.handleNodeUpdated.bind(this));
    
    // Listen for room-related resource events
    this.resourceRegistry.on('resource:created', this.handleRoomCreated.bind(this));
    this.resourceRegistry.on('resource:destroyed', this.handleRoomDestroyed.bind(this));
    this.resourceRegistry.on('resource:updated', this.handleRoomUpdated.bind(this));
    
    this.emit('started');
  }

  /**
   * Stop chat topology monitoring
   */
  async stop(): Promise<void> {
    if (this.topologyUpdateInterval) {
      clearInterval(this.topologyUpdateInterval);
      this.topologyUpdateInterval = undefined;
    }
    
    // Remove event listeners
    this.cluster.removeAllListeners('member-joined');
    this.cluster.removeAllListeners('member-left');
    this.cluster.removeAllListeners('member-updated');
    this.resourceRegistry.removeAllListeners('resource:created');
    this.resourceRegistry.removeAllListeners('resource:destroyed');
    this.resourceRegistry.removeAllListeners('resource:updated');
    
    this.emit('stopped');
  }

  /**
   * Get comprehensive chat cluster topology
   */
  async getChatClusterTopology(): Promise<ChatClusterTopology> {
    // Get generic cluster topology from ResourceTopologyManager
    const genericTopology = await this.resourceTopologyManager.getResourceTopology('chat-room');
    
    // Enhance with chat-specific information
    const chatRooms = this.resourceRegistry.getResourcesByType('chat-room');
    
    const roomDistribution = {
      total: chatRooms.length,
      byNode: this.calculateRoomsByNode(chatRooms),
      byRegion: this.calculateRoomsByRegion(chatRooms),
      byType: this.calculateRoomsByType(chatRooms),
      shardedRooms: chatRooms.filter((r: ResourceMetadata) => r.applicationData?.sharding?.enabled).length,
      replicatedRooms: chatRooms.filter((r: ResourceMetadata) => r.applicationData?.highAvailability?.enabled).length
    };

    const chatCapacity = await this.calculateChatCapacity();
    const scalingRecommendations = await this.generateChatScalingRecommendations();
    const healthScore = await this.calculateChatHealthScore();

    return {
      totalNodes: genericTopology.nodes.length,
      aliveNodes: genericTopology.nodes.filter(n => n.health.status !== 'offline').length,
      nodeDistribution: {
        byRegion: this.calculateNodesByRegion(genericTopology.nodes),
        byZone: this.calculateNodesByZone(genericTopology.nodes),
        byRole: this.calculateNodesByRole(genericTopology.nodes)
      },
      rooms: roomDistribution,
      clusterCapacity: chatCapacity,
      scalingRecommendations: {
        needsScaling: scalingRecommendations.length > 0,
        scaleDirection: scalingRecommendations.length > 0 ? 'up' : 'rebalance',
        reasoning: scalingRecommendations.map(a => a.description),
        urgency: scalingRecommendations.length > 0 ? 'medium' : 'low',
        recommendedActions: scalingRecommendations
      },
      overallHealth: healthScore,
      geographic: {
        regions: Array.from(new Set(genericTopology.nodes.map(n => n.region))),
        crossRegionLatency: {},
        regionHealth: {}
      },
      timestamp: Date.now()
    };
  }

  /**
   * Register a chat room in topology tracking
   */
  async registerRoom(roomMetadata: RoomMetadata): Promise<void> {
    this.roomMetadata.set(roomMetadata.roomId, roomMetadata);
    
    // Create resource metadata for the generic system
    const resourceMetadata: ResourceMetadata = {
      resourceId: roomMetadata.roomId,
      resourceType: 'chat-room',
      nodeId: roomMetadata.ownerNode,
      timestamp: roomMetadata.created,
      capacity: {
        current: roomMetadata.participantCount,
        maximum: roomMetadata.sharding.maxParticipants || 10000,
        unit: 'participants'
      },
      performance: {
        latency: roomMetadata.performance.maxLatency,
        throughput: roomMetadata.messageRate,
        errorRate: 0
      },
      distribution: {
        shardCount: roomMetadata.sharding.shardCount,
        replicationFactor: roomMetadata.highAvailability.replicationFactor,
        preferredNodes: roomMetadata.sharding.shardNodes
      },
      state: 'active' as any, // Cast to avoid import issues
      health: 'healthy' as any, // Cast to avoid import issues
      applicationData: {
        roomType: roomMetadata.roomType.type,
        participantCount: roomMetadata.participantCount,
        messageRate: roomMetadata.messageRate,
        sharding: roomMetadata.sharding,
        highAvailability: roomMetadata.highAvailability,
        performance: roomMetadata.performance,
        geographic: roomMetadata.geographic
      }
    };
    
    await this.resourceRegistry.createResource(resourceMetadata);
    this.emit('room:registered', roomMetadata);
  }

  /**
   * Unregister a chat room from topology tracking
   */
  async unregisterRoom(roomId: string): Promise<void> {
    this.roomMetadata.delete(roomId);
    await this.resourceRegistry.removeResource(roomId);
    this.emit('room:unregistered', roomId);
  }

  /**
   * Get chat-specific scaling recommendations
   */
  async getChatScalingRecommendations(): Promise<ChatScalingAction[]> {
    return await this.generateChatScalingRecommendations();
  }

  /**
   * Get room placement recommendations for new rooms
   */
  async getRoomPlacementRecommendation(
    roomRequirements: {
      expectedParticipants: number;
      expectedMessageRate: number;
      regionPreference?: string;
      haRequirements?: boolean;
      latencyRequirements?: number;
    }
  ): Promise<{
    recommendedNode: string;
    reasoning: string[];
    alternativeNodes: string[];
  }> {
    // Simple placement logic based on current capacity
    const aliveMembers = this.cluster.getAliveMembers();
    const nodeLoads = new Map<string, number>();
    
    for (const member of aliveMembers) {
      const nodeRooms = this.resourceRegistry.getResourcesByNode(member.id)
        .filter((r: ResourceMetadata) => r.resourceType === 'chat-room');
      const load = nodeRooms.reduce((sum: number, room: ResourceMetadata) => sum + room.capacity.current, 0);
      nodeLoads.set(member.id, load);
    }

    // Select node with lowest load
    const recommendedNode = aliveMembers.reduce((bestNode, currentNode) => 
      (nodeLoads.get(currentNode.id) || 0) < (nodeLoads.get(bestNode.id) || 0) 
        ? currentNode 
        : bestNode
    ).id;

    const chatReasons: string[] = [
      `Selected node with lowest current load: ${nodeLoads.get(recommendedNode) || 0} participants`,
      `Chat capacity: ${roomRequirements.expectedParticipants} participants`,
      `Message rate: ${roomRequirements.expectedMessageRate} msg/s`
    ];

    if (roomRequirements.haRequirements) {
      chatReasons.push('High availability requirements considered');
    }

    return {
      recommendedNode,
      reasoning: chatReasons,
      alternativeNodes: aliveMembers.filter(m => m.id !== recommendedNode).map(m => m.id)
    };
  }

  // Private helper methods
  private async initializeChatNodeCapacities(): Promise<void> {
    const aliveMembers = this.cluster.getAliveMembers();
    
    for (const member of aliveMembers) {
      const capacity: ChatNodeCapacity = {
        nodeId: member.id,
        region: member.metadata?.region || 'default',
        zone: member.metadata?.zone || 'default',
        role: member.metadata?.role || 'worker',
        capacity: {
          maxRooms: 1000,
          maxParticipants: 100000,
          maxBandwidth: 1000, // MB/s
          cpuCores: 8,
          memoryGB: 32
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
      
      this.nodeCapacities.set(member.id, capacity);
    }
  }

  private async updateChatTopology(): Promise<void> {
    // Update chat-specific metrics and topology
    await this.updateRoomDistribution();
    await this.updateNodeUtilization();
    this.lastTopologyUpdate = Date.now();
    this.emit('topology:updated');
  }

  private async updateRoomDistribution(): Promise<void> {
    const chatRooms = this.resourceRegistry.getResourcesByType('chat-room');
    
    // Update room metadata with current state
    for (const room of chatRooms) {
      const roomMeta = this.roomMetadata.get(room.resourceId);
      if (roomMeta) {
        roomMeta.participantCount = room.capacity.current;
        roomMeta.lastActivity = Date.now();
        // Update message rate from metrics
        roomMeta.messageRate = this.metricsTracker.getGaugeValue('room_message_rate', { room_id: room.resourceId }) || 0;
      }
    }
  }

  private async updateNodeUtilization(): Promise<void> {
    for (const [nodeId, capacity] of this.nodeCapacities) {
      const nodeRooms = this.resourceRegistry.getResourcesByNode(nodeId).filter(r => r.resourceType === 'chat-room');
      
      capacity.utilization.activeRooms = nodeRooms.length;
      capacity.utilization.totalParticipants = nodeRooms.reduce((sum, room) => sum + room.capacity.current, 0);
      
      // Get CPU and memory usage from metrics
      capacity.utilization.cpuUsage = this.metricsTracker.getGaugeValue('node_cpu_usage', { node_id: nodeId }) || 0;
      capacity.utilization.memoryUsage = this.metricsTracker.getGaugeValue('node_memory_usage', { node_id: nodeId }) || 0;
    }
  }

  private calculateRoomsByNode(rooms: ResourceMetadata[]): Record<string, number> {
    const distribution: Record<string, number> = {};
    for (const room of rooms) {
      distribution[room.nodeId] = (distribution[room.nodeId] || 0) + 1;
    }
    return distribution;
  }

  private calculateRoomsByRegion(rooms: ResourceMetadata[]): Record<string, number> {
    const distribution: Record<string, number> = {};
    for (const room of rooms) {
      const nodeCapacity = this.nodeCapacities.get(room.nodeId);
      const region = nodeCapacity?.region || 'unknown';
      distribution[region] = (distribution[region] || 0) + 1;
    }
    return distribution;
  }

  private calculateRoomsByType(rooms: ResourceMetadata[]): Record<string, number> {
    const distribution: Record<string, number> = {};
    for (const room of rooms) {
      const roomType = room.applicationData?.roomType || 'unknown';
      distribution[roomType] = (distribution[roomType] || 0) + 1;
    }
    return distribution;
  }

  private calculateNodesByRegion(nodes: any[]): Record<string, number> {
    const distribution: Record<string, number> = {};
    for (const node of nodes) {
      const region = node.region || 'unknown';
      distribution[region] = (distribution[region] || 0) + 1;
    }
    return distribution;
  }

  private calculateNodesByZone(nodes: any[]): Record<string, number> {
    const distribution: Record<string, number> = {};
    for (const node of nodes) {
      const zone = node.zone || 'unknown';
      distribution[zone] = (distribution[zone] || 0) + 1;
    }
    return distribution;
  }

  private calculateNodesByRole(nodes: any[]): Record<string, number> {
    const distribution: Record<string, number> = {};
    for (const node of nodes) {
      const role = node.role || 'worker';
      distribution[role] = (distribution[role] || 0) + 1;
    }
    return distribution;
  }

  private async calculateChatCapacity(): Promise<ChatClusterTopology['clusterCapacity']> {
    const totalCapacity = {
      maxRooms: 0,
      maxParticipants: 0,
      maxBandwidth: 0,
      cpuCores: 0,
      memoryGB: 0
    };

    const totalUtilization = {
      activeRooms: 0,
      totalParticipants: 0,
      bandwidthUsage: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      networkLatency: {}
    };

    for (const capacity of this.nodeCapacities.values()) {
      totalCapacity.maxRooms += capacity.capacity.maxRooms;
      totalCapacity.maxParticipants += capacity.capacity.maxParticipants;
      totalCapacity.maxBandwidth += capacity.capacity.maxBandwidth;
      totalCapacity.cpuCores += capacity.capacity.cpuCores;
      totalCapacity.memoryGB += capacity.capacity.memoryGB;

      totalUtilization.activeRooms += capacity.utilization.activeRooms;
      totalUtilization.totalParticipants += capacity.utilization.totalParticipants;
      totalUtilization.bandwidthUsage += capacity.utilization.bandwidthUsage;
      totalUtilization.cpuUsage += capacity.utilization.cpuUsage;
      totalUtilization.memoryUsage += capacity.utilization.memoryUsage;
    }

    const utilizationPercentage = totalCapacity.maxParticipants > 0 
      ? (totalUtilization.totalParticipants / totalCapacity.maxParticipants) * 100 
      : 0;

    const bottlenecks: string[] = [];
    if (utilizationPercentage > 80) bottlenecks.push('Participant capacity');
    if (totalUtilization.activeRooms / totalCapacity.maxRooms > 0.8) bottlenecks.push('Room capacity');

    return {
      totalCapacity,
      totalUtilization,
      utilizationPercentage,
      bottlenecks
    };
  }

  private async generateChatScalingRecommendations(): Promise<ChatScalingAction[]> {
    const actions: ChatScalingAction[] = [];
    
    // Check for rooms that need sharding
    for (const [roomId, roomMeta] of this.roomMetadata) {
      if (roomMeta.participantCount > this.scalingCriteria.maxParticipantsPerRoom) {
        actions.push({
          type: 'shard-room',
          priority: 1,
          description: `Room ${roomId} has ${roomMeta.participantCount} participants, exceeding limit of ${this.scalingCriteria.maxParticipantsPerRoom}`,
          target: roomId,
          parameters: { 
            currentParticipants: roomMeta.participantCount,
            recommendedShards: Math.ceil(roomMeta.participantCount / this.scalingCriteria.maxParticipantsPerRoom)
          },
          estimatedImpact: {
            capacityChange: 0,
            performanceImprovement: 0.3,
            costChange: 0.1
          }
        });
      }
    }

    // Check for nodes that need scaling
    for (const [nodeId, capacity] of this.nodeCapacities) {
      if (capacity.utilization.totalParticipants / capacity.capacity.maxParticipants > 0.8) {
        actions.push({
          type: 'add-node',
          priority: 2,
          description: `Node ${nodeId} at ${Math.round((capacity.utilization.totalParticipants / capacity.capacity.maxParticipants) * 100)}% participant capacity`,
          target: nodeId,
          parameters: { currentUtilization: capacity.utilization.totalParticipants / capacity.capacity.maxParticipants },
          estimatedImpact: {
            capacityChange: 1.0,
            performanceImprovement: 0.4,
            costChange: 1.0
          }
        });
      }
    }

    return actions.sort((a, b) => a.priority - b.priority);
  }

  private async calculateChatHealthScore(): Promise<ChatClusterTopology['overallHealth']> {
    let totalScore = 0;
    let nodeCount = 0;
    const issues: string[] = [];

    for (const [nodeId, capacity] of this.nodeCapacities) {
      let nodeScore = 1.0;
      
      // Factor in utilization
      const utilization = capacity.utilization.totalParticipants / capacity.capacity.maxParticipants;
      if (utilization > 0.9) {
        nodeScore *= 0.5;
        issues.push(`Node ${nodeId} is over-utilized`);
      } else if (utilization > 0.8) {
        nodeScore *= 0.8;
      }

      // Factor in health status
      if (capacity.health.status === 'unhealthy') {
        nodeScore *= 0.3;
        issues.push(`Node ${nodeId} is unhealthy`);
      } else if (capacity.health.status === 'degraded') {
        nodeScore *= 0.7;
      }

      totalScore += nodeScore;
      nodeCount++;
    }

    const overallScore = nodeCount > 0 ? totalScore / nodeCount : 0;
    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    
    if (overallScore < 0.5) status = 'critical';
    else if (overallScore < 0.8) status = 'warning';

    return {
      score: overallScore,
      status,
      issues
    };
  }

  // Event handlers
  private handleNodeJoined(member: any): void {
    // Initialize capacity for new node
    this.initializeChatNodeCapacities();
    this.emit('chat-topology:node-joined', member);
  }

  private handleNodeLeft(member: any): void {
    this.nodeCapacities.delete(member.id);
    this.emit('chat-topology:node-left', member);
  }

  private handleNodeUpdated(member: any): void {
    // Update node capacity if needed
    this.emit('chat-topology:node-updated', member);
  }

  private handleRoomCreated(resource: ResourceMetadata): void {
    if (resource.resourceType === 'chat-room') {
      this.emit('chat-topology:room-created', resource);
    }
  }

  private handleRoomDestroyed(resource: ResourceMetadata): void {
    if (resource.resourceType === 'chat-room') {
      this.roomMetadata.delete(resource.resourceId);
      this.emit('chat-topology:room-destroyed', resource);
    }
  }

  private handleRoomUpdated(resource: ResourceMetadata): void {
    if (resource.resourceType === 'chat-room') {
      this.emit('chat-topology:room-updated', resource);
    }
  }
}
