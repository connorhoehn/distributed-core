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
} from '../resources';

// import { ChatTopologyManager, RoomMetadata } from './chat/ChatTopologyManager';
// Removed due to missing module or type declarations.

import { ChatRoomCoordinator } from '../messaging/handlers/ChatRoomCoordinator';

// Stub for ChatTopologyManager
export class ChatTopologyManager {
  async recommendResourcePlacement(options: any): Promise<{ recommendedPlacement: { primaryNode: string } }> {
    // Return a mock recommendation
    return { recommendedPlacement: { primaryNode: 'current-node' } };
  }
}

/**
 * Chat Room Resource extending ResourceMetadata with chat-specific application data
 */
export interface ChatRoomResource extends ResourceMetadata {
  resourceId: string;
  resourceType: 'chat-room';
  nodeId: string;
  timestamp: number;
  capacity: {
    current: number;
    maximum: number;
    reserved: number;
    unit: string;
  };
  performance: {
    latency: number;
    throughput: number;
    errorRate: number;
  };
  distribution: {
    shardCount: number;
  };
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
  state: ResourceState;
  health: ResourceHealth;
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
  private syncInterval?: NodeJS.Timeout;

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
    
    // Start periodic room state synchronization
    this.startPeriodicSync();
    
    this.log('info', 'Chat Application Module started successfully');
  }

  /**
   * Stop the chat application module
   */
  protected async onStop(): Promise<void> {
    this.log('info', 'Stopping Chat Application Module');
    
    // Stop periodic sync
    this.stopPeriodicSync();
    
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
      id: roomId,
      type: 'chat-room',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      resourceId: roomId,
      resourceType: 'chat-room',
      nodeId: 'current-node', // Simplified - would get from context
      timestamp: Date.now(),
      capacity: {
        current: 0,
        maximum: this.chatConfig.maxClientsPerRoom,
        reserved: 0,
        unit: 'participants'
      },
      performance: {
        latency: 0,
        throughput: 0,
        errorRate: 0
      },
      distribution: {
        shardCount: 1
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
   * Distributed Room Creation - Create room with optimal placement
   */
  async createRoomDistributed(roomName: string, options: {
    description?: string;
    isPublic?: boolean;
    maxParticipants?: number;
    preferredNode?: string;
  } = {}): Promise<ChatRoomResource> {
    try {
      // Check if room already exists cluster-wide
      const existingRoom = await this.findRoom(roomName);
      if (existingRoom) {
        throw new Error(`Room '${roomName}' already exists`);
      }

      // Get optimal placement recommendation using topology manager
      let targetNodeId = options.preferredNode;
      
      if (!targetNodeId && this.context?.topologyManager) {
        const recommendation = await this.context.topologyManager.recommendResourcePlacement({
          resourceType: 'chat-room',
          estimatedLoad: options.maxParticipants || this.chatConfig.maxClientsPerRoom,
          constraints: {
            capacity: options.maxParticipants || this.chatConfig.maxClientsPerRoom
          }
        });
        
        targetNodeId = recommendation.recommendedPlacement.primaryNode;
      }

      // Create room data
      const roomData: Partial<ChatRoomResource> = {
        applicationData: {
          roomName,
          description: options.description,
          isPublic: options.isPublic ?? true,
          maxParticipants: options.maxParticipants || this.chatConfig.maxClientsPerRoom,
          participantCount: 0,
          messageRate: 0,
          created: Date.now(),
          lastActivity: Date.now()
        }
      };

      // For now, create locally since we don't have cluster messaging setup
      const room = await this.createResource(roomData);
      
      // Broadcast room creation to cluster using ApplicationRegistry
      if (this.context?.applicationRegistry) {
        await this.context.applicationRegistry.broadcastResourceState([room]);
      }
      
      return room;
    } catch (error) {
      this.log('error', `Distributed room creation failed for '${roomName}': ${error}`);
      throw error;
    }
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
   * Cross-Node Room State Synchronization
   */
  async synchronizeRoomStates(): Promise<void> {
    try {
      if (!this.context?.applicationRegistry) {
        this.log('warn', 'ApplicationRegistry not available for room state sync');
        return;
      }

      // Get all cluster rooms for comparison
      const clusterRooms = await this.context.applicationRegistry.getResourcesByType('chat-room') as ChatRoomResource[];
      
      // Track synchronization stats
      let syncedRooms = 0;
      let conflictsResolved = 0;
      
      for (const clusterRoom of clusterRooms) {
        const localRoom = this.rooms.get(clusterRoom.resourceId);
        
        if (localRoom) {
          // Room exists locally - check for conflicts and merge state
          const mergedRoom = this.mergeRoomState(localRoom, clusterRoom);
          if (mergedRoom !== localRoom) {
            this.rooms.set(clusterRoom.resourceId, mergedRoom);
            conflictsResolved++;
            this.emit('room-state-merged', { roomId: clusterRoom.resourceId, localRoom, clusterRoom, mergedRoom });
          }
        } else {
          // Room doesn't exist locally - add it if it should be here
          if (this.shouldLocallyTrackRoom(clusterRoom)) {
            this.rooms.set(clusterRoom.resourceId, clusterRoom);
            this.messageHistory.set(clusterRoom.resourceId, []);
            syncedRooms++;
            this.emit('room-synced-from-cluster', clusterRoom);
          }
        }
      }

      // Check for local rooms that might be missing from cluster
      for (const [roomId, localRoom] of this.rooms) {
        const existsInCluster = clusterRooms.some(r => r.resourceId === roomId);
        if (!existsInCluster) {
          // Broadcast local room to cluster
          await this.context.applicationRegistry.broadcastResourceState([localRoom]);
          this.emit('room-broadcasted-to-cluster', localRoom);
        }
      }

      this.log('info', `Room state sync complete: ${syncedRooms} rooms synced, ${conflictsResolved} conflicts resolved`);
      this.emit('room-state-sync-complete', { syncedRooms, conflictsResolved });
      
    } catch (error) {
      this.log('error', `Room state synchronization failed: ${error}`);
      this.emit('room-state-sync-error', error);
    }
  }

  /**
   * Merge room states from local and cluster sources
   */
  private mergeRoomState(localRoom: ChatRoomResource, clusterRoom: ChatRoomResource): ChatRoomResource {
    // Use most recent timestamp as source of truth for basic fields
    const newerRoom = localRoom.timestamp > clusterRoom.timestamp ? localRoom : clusterRoom;
    
    // Merge participant counts (take maximum)
    const participantCount = Math.max(
      localRoom.applicationData.participantCount,
      clusterRoom.applicationData.participantCount
    );
    
    // Merge message rates (take maximum)
    const messageRate = Math.max(
      localRoom.applicationData.messageRate,
      clusterRoom.applicationData.messageRate
    );
    
    // Use most recent activity time
    const lastActivity = Math.max(
      localRoom.applicationData.lastActivity,
      clusterRoom.applicationData.lastActivity
    );
    
    return {
      ...newerRoom,
      applicationData: {
        ...newerRoom.applicationData,
        participantCount,
        messageRate,
        lastActivity
      },
      timestamp: Math.max(localRoom.timestamp, clusterRoom.timestamp)
    };
  }

  /**
   * Determine if a room should be tracked locally
   */
  private shouldLocallyTrackRoom(room: ChatRoomResource): boolean {
    // Simple heuristic: track all public rooms and rooms with recent activity
    const recentActivity = Date.now() - room.applicationData.lastActivity < 24 * 60 * 60 * 1000; // 24 hours
    return room.applicationData.isPublic || recentActivity;
  }

  /**
   * Enhanced Room Discovery - Find rooms across the cluster using ApplicationRegistry
   */
  async findRoom(roomName: string): Promise<ChatRoomResource | null> {
    try {
      // First check local rooms
      for (const room of this.rooms.values()) {
        if (room.applicationData.roomName === roomName) {
          return room;
        }
      }

      // Use ApplicationRegistry for cluster-wide discovery
      if (this.context?.applicationRegistry) {
        const resource = await this.context.applicationRegistry.findResourceByName('chat-room', roomName);
        if (resource) {
          return resource as ChatRoomResource;
        }
      }

      return null;
    } catch (error) {
      this.log('error', `Room discovery failed for '${roomName}': ${error}`);
      return null;
    }
  }

  /**
   * Find all rooms matching criteria across cluster
   */
  async findRooms(criteria: { isPublic?: boolean; maxParticipants?: number; pattern?: string }): Promise<ChatRoomResource[]> {
    const results: ChatRoomResource[] = [];

    try {
      // Search local rooms
      for (const room of this.rooms.values()) {
        if (this.matchesRoomCriteria(room, criteria)) {
          results.push(room);
        }
      }

      // Search cluster using ApplicationRegistry
      if (this.context?.applicationRegistry) {
        const clusterRooms = await this.context.applicationRegistry.getResourcesByType('chat-room');
        for (const resource of clusterRooms) {
          const room = resource as ChatRoomResource;
          if (this.matchesRoomCriteria(room, criteria) && !results.find(r => r.resourceId === room.resourceId)) {
            results.push(room);
          }
        }
      }

      return results;
    } catch (error) {
      this.log('error', `Room search failed: ${error}`);
      return results; // Return partial results
    }
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

  /**
   * Check if a room matches the given criteria
   */
  private matchesRoomCriteria(room: ChatRoomResource, criteria: { isPublic?: boolean; maxParticipants?: number; pattern?: string }): boolean {
    if (criteria.isPublic !== undefined && room.applicationData.isPublic !== criteria.isPublic) {
      return false;
    }
    
    if (criteria.maxParticipants !== undefined && room.applicationData.maxParticipants < criteria.maxParticipants) {
      return false;
    }
    
    if (criteria.pattern) {
      const pattern = criteria.pattern.toLowerCase();
      const roomName = room.applicationData.roomName.toLowerCase();
      const description = (room.applicationData.description || '').toLowerCase();
      
      if (!roomName.includes(pattern) && !description.includes(pattern)) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Start periodic room state synchronization
   */
  private startPeriodicSync(): void {
    // Sync every 30 seconds
    this.syncInterval = setInterval(async () => {
      try {
        await this.synchronizeRoomStates();
      } catch (error) {
        this.log('error', `Periodic room sync failed: ${error}`);
      }
    }, 30000);
  }

  /**
   * Stop periodic room state synchronization
   */
  private stopPeriodicSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
    }
  }
}
