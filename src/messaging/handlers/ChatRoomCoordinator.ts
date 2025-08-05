import { EventEmitter } from 'events';
import { 
  RangeHandler, 
  ClusterMessage, 
  ClusterInfo, 
  RangeId,
  ITransport
} from '../../coordinators/types';

/**
 * Chat room entity that represents a distributed room
 */
export interface ChatRoomEntity {
  id: string;
  name: string;
  participants: Set<string>;
  messageCount: number;
  lastActivity: number;
  ownerNode: string;
}

/**
 * Chat message entity
 */
export interface ChatMessageEntity {
  id: string;
  roomId: string;
  userId: string;
  content: string;
  timestamp: number;
  nodeId: string;
}

/**
 * Client subscription for room updates
 */
export interface ClientSubscription {
  clientId: string;
  roomId: string;
  nodeId: string;
  subscribedAt: number;
}

/**
 * ChatRoomCoordinator implements the RangeHandler pattern
 * Each chat room gets assigned to a range, and the node that owns
 * that range becomes responsible for the room's state and message routing
 */
export class ChatRoomCoordinator extends EventEmitter implements RangeHandler {
  private ownedRooms = new Map<string, ChatRoomEntity>();
  private roomToRange = new Map<string, RangeId>();
  private clientSubscriptions = new Map<string, ClientSubscription[]>();
  private transport: ITransport;
  private nodeId: string;
  private isActive = true;

  constructor(transport: ITransport, nodeId: string) {
    super();
    this.transport = transport;
    this.nodeId = nodeId;
  }

  async onJoin(rangeId: RangeId, clusterInfo: ClusterInfo): Promise<void> {
    if (!this.isActive) return;
    
    console.log(`💬 ChatRoomCoordinator: Node ${this.nodeId} acquired range ${rangeId}`);
    console.log(`📊 Cluster info: ${clusterInfo.members.length} members, ${clusterInfo.totalRanges} total ranges`);
    
    // Load existing rooms for this range from persistent storage
    await this.loadRoomsForRange(rangeId);
    
    this.emit('range-acquired', rangeId);
  }

  async onMessage(message: ClusterMessage): Promise<void> {
    console.log(`📨 ChatRoomCoordinator: Processing message ${message.id} of type ${message.type}`);
    
    try {
      switch (message.type) {
        case 'JOIN_ROOM':
          await this.handleJoinRoom(message);
          break;
          
        case 'LEAVE_ROOM':
          await this.handleLeaveRoom(message);
          break;
          
        case 'SEND_CHAT_MESSAGE':
          await this.handleChatMessage(message);
          break;
          
        case 'SUBSCRIBE_TO_ROOM':
          await this.handleSubscribeToRoom(message);
          break;
          
        case 'UNSUBSCRIBE_FROM_ROOM':
          await this.handleUnsubscribeFromRoom(message);
          break;
          
        default:
          console.log(`⚠️ ChatRoomCoordinator: Unknown message type ${message.type}`);
      }
    } catch (error) {
      console.error(`❌ ChatRoomCoordinator: Error processing message ${message.id}:`, error);
      this.emit('message-error', { message, error });
    }
  }

  async onLeave(rangeId: RangeId): Promise<void> {
    console.log(`👋 ChatRoomCoordinator: Node ${this.nodeId} releasing range ${rangeId}`);
    
    // Mark as inactive to prevent further operations
    this.isActive = false;
    
    // Transfer room ownership to other nodes
    await this.transferRoomsForRange(rangeId);
    
    // Clean up range-specific state
    for (const [roomId, room] of this.ownedRooms) {
      if (this.roomToRange.get(roomId) === rangeId) {
        this.ownedRooms.delete(roomId);
        this.roomToRange.delete(roomId);
      }
    }
    
    this.emit('range-released', rangeId);
  }

  /**
   * Handle client joining a room
   */
  private async handleJoinRoom(message: ClusterMessage): Promise<void> {
    const { roomId, userId, clientId, fromNode } = message.payload;
    
    if (!this.ownsRoom(roomId)) {
      // Forward to the correct node
      await this.forwardToRoomOwner(roomId, message);
      return;
    }

    // Get or create room
    let room = this.ownedRooms.get(roomId);
    if (!room) {
      room = {
        id: roomId,
        name: `Room ${roomId}`,
        participants: new Set(),
        messageCount: 0,
        lastActivity: Date.now(),
        ownerNode: this.nodeId
      };
      this.ownedRooms.set(roomId, room);
    }

    // Add participant
    room.participants.add(userId);
    room.lastActivity = Date.now();

    console.log(`👥 User ${userId} joined room ${roomId} on node ${this.nodeId}`);

    // Send confirmation back to requesting node
    if (fromNode && fromNode !== this.nodeId) {
      await this.transport.sendToNode(fromNode, {
        id: `response-${message.id}`,
        type: 'ROOM_JOIN_RESPONSE',
        payload: {
          roomId,
          userId,
          clientId,
          success: true,
          ownerNode: this.nodeId
        },
        timestamp: Date.now(),
        sourceNodeId: this.nodeId
      });
    }

    // Notify all subscribers in this room about the new participant
    await this.broadcastToRoomSubscribers(roomId, {
      id: `participant-joined-${Date.now()}`,
      type: 'PARTICIPANT_JOINED',
      payload: {
        roomId,
        userId,
        participants: Array.from(room.participants)
      },
      timestamp: Date.now(),
      sourceNodeId: this.nodeId
    });

    this.emit('user-joined-room', { roomId, userId, room });
  }

  /**
   * Handle client leaving a room
   */
  private async handleLeaveRoom(message: ClusterMessage): Promise<void> {
    const { roomId, userId, clientId, fromNode } = message.payload;
    
    if (!this.ownsRoom(roomId)) {
      await this.forwardToRoomOwner(roomId, message);
      return;
    }

    const room = this.ownedRooms.get(roomId);
    if (!room) return;

    room.participants.delete(userId);
    room.lastActivity = Date.now();

    console.log(`👋 User ${userId} left room ${roomId} on node ${this.nodeId}`);

    // Send confirmation back to requesting node
    if (fromNode && fromNode !== this.nodeId) {
      await this.transport.sendToNode(fromNode, {
        id: `response-${message.id}`,
        type: 'ROOM_LEAVE_RESPONSE',
        payload: {
          roomId,
          userId,
          clientId,
          success: true
        },
        timestamp: Date.now(),
        sourceNodeId: this.nodeId
      });
    }

    // Notify subscribers about participant leaving
    await this.broadcastToRoomSubscribers(roomId, {
      id: `participant-left-${Date.now()}`,
      type: 'PARTICIPANT_LEFT',
      payload: {
        roomId,
        userId,
        participants: Array.from(room.participants)
      },
      timestamp: Date.now(),
      sourceNodeId: this.nodeId
    });

    this.emit('user-left-room', { roomId, userId, room });
  }

  /**
   * Handle chat message
   */
  private async handleChatMessage(message: ClusterMessage): Promise<void> {
    const { roomId, userId, content, messageId, fromNode } = message.payload;
    
    if (!this.ownsRoom(roomId)) {
      await this.forwardToRoomOwner(roomId, message);
      return;
    }

    const room = this.ownedRooms.get(roomId);
    if (!room) {
      console.warn(`Room ${roomId} not found for message from ${userId}`);
      return;
    }

    // Update room state
    room.messageCount++;
    room.lastActivity = Date.now();

    const chatMessage: ChatMessageEntity = {
      id: messageId,
      roomId,
      userId,
      content,
      timestamp: Date.now(),
      nodeId: this.nodeId
    };

    console.log(`💬 Message from ${userId} in room ${roomId}: ${content}`);

    // Broadcast message to all room subscribers across the cluster
    await this.broadcastToRoomSubscribers(roomId, {
      id: `chat-${messageId}`,
      type: 'CHAT_MESSAGE',
      payload: chatMessage,
      timestamp: Date.now(),
      sourceNodeId: this.nodeId
    });

    this.emit('chat-message', chatMessage);
  }

  /**
   * Handle client subscribing to room updates
   */
  private async handleSubscribeToRoom(message: ClusterMessage): Promise<void> {
    const { roomId, clientId, fromNode } = message.payload;
    
    if (!fromNode) return;

    // Add subscription tracking
    if (!this.clientSubscriptions.has(roomId)) {
      this.clientSubscriptions.set(roomId, []);
    }

    const subscriptions = this.clientSubscriptions.get(roomId)!;
    const existingIndex = subscriptions.findIndex(sub => sub.clientId === clientId);
    
    if (existingIndex === -1) {
      subscriptions.push({
        clientId,
        roomId,
        nodeId: fromNode,
        subscribedAt: Date.now()
      });
    }

    console.log(`📺 Client ${clientId} subscribed to room ${roomId} via node ${fromNode}`);
  }

  /**
   * Handle client unsubscribing from room updates
   */
  private async handleUnsubscribeFromRoom(message: ClusterMessage): Promise<void> {
    const { roomId, clientId } = message.payload;
    
    const subscriptions = this.clientSubscriptions.get(roomId);
    if (!subscriptions) return;

    const updatedSubscriptions = subscriptions.filter(sub => sub.clientId !== clientId);
    this.clientSubscriptions.set(roomId, updatedSubscriptions);

    console.log(`📺 Client ${clientId} unsubscribed from room ${roomId}`);
  }

  /**
   * Broadcast message to all subscribers of a room
   */
  private async broadcastToRoomSubscribers(roomId: string, message: ClusterMessage): Promise<void> {
    const subscriptions = this.clientSubscriptions.get(roomId);
    if (!subscriptions || subscriptions.length === 0) return;

    // Group subscriptions by node to minimize network calls
    const subscriptionsByNode = new Map<string, ClientSubscription[]>();
    for (const subscription of subscriptions) {
      if (!subscriptionsByNode.has(subscription.nodeId)) {
        subscriptionsByNode.set(subscription.nodeId, []);
      }
      subscriptionsByNode.get(subscription.nodeId)!.push(subscription);
    }

    // Send broadcast message to each node with their client list
    for (const [nodeId, nodeSubscriptions] of subscriptionsByNode) {
      const clientIds = nodeSubscriptions.map(sub => sub.clientId);
      
      const broadcastMessage: ClusterMessage = {
        id: `broadcast-${message.id}`,
        type: 'BROADCAST_TO_CLIENTS',
        payload: {
          originalMessage: message,
          targetClients: clientIds,
          roomId
        },
        timestamp: Date.now(),
        sourceNodeId: this.nodeId
      };

      try {
        await this.transport.sendToNode(nodeId, broadcastMessage);
      } catch (error) {
        console.error(`Failed to broadcast to node ${nodeId}:`, error);
      }
    }
  }

  /**
   * Forward message to the node that owns the room
   */
  private async forwardToRoomOwner(roomId: string, message: ClusterMessage): Promise<void> {
    // This would use the consistent hash ring or gossip protocol to find the owner
    // For now, we'll emit an event that the ClusterManager can handle
    this.emit('forward-message', { roomId, message });
  }

  /**
   * Check if this node owns a specific room
   */
  private ownsRoom(roomId: string): boolean {
    return this.ownedRooms.has(roomId);
  }

  /**
   * Load rooms for a range from persistent storage
   */
  private async loadRoomsForRange(rangeId: RangeId): Promise<void> {
    // Implementation would load from database/WAL
    // For now, this is a placeholder
    console.log(`🔄 Loading rooms for range ${rangeId}`);
  }

  /**
   * Transfer room ownership when leaving a range
   */
  private async transferRoomsForRange(rangeId: RangeId): Promise<void> {
    // Implementation would coordinate room transfer
    console.log(`🔄 Transferring rooms for range ${rangeId}`);
  }

  /**
   * Get room state (public API)
   */
  public getRoom(roomId: string): ChatRoomEntity | undefined {
    return this.ownedRooms.get(roomId);
  }

  /**
   * Get all owned rooms (public API)
   */
  public getOwnedRooms(): ChatRoomEntity[] {
    return Array.from(this.ownedRooms.values());
  }

  /**
   * Get room subscribers (public API)
   */
  public getRoomSubscribers(roomId: string): ClientSubscription[] {
    return this.clientSubscriptions.get(roomId) || [];
  }

  /**
   * Shutdown coordinator
   */
  public async shutdown(): Promise<void> {
    this.isActive = false;
    this.ownedRooms.clear();
    this.roomToRange.clear();
    this.clientSubscriptions.clear();
    this.removeAllListeners();
  }
}
