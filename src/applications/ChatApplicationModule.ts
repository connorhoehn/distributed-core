import { ApplicationModule } from './ApplicationModule';
import { 
  ApplicationModuleConfig, 
  ApplicationModuleMetrics, 
  ApplicationModuleContext,
  ApplicationModuleDashboardData,
  ModuleState,
  ScalingStrategy 
} from './types';
import { 
  ResourceMetadata, 
  ResourceTypeDefinition, 
  ResourceState, 
  ResourceHealth,
  DistributionStrategy 
} from '../cluster/resources/types';
import { ChatTopologyManager, RoomMetadata } from './chat/ChatTopologyManager';
import { ChatRoomCoordinator } from './chat/ChatRoomCoordinator';

/**
 * Chat Room Resource extending ResourceMetadata with chat-specific application data
 */
export interface ChatRoomResource extends ResourceMetadata {
  resourceType: 'chat-room';
  applicationData: {
    roomName: string;
    description?: string;
    maxParticipants: number;
    participantCount: number;
    messageRate: number;
    isPublic: boolean;
    created: number;
    lastActivity: number;
  };
}

/**
 * Chat Application Module Configuration
 */
export interface ChatApplicationConfig extends ApplicationModuleConfig {
  maxRoomsPerNode: number;
  maxClientsPerRoom: number;
  messageRetentionDays: number;
  autoScaling: {
    enabled: boolean;
    scaleUpThreshold: number;
    scaleDownThreshold: number;
    maxShards: number;
  };
  moderation: {
    enableAutoModeration: boolean;
    bannedWords: string[];
    maxMessageLength: number;
    rateLimitPerMinute: number;
  };
}

/**
 * Chat Application Module Metrics
 */
export interface ChatApplicationMetrics extends ApplicationModuleMetrics {
  totalRooms: number;
  activeRooms: number;
  messagesPerSecond: number;
  averageRoomSize: number;
  roomResourceUtilization: number;
}

/**
 * Chat Application Module
 * 
 * A simplified implementation demonstrating the application module pattern
 * for chat functionality in the distributed cluster system.
 */
export class ChatApplicationModule extends ApplicationModule {
  private rooms = new Map<string, ChatRoomResource>();
  private chatConfig: ChatApplicationConfig;
  private messageHistory = new Map<string, any[]>();
  private chatTopologyManager?: ChatTopologyManager;
  private chatRoomCoordinator?: ChatRoomCoordinator;

  constructor(config: ChatApplicationConfig) {
    super(config);
    this.chatConfig = config;
  }

  /**
   * Initialize the chat application module
   */
  protected async onInitialize(context: ApplicationModuleContext): Promise<void> {
    this.log('info', 'Initializing Chat Application Module');
    this.log('info', 'Chat Application Module initialized successfully');
  }

  /**
   * Start the chat application module
   */
  protected async onStart(): Promise<void> {
    this.log('info', 'Starting Chat Application Module');
    
    // Note: ChatTopologyManager requires additional dependencies not available in context
    // This would need to be initialized by the ApplicationRegistry with full cluster context
    this.log('info', 'Chat-specific topology management will be handled at cluster level');
    
    this.log('info', 'Chat Application Module started successfully');
  }

  /**
   * Stop the chat application module
   */
  protected async onStop(): Promise<void> {
    this.log('info', 'Stopping Chat Application Module');
    this.rooms.clear();
    this.messageHistory.clear();
    this.log('info', 'Chat Application Module stopped successfully');
  }

  /**
   * Handle configuration updates
   */
  protected async onConfigurationUpdate(newConfig: ApplicationModuleConfig): Promise<void> {
    this.chatConfig = newConfig as ChatApplicationConfig;
    this.log('info', 'Chat configuration updated');
  }

  /**
   * Get resource type definitions
   */
  protected getResourceTypeDefinitions(): ResourceTypeDefinition[] {
    return [
      {
        typeName: 'chat-room',
        version: '1.0.0',
        defaultCapacity: {
          totalCapacity: this.chatConfig.maxRoomsPerNode,
          availableCapacity: this.chatConfig.maxRoomsPerNode,
          reservedCapacity: 0
        },
        capacityCalculator: (metadata: any) => metadata.applicationData?.participantCount || 0,
        healthChecker: (resource: ResourceMetadata) => ResourceHealth.HEALTHY,
        performanceMetrics: ['latency', 'throughput', 'errorRate'],
        defaultDistributionStrategy: DistributionStrategy.LEAST_LOADED,
        distributionConstraints: [],
        serialize: (resource: ResourceMetadata) => JSON.stringify(resource),
        deserialize: (data: any) => JSON.parse(data)
      }
    ];
  }

  /**
   * Create a chat room resource
   */
  async createResource(resourceData: Partial<ChatRoomResource>): Promise<ChatRoomResource> {
    const roomName = resourceData.applicationData?.roomName;
    if (!roomName) {
      throw new Error('Room name is required for chat room creation');
    }

    const roomId = `room-${roomName}-${Date.now()}`;
    const room: ChatRoomResource = {
      resourceId: roomId,
      resourceType: 'chat-room',
      nodeId: 'current-node', // Simplified - would get from context
      timestamp: Date.now(),
      capacity: {
        current: 0,
        maximum: this.chatConfig.maxClientsPerRoom,
        unit: 'participants'
      },
      performance: {
        latency: 0,
        throughput: 0,
        errorRate: 0
      },
      distribution: {
        shardCount: 1,
        replicationFactor: 1
      },
      applicationData: {
        roomName,
        description: resourceData.applicationData?.description || `Chat room: ${roomName}`,
        maxParticipants: this.chatConfig.maxClientsPerRoom,
        participantCount: 0,
        messageRate: 0,
        isPublic: resourceData.applicationData?.isPublic ?? true,
        created: Date.now(),
        lastActivity: Date.now()
      },
      state: ResourceState.ACTIVE,
      health: ResourceHealth.HEALTHY
    };

    // Store the room locally
    this.rooms.set(roomId, room);
    this.messageHistory.set(roomId, []);

    // Register with resource registry if available
    if (this.context?.resourceRegistry) {
      try {
        await this.context.resourceRegistry.createResource(room);
      } catch (error) {
        this.log('error', `Failed to register room with resource registry: ${error}`);
        // Clean up local storage on registry failure
        this.rooms.delete(roomId);
        this.messageHistory.delete(roomId);
        throw error;
      }
    }

    this.log('info', `Chat room '${roomName}' created with ID: ${roomId}`);
    this.emit('room-created', room);

    return room;
  }

  /**
   * Scale a resource using the provided strategy
   */
  async scaleResource(resourceId: string, strategy: ScalingStrategy): Promise<void> {
    const room = this.rooms.get(resourceId);
    if (!room) {
      throw new Error(`Chat room not found: ${resourceId}`);
    }

    this.log('info', `Scaling resource ${resourceId} with strategy: ${strategy.type}`);
    this.emit('resource-scaled', { resourceId, strategy });
  }

  /**
   * Delete a chat resource
   */
  async deleteResource(resourceId: string): Promise<void> {
    const room = this.rooms.get(resourceId);
    if (!room) {
      throw new Error(`Chat room not found: ${resourceId}`);
    }

    // Remove from resource registry if available
    if (this.context?.resourceRegistry) {
      try {
        await this.context.resourceRegistry.removeResource(resourceId);
      } catch (error) {
        this.log('error', `Failed to remove room from resource registry: ${error}`);
        // Continue with local cleanup even if registry fails
      }
    }

    this.rooms.delete(resourceId);
    this.messageHistory.delete(resourceId);

    this.log('info', `Chat room deleted: ${resourceId}`);
    this.emit('room-deleted', { resourceId, room });
  }

  /**
   * Get application metrics
   */
  async getMetrics(): Promise<ChatApplicationMetrics> {
    const rooms = Array.from(this.rooms.values());
    const activeRooms = rooms.filter(room => room.state === ResourceState.ACTIVE);
    
    return {
      moduleId: this.config.moduleId,
      timestamp: Date.now(),
      state: this.state,
      resourceCounts: {
        'chat-room': rooms.length
      },
      performance: {
        requestsPerSecond: this.calculateMessagesPerSecond(),
        averageLatency: 50, // Mock value
        errorRate: 0.01,
        uptime: Date.now() - 1000000 // Mock value
      },
      totalRooms: rooms.length,
      activeRooms: activeRooms.length,
      messagesPerSecond: this.calculateMessagesPerSecond(),
      averageRoomSize: rooms.reduce((sum, room) => sum + room.applicationData.participantCount, 0) / Math.max(activeRooms.length, 1),
      roomResourceUtilization: activeRooms.length / this.chatConfig.maxRoomsPerNode
    };
  }

  /**
   * Get dashboard data for visualization
   */
  async getDashboardData(): Promise<ApplicationModuleDashboardData> {
    const metrics = await this.getMetrics();
    
    return {
      moduleId: this.config.moduleId,
      moduleName: this.config.moduleName,
      state: this.state,
      summary: {
        totalResources: metrics.totalRooms,
        healthyResources: metrics.activeRooms,
        activeConnections: 0, // Simplified
        throughput: metrics.messagesPerSecond
      },
      charts: [
        {
          title: 'Message Rate',
          type: 'line',
          data: { rate: metrics.messagesPerSecond }
        },
        {
          title: 'Room Distribution',
          type: 'bar',
          data: { active: metrics.activeRooms, total: metrics.totalRooms }
        }
      ]
    };
  }

  /**
   * Create a chat room (public API)
   */
  async createRoom(roomName: string, isPublic: boolean = true): Promise<ChatRoomResource> {
    return this.createResource({
      applicationData: {
        roomName,
        isPublic,
        maxParticipants: this.chatConfig.maxClientsPerRoom,
        participantCount: 0,
        messageRate: 0,
        created: Date.now(),
        lastActivity: Date.now()
      }
    });
  }

  /**
   * Send a message to a room
   */
  async sendMessage(roomId: string, userId: string, message: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error(`Room not found: ${roomId}`);
    }

    // Apply moderation if enabled
    if (this.chatConfig.moderation.enableAutoModeration) {
      if (this.isMessageBlocked(message)) {
        throw new Error('Message blocked by moderation');
      }
    }

    // Store message
    const messageData = {
      id: `msg-${Date.now()}-${Math.random()}`,
      roomId,
      userId,
      message,
      timestamp: Date.now()
    };

    const roomHistory = this.messageHistory.get(roomId) || [];
    roomHistory.push(messageData);
    this.messageHistory.set(roomId, roomHistory);

    // Update room activity
    room.applicationData.lastActivity = Date.now();
    room.applicationData.messageRate++;

    this.emit('message-sent', messageData);
  }

  /**
   * Calculate messages per second
   */
  private calculateMessagesPerSecond(): number {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    let recentMessages = 0;
    for (const history of this.messageHistory.values()) {
      recentMessages += history.filter(msg => msg.timestamp > oneSecondAgo).length;
    }
    
    return recentMessages;
  }

  /**
   * Check if a message should be blocked by moderation
   */
  private isMessageBlocked(message: string): boolean {
    const lowerMessage = message.toLowerCase();
    return this.chatConfig.moderation.bannedWords.some(word => 
      lowerMessage.includes(word.toLowerCase())
    );
  }
}
