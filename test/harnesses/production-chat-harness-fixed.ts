import { EventEmitter } from 'events';
import { ClusterManager } from '../../src/cluster/ClusterManager';
import { WebSocketAdapter } from '../../src/transport/adapters/WebSocketAdapter';
import { ClientWebSocketAdapter } from '../../src/transport/adapters/ClientWebSocketAdapter';
import { BootstrapConfig } from '../../src/config/BootstrapConfig';
import { ResourceRegistry, ResourceRegistryConfig } from '../../src/cluster/resources/ResourceRegistry';
import { 
  ResourceMetadata, 
  ResourceTypeDefinition, 
  ResourceState, 
  ResourceHealth,
  DistributionStrategy 
} from '../../src/cluster/resources/types';
import { NodeId } from '../../src/types';

/**
 * Chat Room Resource extending ResourceMetadata with chat-specific application data
 */
export interface ChatRoomResource extends ResourceMetadata {
  resourceType: 'chat-room';
  
  // Chat-specific metadata stored in applicationData
  applicationData: {
    roomName: string;
    description?: string;
    maxParticipants: number;
    participantCount: number;
    messageRate: number;
    isPublic: boolean;
    created: number;
    lastActivity: number;
    
    // Production features
    moderation: {
      enabled: boolean;
      moderators: string[];
      autoModeration: boolean;
    };
    
    // Scaling configuration
    scaling: {
      enabled: boolean;
      maxParticipantsPerShard: number;
      autoSharding: boolean;
      shardCount: number;
    };
    
    // Performance tracking
    performanceMetrics: {
      avgLatency: number;
      peakConcurrentUsers: number;
      totalMessages: number;
      bandwidthUsage: number;
    };
  };
}

/**
 * Production Chat Client with enterprise features
 */
export interface ProductionChatClient {
  userId: string;
  nodeIndex: number;
  connection: any;
  connected: boolean;
  joinedRooms: Set<string>;
  receivedMessages: any[];
  
  // Production metrics
  metrics: {
    messagesSent: number;
    messagesReceived: number;
    connectionUptime: number;
    averageLatency: number;
    reconnections: number;
  };
  
  // Advanced features
  features: {
    autoReconnect: boolean;
    messageBuffer: any[];
    heartbeatInterval?: NodeJS.Timeout;
  };
}

/**
 * Production Chat Node with Resource Management
 */
interface ProductionChatNode {
  nodeId: string;
  cluster: ClusterManager;
  clientAdapter: ClientWebSocketAdapter;
  resourceRegistry: ResourceRegistry;
  transport: WebSocketAdapter;
  chatRooms: Map<string, ChatRoomResource>;
  
  // Production monitoring
  metrics: {
    roomsHosted: number;
    totalParticipants: number;
    messagesPerSecond: number;
    resourceUtilization: number;
    uptime: number;
  };
}

/**
 * Production-Scale Chat Harness with Resource Management
 * 
 * This enhanced harness uses the ResourceRegistry to manage chat rooms
 * as distributed resources, providing production-level scaling, monitoring,
 * and fault tolerance capabilities.
 */
export class ProductionChatHarness {
  private nodes: ProductionChatNode[] = [];
  private clients: ProductionChatClient[] = [];
  private chatRoomResourceType!: ResourceTypeDefinition;
  private isRunning = false;

  constructor() {
    this.setupChatRoomResourceType();
  }

  /**
   * Setup the chat room resource type definition
   */
  private setupChatRoomResourceType(): void {
    this.chatRoomResourceType = {
      typeName: 'chat-room',
      version: '1.0.0',
      
      // Capacity planning
      defaultCapacity: {
        totalCapacity: 1000,
        maxThroughput: 100,
        avgLatency: 50
      },
      capacityCalculator: (applicationData: any): number => {
        if (!applicationData) return 0;
        
        // Calculate capacity based on participants and message rate
        const participantWeight = applicationData.participantCount / applicationData.maxParticipants;
        const messageRateWeight = Math.min(applicationData.messageRate / 100, 1);
        
        return Math.max(participantWeight, messageRateWeight) * 100;
      },
      
      // Health and performance
      healthChecker: (resource: ResourceMetadata): ResourceHealth => {
        const chatRoom = resource as ChatRoomResource;
        const utilization = chatRoom.applicationData.participantCount / chatRoom.applicationData.maxParticipants;
        
        if (utilization > 0.9) return ResourceHealth.DEGRADED;
        if (utilization > 0.95) return ResourceHealth.UNHEALTHY;
        return ResourceHealth.HEALTHY;
      },
      performanceMetrics: ['participantCount', 'messageRate', 'avgLatency', 'totalMessages'],
      
      // Distribution preferences
      defaultDistributionStrategy: DistributionStrategy.LEAST_LOADED,
      distributionConstraints: [],
      
      // Resource lifecycle hooks
      onResourceCreated: async (resource: ResourceMetadata) => {
        const chatRoom = resource as ChatRoomResource;
        console.log(`📢 Chat room '${chatRoom.applicationData.roomName}' created on node ${chatRoom.nodeId}`);
        
        // Initialize room-specific monitoring
        this.initializeRoomMonitoring(chatRoom);
      },
      
      onResourceDestroyed: async (resource: ResourceMetadata) => {
        const chatRoom = resource as ChatRoomResource;
        console.log(`🗑️ Chat room '${chatRoom.applicationData.roomName}' destroyed`);
      },
      
      onResourceMigrated: async (resource: ResourceMetadata, fromNode: string, toNode: string) => {
        const chatRoom = resource as ChatRoomResource;
        console.log(`🚚 Chat room '${chatRoom.applicationData.roomName}' migrated from ${fromNode} to ${toNode}`);
      },
      
      // Serialization
      serialize: (resource: ResourceMetadata): any => {
        return {
          ...resource,
          applicationData: resource.applicationData
        };
      },
      
      deserialize: (data: any): ResourceMetadata => {
        return {
          ...data,
          applicationData: data.applicationData
        };
      }
    };
  }

  /**
   * Setup production-scale cluster with resource management
   */
  async setupProductionCluster(nodeCount: number = 4): Promise<ProductionChatNode[]> {
    const clusterPorts = Array.from({ length: nodeCount }, (_, i) => 9300 + i);
    const clientPorts = Array.from({ length: nodeCount }, (_, i) => 8300 + i);

    // Create all nodes with ResourceRegistry
    for (let i = 0; i < nodeCount; i++) {
      const node = await this.createProductionNode(
        `prod-node-${i}`,
        clusterPorts[i],
        clientPorts[i],
        clusterPorts.filter((_, idx) => idx !== i)
      );
      this.nodes.push(node);
    }

    // Start all nodes and their resource registries
    await Promise.all(this.nodes.map(node => this.startProductionNode(node)));
    
    // Wait for cluster formation and resource sync
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    this.isRunning = true;
    console.log(`🚀 Production cluster with ${nodeCount} nodes ready for chat resources`);
    
    return this.nodes;
  }

  /**
   * Create a production chat node with resource management
   */
  private async createProductionNode(
    nodeId: string,
    clusterPort: number,
    clientPort: number,
    seedPorts: number[]
  ): Promise<ProductionChatNode> {
    const nodeIdObj: NodeId = {
      id: nodeId,
      address: '127.0.0.1',
      port: clusterPort
    };

    const seedNodes = seedPorts.map(port => `127.0.0.1:${port}`);

    // Create transport
    const transport = new WebSocketAdapter(nodeIdObj, {
      port: clusterPort,
      host: '127.0.0.1',
      enableLogging: false
    });

    // Create cluster config
    const config = BootstrapConfig.create({
      seedNodes,
      enableLogging: false,
      gossipInterval: 50
    });

    // Create cluster manager
    const cluster = new ClusterManager(nodeId, transport, config);

    // Create client adapter
    const clientAdapter = new ClientWebSocketAdapter({
      port: clientPort,
      host: '127.0.0.1',
      enableLogging: false
    });

    // Create ResourceRegistry with entity backend
    const resourceRegistry = new ResourceRegistry({
      nodeId,
      entityRegistryType: 'memory',
      entityRegistryConfig: { enableTestMode: true }
    });

    // Register the chat room resource type
    resourceRegistry.registerResourceType(this.chatRoomResourceType);

    return {
      nodeId,
      cluster,
      clientAdapter,
      resourceRegistry,
      transport,
      chatRooms: new Map(),
      metrics: {
        roomsHosted: 0,
        totalParticipants: 0,
        messagesPerSecond: 0,
        resourceUtilization: 0,
        uptime: Date.now()
      }
    };
  }

  /**
   * Start a production node
   */
  private async startProductionNode(node: ProductionChatNode): Promise<void> {
    await node.cluster.start();
    await node.clientAdapter.start();
    await node.resourceRegistry.start();
    
    // Setup resource event handlers
    await this.setupResourceEventHandlers(node);
    
    console.log(`✅ Production node ${node.nodeId} started with resource management`);
  }

  /**
   * Create a production-scale chat room using resource management
   */
  async createProductionChatRoom(
    roomName: string,
    options: {
      maxParticipants?: number;
      isPublic?: boolean;
      autoSharding?: boolean;
      moderators?: string[];
      description?: string;
    } = {}
  ): Promise<ChatRoomResource> {
    if (!this.isRunning) {
      throw new Error('Production cluster is not running');
    }

    // Select optimal node for hosting this room
    const hostNode = this.selectOptimalHostNode();
    
    const chatRoomResource: ChatRoomResource = {
      resourceId: `room-${roomName}-${Date.now()}`,
      resourceType: 'chat-room',
      nodeId: hostNode.nodeId,
      state: ResourceState.ACTIVE,
      health: ResourceHealth.HEALTHY,
      capacity: {
        current: 0,
        maximum: options.maxParticipants || 1000,
        unit: 'participants'
      },
      timestamp: Date.now(),
      
      // Required performance metrics
      performance: {
        latency: 0,
        throughput: 0,
        errorRate: 0
      },
      
      // Required distribution metadata
      distribution: {
        shardCount: 1,
        replicationFactor: 1
      },
      
      applicationData: {
        roomName,
        description: options.description || `Production chat room: ${roomName}`,
        maxParticipants: options.maxParticipants || 1000,
        participantCount: 0,
        messageRate: 0,
        isPublic: options.isPublic ?? true,
        created: Date.now(),
        lastActivity: Date.now(),
        
        moderation: {
          enabled: (options.moderators?.length || 0) > 0,
          moderators: options.moderators || [],
          autoModeration: false
        },
        
        scaling: {
          enabled: true,
          maxParticipantsPerShard: 250,
          autoSharding: options.autoSharding ?? true,
          shardCount: 1
        },
        
        performanceMetrics: {
          avgLatency: 0,
          peakConcurrentUsers: 0,
          totalMessages: 0,
          bandwidthUsage: 0
        }
      }
    };

    // Create the resource through the resource registry
    const createdResource = await hostNode.resourceRegistry.createResource(chatRoomResource);
    
    // Cache locally for quick access
    hostNode.chatRooms.set(roomName, createdResource as ChatRoomResource);
    hostNode.metrics.roomsHosted++;
    
    console.log(`🏗️ Production chat room '${roomName}' created on ${hostNode.nodeId} with resource ID: ${createdResource.resourceId}`);
    
    return createdResource as ChatRoomResource;
  }

  /**
   * Create a production chat client with advanced features
   */
  async createProductionChatClient(nodeIndex: number, userId: string): Promise<ProductionChatClient> {
    if (nodeIndex >= this.nodes.length) {
      throw new Error(`Node index ${nodeIndex} is out of range`);
    }

    const node = this.nodes[nodeIndex];
    
    // Create a mock connection for testing
    const connection = { 
      id: `client-${Date.now()}`, 
      connected: true,
      send: (data: string) => console.log(`📤 ${userId}: ${data}`),
      close: () => console.log(`🔌 ${userId} disconnected`),
      on: (event: string, handler: Function) => {
        // Mock event handlers - for tests, execute connection events synchronously
        if (event === 'open') {
          // For testing, immediately mark as connected without async delay
          handler();
        }
      },
      ping: () => console.log(`📡 ${userId} ping`)
    };
    
    const client: ProductionChatClient = {
      userId,
      nodeIndex,
      connection,
      connected: true,
      joinedRooms: new Set(),
      receivedMessages: [],
      
      metrics: {
        messagesSent: 0,
        messagesReceived: 0,
        connectionUptime: Date.now(),
        averageLatency: 0,
        reconnections: 0
      },
      
      features: {
        autoReconnect: true,
        messageBuffer: []
      }
    };

    // Setup advanced client features
    await this.setupProductionClientFeatures(client, node);
    
    this.clients.push(client);
    console.log(`👤 Production client ${userId} created on node ${node.nodeId}`);
    
    return client;
  }

  /**
   * Join a chat room with production features
   */
  async joinProductionChatRoom(client: ProductionChatClient, roomName: string): Promise<void> {
    // Find the room resource across all nodes
    const roomResource = await this.findChatRoomResource(roomName);
    
    if (!roomResource) {
      throw new Error(`Chat room '${roomName}' not found`);
    }

    // Check capacity
    if (roomResource.applicationData.participantCount >= roomResource.applicationData.maxParticipants) {
      // Trigger auto-scaling if enabled
      if (roomResource.applicationData.scaling.autoSharding) {
        await this.triggerRoomSharding(roomResource);
      } else {
        throw new Error(`Chat room '${roomName}' is at capacity`);
      }
    }

    // Join the room
    await this.performRoomJoin(client, roomResource);
    
    // Update room metrics
    await this.updateRoomParticipantCount(roomResource, 1);
    
    console.log(`🚪 Client ${client.userId} joined production room '${roomName}'`);
  }

  /**
   * Send message with production features
   */
  async sendProductionMessage(
    client: ProductionChatClient,
    roomName: string,
    message: string
  ): Promise<void> {
    const roomResource = await this.findChatRoomResource(roomName);
    
    if (!roomResource) {
      throw new Error(`Chat room '${roomName}' not found`);
    }

    // Check if client is in the room
    if (!client.joinedRooms.has(roomName)) {
      throw new Error(`Client ${client.userId} is not in room '${roomName}'`);
    }

    // Apply moderation if enabled
    if (roomResource.applicationData.moderation.enabled) {
      const moderationResult = await this.moderateMessage(message, roomResource);
      if (!moderationResult.approved) {
        console.log(`🚫 Message from ${client.userId} blocked: ${moderationResult.reason}`);
        return;
      }
    }

    // Send the message
    const messageObj = {
      type: 'message',
      roomName,
      userId: client.userId,
      message,
      timestamp: Date.now()
    };

    client.connection.send(JSON.stringify(messageObj));
    client.metrics.messagesSent++;
    
    // Update room metrics
    await this.updateRoomMessageRate(roomResource);
    
    console.log(`💬 ${client.userId} -> ${roomName}: ${message}`);
  }

  /**
   * Cleanup production cluster
   */
  async cleanup(): Promise<void> {
    console.log('🧹 Cleaning up production cluster...');
    
    // Stop all clients
    for (const client of this.clients) {
      if (client.features.heartbeatInterval) {
        clearInterval(client.features.heartbeatInterval);
      }
      if (client.connection) {
        client.connection.close();
      }
    }
    
    // Stop all nodes
    for (const node of this.nodes) {
      await node.resourceRegistry.stop();
      await node.clientAdapter.stop();
      await node.cluster.stop();
    }
    
    this.nodes = [];
    this.clients = [];
    this.isRunning = false;
    
    console.log('✅ Production cluster cleanup complete');
  }

  // Helper methods
  
  private selectOptimalHostNode(): ProductionChatNode {
    // Select node with lowest resource utilization
    return this.nodes.reduce((optimal, current) => {
      return current.metrics.resourceUtilization < optimal.metrics.resourceUtilization
        ? current
        : optimal;
    });
  }

  private async findChatRoomResource(roomName: string): Promise<ChatRoomResource | null> {
    for (const node of this.nodes) {
      const rooms = node.resourceRegistry.getResourcesByType('chat-room') as ChatRoomResource[];
      const room = rooms.find(r => r.applicationData.roomName === roomName);
      if (room) return room;
    }
    return null;
  }

  private async setupResourceEventHandlers(node: ProductionChatNode): Promise<void> {
    node.resourceRegistry.on('resource:created', (resource: ResourceMetadata) => {
      if (resource.resourceType === 'chat-room') {
        console.log(`📢 Resource event: Chat room created on ${node.nodeId}`);
      }
    });

    node.resourceRegistry.on('resource:updated', (resource: ResourceMetadata) => {
      if (resource.resourceType === 'chat-room') {
        console.log(`🔄 Resource event: Chat room updated on ${node.nodeId}`);
      }
    });
  }

  private async setupProductionClientFeatures(client: ProductionChatClient, node: ProductionChatNode): Promise<void> {
    // Setup heartbeat for connection monitoring
    client.features.heartbeatInterval = setInterval(() => {
      if (client.connected) {
        client.connection.ping();
      }
    }, 30000);
    
    // Prevent hanging processes in tests
    client.features.heartbeatInterval?.unref();

    // Setup mock connection handlers
    client.connection.on('open', () => {
      client.connected = true;
      console.log(`🔗 Client ${client.userId} connected to ${node.nodeId}`);
    });

    client.connection.on('close', () => {
      client.connected = false;
      if (client.features.autoReconnect) {
        const reconnectTimer = setTimeout(() => this.reconnectClient(client), 1000);
        // Prevent hanging processes in tests
        reconnectTimer.unref();
      }
    });
  }

  private async reconnectClient(client: ProductionChatClient): Promise<void> {
    console.log(`🔄 Reconnecting client ${client.userId}...`);
    client.metrics.reconnections++;
    // Reconnection logic would go here
  }

  private async performRoomJoin(client: ProductionChatClient, roomResource: ChatRoomResource): Promise<void> {
    const joinMessage = {
      type: 'join',
      roomName: roomResource.applicationData.roomName,
      userId: client.userId,
      timestamp: Date.now()
    };

    client.connection.send(JSON.stringify(joinMessage));
    client.joinedRooms.add(roomResource.applicationData.roomName);
  }

  private async updateRoomParticipantCount(roomResource: ChatRoomResource, delta: number): Promise<void> {
    const hostNode = this.nodes.find(n => n.nodeId === roomResource.nodeId);
    if (!hostNode) return;

    const updatedData = {
      ...roomResource.applicationData,
      participantCount: roomResource.applicationData.participantCount + delta,
      lastActivity: Date.now()
    };

    await hostNode.resourceRegistry.updateResource(roomResource.resourceId, {
      applicationData: updatedData
    });
  }

  private async updateRoomMessageRate(roomResource: ChatRoomResource): Promise<void> {
    const hostNode = this.nodes.find(n => n.nodeId === roomResource.nodeId);
    if (!hostNode) return;

    const updatedData = {
      ...roomResource.applicationData,
      messageRate: roomResource.applicationData.messageRate + 1,
      lastActivity: Date.now(),
      performanceMetrics: {
        ...roomResource.applicationData.performanceMetrics,
        totalMessages: roomResource.applicationData.performanceMetrics.totalMessages + 1
      }
    };

    await hostNode.resourceRegistry.updateResource(roomResource.resourceId, {
      applicationData: updatedData
    });
  }

  private async moderateMessage(message: string, roomResource: ChatRoomResource): Promise<{ approved: boolean; reason?: string }> {
    // Basic moderation
    const blockedWords = ['spam', 'abuse'];
    
    for (const word of blockedWords) {
      if (message.toLowerCase().includes(word)) {
        return { approved: false, reason: `Contains blocked word: ${word}` };
      }
    }
    
    return { approved: true };
  }

  private async triggerRoomSharding(roomResource: ChatRoomResource): Promise<void> {
    console.log(`🔀 Triggering auto-sharding for room '${roomResource.applicationData.roomName}'`);
    
    const newShardCount = roomResource.applicationData.scaling.shardCount + 1;
    
    const updatedData = {
      ...roomResource.applicationData,
      scaling: {
        ...roomResource.applicationData.scaling,
        shardCount: newShardCount
      }
    };

    const hostNode = this.nodes.find(n => n.nodeId === roomResource.nodeId);
    if (hostNode) {
      await hostNode.resourceRegistry.updateResource(roomResource.resourceId, {
        applicationData: updatedData
      });
    }
  }

  private initializeRoomMonitoring(chatRoom: ChatRoomResource): void {
    console.log(`📊 Monitoring initialized for room '${chatRoom.applicationData.roomName}'`);
  }

  private async checkAutoScaling(chatRoom: ChatRoomResource): Promise<void> {
    const utilizationRate = chatRoom.applicationData.participantCount / chatRoom.applicationData.maxParticipants;
    
    if (utilizationRate > 0.8 && chatRoom.applicationData.scaling.autoSharding) {
      console.log(`⚖️ High utilization detected for room '${chatRoom.applicationData.roomName}' (${(utilizationRate * 100).toFixed(1)}%)`);
      await this.triggerRoomSharding(chatRoom);
    }
  }

  // Getters for metrics and status
  getClusterMetrics() {
    return {
      totalNodes: this.nodes.length,
      totalClients: this.clients.length,
      totalRooms: this.nodes.reduce((sum, node) => sum + node.chatRooms.size, 0),
      totalParticipants: this.nodes.reduce((sum, node) => sum + node.metrics.totalParticipants, 0),
      averageResourceUtilization: this.nodes.reduce((sum, node) => sum + node.metrics.resourceUtilization, 0) / this.nodes.length
    };
  }

  async getClusterResourceOverview() {
    const metrics = this.getClusterMetrics();
    const resourceStats = await Promise.all(
      this.nodes.map(async (node) => {
        const resources = node.resourceRegistry.getResourcesByType('chat-room');
        return {
          nodeId: node.nodeId,
          resources: resources.length,
          participants: node.metrics.totalParticipants,
          utilization: node.metrics.resourceUtilization,
          shards: Array.from(node.chatRooms.values()).filter(room => room.applicationData.scaling?.autoSharding).length
        };
      })
    );

    // Calculate resource distribution and health
    const resourceDistribution = new Map<string, number>();
    let healthyResources = 0;
    let totalResources = 0;

    for (const nodeStat of resourceStats) {
      resourceDistribution.set(nodeStat.nodeId, nodeStat.resources);
      totalResources += nodeStat.resources;
      // For now, assume all resources are healthy if utilization < 90%
      if (nodeStat.utilization < 0.9) {
        healthyResources += nodeStat.resources;
      }
    }

    return {
      // Legacy chat metrics (maintain backward compatibility)
      ...metrics,
      nodes: resourceStats,
      timestamp: Date.now(),
      
      // New resource-centric API (align with ProductionScaleResourceManager)
      totalResources,
      healthyResources,
      unhealthyResources: totalResources - healthyResources,
      resourceDistribution,
      resourcesByType: new Map([['chat-room', totalResources]]),
      resourcesByNode: resourceDistribution
    };
  }
}
