import { 
  RangeHandler, 
  ClusterMessage, 
  ClusterInfo, 
  RangeId 
} from '../../../src/coordinators/types';
import { ClientWebSocketAdapter, ClientMessage } from '../../../src/transport/adapters/ClientWebSocketAdapter';
import WebSocket from 'ws';

// Chat room state managed by range handler
interface ChatRoomState {
  roomId: string;
  name: string;
  participants: Set<string>;
  messageHistory: ChatMessage[];
  lastActivity: number;
  messageCount: number;
}

// Chat message structure
interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  content: string;
  timestamp: number;
  nodeId: string;
}

// Client subscription mapping
interface ClientSubscription {
  clientId: string;
  userId: string;
  roomId: string;
  nodeId: string;
}

/**
 * ChatRoomHandler - Implements range-based chat room management
 * Each room is a range, distributed across the cluster using your coordinator system
 */
export class ChatRoomHandler implements RangeHandler {
  private roomStates = new Map<RangeId, ChatRoomState>();
  private clientSubscriptions = new Map<string, ClientSubscription[]>();
  private clientAdapter: ClientWebSocketAdapter;
  private nodeId: string;
  private clusterInfo?: ClusterInfo;
  private enableLogging: boolean;

  constructor(
    nodeId: string, 
    clientAdapter: ClientWebSocketAdapter,
    enableLogging: boolean = false
  ) {
    this.nodeId = nodeId;
    this.clientAdapter = clientAdapter;
    this.enableLogging = enableLogging;
    
    this.setupClientHandlers();
  }

  private setupClientHandlers(): void {
    // Handle client connections and messages
    this.clientAdapter.on('client-message', async ({ clientId, message }) => {
      await this.handleClientMessage(clientId, message);
    });

    this.clientAdapter.on('client-disconnected', ({ clientId }) => {
      this.handleClientDisconnected(clientId);
    });
  }

  // RangeHandler implementation
  async onJoin(rangeId: RangeId, clusterInfo: ClusterInfo): Promise<void> {
    this.clusterInfo = clusterInfo;
    
    if (!this.roomStates.has(rangeId)) {
      // Initialize new room state
      this.roomStates.set(rangeId, {
        roomId: rangeId,
        name: `Room ${rangeId}`,
        participants: new Set(),
        messageHistory: [],
        lastActivity: Date.now(),
        messageCount: 0
      });
    }

    this.log(`📍 Node ${this.nodeId} now owns room ${rangeId}`);
    
    // Notify subscribed clients that we now handle this room
    await this.broadcastRoomUpdate(rangeId, 'ROOM_OWNERSHIP_ACQUIRED');
  }

  async onMessage(message: ClusterMessage): Promise<void> {
    this.log(`📨 Processing cluster message: ${message.type} for range ${message.targetRangeId}`);

    switch (message.type) {
      case 'CHAT_MESSAGE':
        await this.handleChatMessage(message);
        break;
      case 'JOIN_ROOM':
        await this.handleJoinRoom(message);
        break;
      case 'LEAVE_ROOM':
        await this.handleLeaveRoom(message);
        break;
      case 'CLIENT_SUBSCRIBE':
        await this.handleClientSubscribe(message);
        break;
      case 'CLIENT_UNSUBSCRIBE':
        await this.handleClientUnsubscribe(message);
        break;
      default:
        this.log(`⚠️ Unknown message type: ${message.type}`);
    }
  }

  async onLeave(rangeId: RangeId): Promise<void> {
    this.log(`👋 Node ${this.nodeId} releasing ownership of room ${rangeId}`);
    
    // Clean up room state
    this.roomStates.delete(rangeId);
    
    // Notify clients that this room is no longer handled here
    await this.broadcastRoomUpdate(rangeId, 'ROOM_OWNERSHIP_RELEASED');
  }

  // Client message handling
  private async handleClientMessage(clientId: string, message: ClientMessage): Promise<void> {
    const data = message.data || message;
    
    switch (message.type) {
      case 'join-room':
        await this.routeToRoomOwner(data.roomId, {
          id: this.generateMessageId(),
          type: 'JOIN_ROOM',
          payload: {
            clientId,
            userId: data.userId,
            roomId: data.roomId,
            nodeId: this.nodeId
          },
          sourceNodeId: this.nodeId,
          targetRangeId: data.roomId,
          timestamp: Date.now()
        });
        break;
        
      case 'send-message':
        await this.routeToRoomOwner(data.roomId, {
          id: this.generateMessageId(),
          type: 'CHAT_MESSAGE',
          payload: {
            clientId,
            userId: data.userId,
            roomId: data.roomId,
            content: data.content,
            nodeId: this.nodeId
          },
          sourceNodeId: this.nodeId,
          targetRangeId: data.roomId,
          timestamp: Date.now()
        });
        break;
        
      case 'leave-room':
        await this.routeToRoomOwner(data.roomId, {
          id: this.generateMessageId(),
          type: 'LEAVE_ROOM',
          payload: {
            clientId,
            userId: data.userId,
            roomId: data.roomId,
            nodeId: this.nodeId
          },
          sourceNodeId: this.nodeId,
          targetRangeId: data.roomId,
          timestamp: Date.now()
        });
        break;
    }
  }

  // Cluster message handlers
  private async handleChatMessage(message: ClusterMessage): Promise<void> {
    const { roomId, userId, content, clientId } = message.payload;
    const roomState = this.roomStates.get(roomId);
    
    if (!roomState) {
      this.log(`⚠️ Room ${roomId} not found on this node`);
      return;
    }

    // Create chat message
    const chatMessage: ChatMessage = {
      id: message.id,
      roomId,
      userId,
      content,
      timestamp: message.timestamp,
      nodeId: message.sourceNodeId
    };

    // Store in room history
    roomState.messageHistory.push(chatMessage);
    roomState.messageCount++;
    roomState.lastActivity = Date.now();

    this.log(`💬 Message from ${userId} in room ${roomId}: ${content}`);

    // Broadcast to all subscribers of this room
    await this.broadcastToRoomSubscribers(roomId, {
      type: 'chat-message',
      data: chatMessage
    });

    // Send confirmation to sender
    if (message.sourceNodeId === this.nodeId) {
      this.clientAdapter.sendToClient(clientId, {
        type: 'message-sent',
        data: { messageId: message.id, roomId }
      });
    }
  }

  private async handleJoinRoom(message: ClusterMessage): Promise<void> {
    const { roomId, userId, clientId } = message.payload;
    const roomState = this.roomStates.get(roomId);
    
    if (!roomState) {
      this.log(`⚠️ Room ${roomId} not found on this node`);
      return;
    }

    // Add user to room
    roomState.participants.add(userId);
    roomState.lastActivity = Date.now();

    this.log(`👥 ${userId} joined room ${roomId} (${roomState.participants.size} participants)`);

    // Add client subscription
    this.addClientSubscription(clientId, userId, roomId, message.sourceNodeId);

    // Send confirmation to client
    if (message.sourceNodeId === this.nodeId) {
      this.clientAdapter.sendToClient(clientId, {
        type: 'room-joined',
        data: {
          roomId,
          userId,
          participantCount: roomState.participants.size,
          ownerNode: this.nodeId
        }
      });
    }

    // Broadcast room update to all subscribers
    await this.broadcastToRoomSubscribers(roomId, {
      type: 'room-updated',
      data: {
        roomId,
        participantCount: roomState.participants.size,
        participants: Array.from(roomState.participants)
      }
    });
  }

  private async handleLeaveRoom(message: ClusterMessage): Promise<void> {
    const { roomId, userId, clientId } = message.payload;
    const roomState = this.roomStates.get(roomId);
    
    if (!roomState) {
      return;
    }

    // Remove user from room
    roomState.participants.delete(userId);
    roomState.lastActivity = Date.now();

    this.log(`👋 ${userId} left room ${roomId} (${roomState.participants.size} participants)`);

    // Remove client subscription
    this.removeClientSubscription(clientId, roomId);

    // Send confirmation to client
    if (message.sourceNodeId === this.nodeId) {
      this.clientAdapter.sendToClient(clientId, {
        type: 'room-left',
        data: { roomId, userId }
      });
    }

    // Broadcast room update
    await this.broadcastToRoomSubscribers(roomId, {
      type: 'room-updated',
      data: {
        roomId,
        participantCount: roomState.participants.size,
        participants: Array.from(roomState.participants)
      }
    });
  }

  // Utility methods
  private async routeToRoomOwner(roomId: string, message: ClusterMessage): Promise<void> {
    // In a real implementation, this would use the cluster router
    // For now, we'll assume this node handles the message if it owns the range
    if (this.roomStates.has(roomId)) {
      await this.onMessage(message);
    } else {
      this.log(`🔀 Room ${roomId} not owned by this node, would route to owner`);
      // In real implementation: await this.clusterRouter.routeMessage(message);
    }
  }

  private addClientSubscription(clientId: string, userId: string, roomId: string, nodeId: string): void {
    if (!this.clientSubscriptions.has(roomId)) {
      this.clientSubscriptions.set(roomId, []);
    }
    
    const subscriptions = this.clientSubscriptions.get(roomId)!;
    subscriptions.push({ clientId, userId, roomId, nodeId });
  }

  private removeClientSubscription(clientId: string, roomId: string): void {
    const subscriptions = this.clientSubscriptions.get(roomId);
    if (subscriptions) {
      const index = subscriptions.findIndex(sub => sub.clientId === clientId);
      if (index > -1) {
        subscriptions.splice(index, 1);
      }
    }
  }

  private handleClientDisconnected(clientId: string): void {
    // Remove all subscriptions for this client
    for (const [roomId, subscriptions] of this.clientSubscriptions) {
      const index = subscriptions.findIndex(sub => sub.clientId === clientId);
      if (index > -1) {
        const subscription = subscriptions[index];
        subscriptions.splice(index, 1);
        
        // Remove from room participants if this was the last connection for this user
        const roomState = this.roomStates.get(roomId);
        if (roomState) {
          const hasOtherConnections = subscriptions.some(sub => sub.userId === subscription.userId);
          if (!hasOtherConnections) {
            roomState.participants.delete(subscription.userId);
          }
        }
      }
    }
  }

  private async broadcastToRoomSubscribers(roomId: string, message: ClientMessage): Promise<void> {
    const subscriptions = this.clientSubscriptions.get(roomId) || [];
    
    for (const subscription of subscriptions) {
      if (subscription.nodeId === this.nodeId) {
        // Local client
        this.clientAdapter.sendToClient(subscription.clientId, message);
      } else {
        // Remote client - would send via cluster message
        this.log(`📡 Would send to remote client ${subscription.clientId} on node ${subscription.nodeId}`);
      }
    }
  }

  private async broadcastRoomUpdate(roomId: string, updateType: string): Promise<void> {
    // Broadcast ownership changes to interested clients
    const subscriptions = this.clientSubscriptions.get(roomId) || [];
    
    for (const subscription of subscriptions) {
      if (subscription.nodeId === this.nodeId) {
        this.clientAdapter.sendToClient(subscription.clientId, {
          type: 'room-ownership-changed',
          data: {
            roomId,
            updateType,
            newOwner: this.nodeId
          }
        });
      }
    }
  }

  // Public API for getting room state
  getRoomState(roomId: string): ChatRoomState | undefined {
    return this.roomStates.get(roomId);
  }

  getAllRooms(): Map<RangeId, ChatRoomState> {
    return new Map(this.roomStates);
  }

  getClientSubscriptions(roomId: string): ClientSubscription[] {
    return this.clientSubscriptions.get(roomId) || [];
  }

  private generateMessageId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private log(...args: any[]): void {
    if (this.enableLogging) {
      console.log(`[ChatRoomHandler:${this.nodeId}]`, ...args);
    }
  }

  private async handleClientSubscribe(message: ClusterMessage): Promise<void> {
    // Handle cross-node client subscriptions
    const { clientId, userId, roomId, sourceNodeId } = message.payload;
    this.addClientSubscription(clientId, userId, roomId, sourceNodeId);
  }

  private async handleClientUnsubscribe(message: ClusterMessage): Promise<void> {
    // Handle cross-node client unsubscriptions
    const { clientId, roomId } = message.payload;
    this.removeClientSubscription(clientId, roomId);
  }
}
