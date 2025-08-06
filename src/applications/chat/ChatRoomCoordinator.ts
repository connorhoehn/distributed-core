import { Router } from '../../messaging/Router';
import { ClusterManager } from '../../cluster/ClusterManager';
import { ResourceRegistry } from '../../cluster/resources/ResourceRegistry';
import { ResourceMetadata } from '../../cluster/resources/types';
import { ChatTopologyManager, RoomMetadata } from './ChatTopologyManager';

/**
 * Chat message entity
 */
export interface ChatMessageEntity {
  messageId: string;
  roomId: string;
  userId: string;
  content: string;
  timestamp: number;
  messageType: 'text' | 'media' | 'system';
  metadata?: Record<string, any>;
}

/**
 * Client subscription for room updates
 */
export interface RoomSubscription {
  clientId: string;
  roomId: string;
  subscriptionType: 'messages' | 'presence' | 'all';
  filters?: Record<string, any>;
}

/**
 * Chat Room Coordinator - Extracted Chat Logic
 * 
 * This class encapsulates all chat-specific logic that was previously
 * embedded in the core cluster messaging system. It manages:
 * - Room creation and lifecycle
 * - Message routing and persistence
 * - Client subscriptions and presence
 * - Chat-specific resource management
 */
export class ChatRoomCoordinator {
  private router: Router;
  private clusterManager: ClusterManager;
  private resourceRegistry: ResourceRegistry;
  private chatTopologyManager: ChatTopologyManager;
  
  // Chat-specific state
  private rooms = new Map<string, RoomMetadata>();
  private messageHistory = new Map<string, ChatMessageEntity[]>();
  private subscriptions = new Map<string, RoomSubscription[]>();
  private userPresence = new Map<string, { roomId: string; lastSeen: number; status: 'online' | 'away' | 'offline' }>();

  constructor(
    router: Router,
    clusterManager: ClusterManager,
    resourceRegistry: ResourceRegistry,
    chatTopologyManager: ChatTopologyManager
  ) {
    this.router = router;
    this.clusterManager = clusterManager;
    this.resourceRegistry = resourceRegistry;
    this.chatTopologyManager = chatTopologyManager;
    
    this.setupMessageHandlers();
  }

  /**
   * Start the chat room coordinator
   */
  async start(): Promise<void> {
    // Register chat room resource type
    await this.registerChatRoomResourceType();
    
    // Set up periodic cleanup
    setInterval(() => this.cleanupInactiveRooms(), 300000); // 5 minutes
    setInterval(() => this.cleanupOldMessages(), 3600000); // 1 hour
  }

  /**
   * Create a new chat room
   */
  async createRoom(roomData: {
    roomId: string;
    roomType: 'chat' | 'broadcast' | 'conference' | 'private';
    maxParticipants?: number;
    permissions?: {
      canPost: string[];
      canView: string[];
      moderators?: string[];
    };
    geographic?: {
      primaryRegion?: string;
      allowedRegions?: string[];
    };
  }): Promise<RoomMetadata> {
    // Get optimal placement for the room
    const placement = await this.chatTopologyManager.getRoomPlacementRecommendation({
      expectedParticipants: roomData.maxParticipants || 100,
      expectedMessageRate: 10, // Default estimate
      regionPreference: roomData.geographic?.primaryRegion,
      haRequirements: roomData.roomType === 'conference'
    });

    const roomMetadata: RoomMetadata = {
      roomId: roomData.roomId,
      ownerNode: placement.recommendedNode,
      participantCount: 0,
      messageRate: 0,
      created: Date.now(),
      lastActivity: Date.now(),
      sharding: {
        enabled: false,
        maxParticipants: roomData.maxParticipants,
        shardingStrategy: 'participant-count'
      },
      highAvailability: {
        enabled: roomData.roomType === 'conference',
        replicationFactor: roomData.roomType === 'conference' ? 2 : 1,
        regions: [placement.recommendedNode],
        zones: [],
        requirements: {
          crossRegion: false,
          crossZone: false,
          isolation: 'none'
        }
      },
      roomType: {
        type: roomData.roomType,
        capabilities: ['messaging', 'presence'],
        permissions: roomData.permissions || {
          canPost: ['*'],
          canView: ['*']
        }
      },
      performance: {
        priority: 'normal',
        expectedLoad: roomData.maxParticipants || 100,
        maxLatency: 500,
        guaranteedDelivery: roomData.roomType === 'conference'
      },
      geographic: roomData.geographic || {}
    };

    // Register with topology manager
    await this.chatTopologyManager.registerRoom(roomMetadata);
    
    // Store locally
    this.rooms.set(roomData.roomId, roomMetadata);
    this.messageHistory.set(roomData.roomId, []);

    return roomMetadata;
  }

  /**
   * Join a user to a room
   */
  async joinRoom(roomId: string, userId: string, clientId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error(`Room ${roomId} not found`);
    }

    // Update presence
    this.userPresence.set(userId, {
      roomId,
      lastSeen: Date.now(),
      status: 'online'
    });

    // Add subscription
    const userSubscriptions = this.subscriptions.get(userId) || [];
    userSubscriptions.push({
      clientId,
      roomId,
      subscriptionType: 'all'
    });
    this.subscriptions.set(userId, userSubscriptions);

    // Update room metadata
    room.participantCount++;
    room.lastActivity = Date.now();

    // Broadcast join event
    await this.broadcastToRoom(roomId, {
      messageId: `join-${Date.now()}`,
      roomId,
      userId: 'system',
      content: `${userId} joined the room`,
      timestamp: Date.now(),
      messageType: 'system'
    });
  }

  /**
   * Leave a user from a room
   */
  async leaveRoom(roomId: string, userId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    // Update presence
    this.userPresence.delete(userId);

    // Remove subscriptions
    const userSubscriptions = this.subscriptions.get(userId) || [];
    const filteredSubscriptions = userSubscriptions.filter(s => s.roomId !== roomId);
    
    if (filteredSubscriptions.length === 0) {
      this.subscriptions.delete(userId);
    } else {
      this.subscriptions.set(userId, filteredSubscriptions);
    }

    // Update room metadata
    room.participantCount = Math.max(0, room.participantCount - 1);
    room.lastActivity = Date.now();

    // Broadcast leave event
    await this.broadcastToRoom(roomId, {
      messageId: `leave-${Date.now()}`,
      roomId,
      userId: 'system',
      content: `${userId} left the room`,
      timestamp: Date.now(),
      messageType: 'system'
    });
  }

  /**
   * Send a message to a room
   */
  async sendMessage(message: Omit<ChatMessageEntity, 'messageId' | 'timestamp'>): Promise<ChatMessageEntity> {
    const room = this.rooms.get(message.roomId);
    if (!room) {
      throw new Error(`Room ${message.roomId} not found`);
    }

    const fullMessage: ChatMessageEntity = {
      ...message,
      messageId: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now()
    };

    // Store message
    const history = this.messageHistory.get(message.roomId) || [];
    history.push(fullMessage);
    
    // Keep only last 1000 messages
    if (history.length > 1000) {
      history.splice(0, history.length - 1000);
    }
    this.messageHistory.set(message.roomId, history);

    // Update room activity
    room.lastActivity = Date.now();
    room.messageRate = this.calculateMessageRate(message.roomId);

    // Broadcast to subscribers
    await this.broadcastToRoom(message.roomId, fullMessage);

    return fullMessage;
  }

  /**
   * Get room history
   */
  getRoomHistory(roomId: string, limit: number = 50): ChatMessageEntity[] {
    const history = this.messageHistory.get(roomId) || [];
    return history.slice(-limit);
  }

  /**
   * Get room information
   */
  getRoomInfo(roomId: string): RoomMetadata | null {
    return this.rooms.get(roomId) || null;
  }

  /**
   * Delete a room
   */
  async deleteRoom(roomId: string): Promise<void> {
    // Notify all participants
    await this.broadcastToRoom(roomId, {
      messageId: `delete-${Date.now()}`,
      roomId,
      userId: 'system',
      content: 'Room has been deleted',
      timestamp: Date.now(),
      messageType: 'system'
    });

    // Clean up local state
    this.rooms.delete(roomId);
    this.messageHistory.delete(roomId);

    // Remove subscriptions
    for (const [userId, subscriptions] of this.subscriptions) {
      const filtered = subscriptions.filter(s => s.roomId !== roomId);
      if (filtered.length === 0) {
        this.subscriptions.delete(userId);
      } else {
        this.subscriptions.set(userId, filtered);
      }
    }

    // Unregister from topology manager
    await this.chatTopologyManager.unregisterRoom(roomId);
  }

  // Private helper methods

  private async registerChatRoomResourceType(): Promise<void> {
    // This would register the chat-room resource type with the ResourceRegistry
    // Implementation depends on the ResourceTypeRegistry structure
  }

  private setupMessageHandlers(): void {
    // Set up message routing for chat-specific messages
    this.router.register('chat.join', {
      handle: async (message: any, session: any) => {
        await this.joinRoom(message.data.roomId, message.data.userId, session.id);
      }
    });

    this.router.register('chat.leave', {
      handle: async (message: any, session: any) => {
        await this.leaveRoom(message.data.roomId, message.data.userId);
      }
    });

    this.router.register('chat.message', {
      handle: async (message: any, session: any) => {
        return await this.sendMessage({
          roomId: message.data.roomId,
          userId: message.data.userId,
          content: message.data.content,
          messageType: message.data.messageType || 'text',
          metadata: message.data.metadata
        });
      }
    });

    this.router.register('chat.history', {
      handle: async (message: any, session: any) => {
        return this.getRoomHistory(message.data.roomId, message.data.limit);
      }
    });

    this.router.register('chat.room.create', {
      handle: async (message: any, session: any) => {
        return await this.createRoom(message.data);
      }
    });

    this.router.register('chat.room.delete', {
      handle: async (message: any, session: any) => {
        await this.deleteRoom(message.data.roomId);
      }
    });

    this.router.register('chat.room.info', {
      handle: async (message: any, session: any) => {
        return this.getRoomInfo(message.data.roomId);
      }
    });
  }

  private async broadcastToRoom(roomId: string, message: ChatMessageEntity): Promise<void> {
    const subscribers: string[] = [];
    
    for (const [userId, subscriptions] of this.subscriptions) {
      const roomSubscription = subscriptions.find(s => s.roomId === roomId);
      if (roomSubscription) {
        subscribers.push(userId);
      }
    }

    // Note: Broadcasting would need to be implemented through the cluster messaging system
    // This is a simplified version - in practice, you'd use the ClusterManager's transport
    for (const subscriberId of subscribers) {
      try {
        // Use cluster manager to send messages to subscribers
        console.log(`Broadcasting message to ${subscriberId} in room ${roomId}`);
      } catch (error) {
        console.warn(`Failed to deliver message to ${subscriberId}:`, error);
      }
    }
  }

  private calculateMessageRate(roomId: string): number {
    const history = this.messageHistory.get(roomId) || [];
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    const recentMessages = history.filter(msg => msg.timestamp > oneMinuteAgo);
    return recentMessages.length; // messages per minute
  }

  private cleanupInactiveRooms(): void {
    const now = Date.now();
    const inactivityThreshold = 30 * 60 * 1000; // 30 minutes
    
    for (const [roomId, room] of this.rooms) {
      if (room.participantCount === 0 && (now - room.lastActivity) > inactivityThreshold) {
        this.deleteRoom(roomId).catch(err => 
          console.warn(`Failed to cleanup inactive room ${roomId}:`, err)
        );
      }
    }
  }

  private cleanupOldMessages(): void {
    const now = Date.now();
    const messageRetention = 24 * 60 * 60 * 1000; // 24 hours
    
    for (const [roomId, history] of this.messageHistory) {
      const filteredHistory = history.filter(msg => (now - msg.timestamp) < messageRetention);
      this.messageHistory.set(roomId, filteredHistory);
    }
  }
}
