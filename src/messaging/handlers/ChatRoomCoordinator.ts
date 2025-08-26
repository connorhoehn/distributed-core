import { EventEmitter } from 'events';
import { 
  RangeHandler, 
  ClusterMessage, 
  ClusterInfo, 
  RangeId,
  ITransport
} from '../../coordinators/types';
import { EntityUpdate, WALEntry } from '../../persistence/types';
import { WALCoordinatorImpl } from '../../persistence/wal/WALCoordinator';
import { WALFileImpl } from '../../persistence/wal/WALFile';
import { ApplicationRegistry } from '../../applications/ApplicationRegistry';
import { ChatRoomResource } from '../../applications/ChatApplicationModule';
import { OperationEnvelopeManager } from '../../cluster/core/operations/OperationEnvelopeManager';
import { ClusterFanoutRouter } from '../../resources/distribution/ClusterFanoutRouter';
import { ResourceOperation } from '../../resources/core/ResourceOperation';

// Node.js environment access
declare const console: any;

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
 * Chat room entity update for WAL persistence
 */
export interface ChatRoomEntityUpdate extends EntityUpdate {
  entityId: string; // room-{roomName}-{nodeId}
  ownerNodeId: string; // node that owns this room
  operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'TRANSFER';
  timestamp: number;
  version: number;
  metadata: {
    roomId: string;
    roomName: string;
    participants: string[]; // participant user IDs
    messageCount: number;
    lastActivity: number;
    maxParticipants?: number;
    isPublic?: boolean;
    rangeId: string; // which range this room belongs to
    createdAt: number;
  };
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

  // WAL persistence components
  private walCoordinator: WALCoordinatorImpl;
  private walFile: WALFileImpl;
  private roomStorePath: string;
  private enablePersistence: boolean;

  // Cross-node functionality
  private applicationRegistry?: ApplicationRegistry;
  private crossNodeParticipants = new Map<string, Map<string, string>>(); // roomId -> clientId -> nodeId
  private clientConnectionManager?: any; // Optional client connection manager (e.g., ClientWebSocketAdapter)
  
  // Client ID mapping: room participant ID -> WebSocket client ID
  private clientWebSocketMap = new Map<string, string>(); // participantId -> websocketClientId

  // Distributed operations integration
  private envelopeManager?: OperationEnvelopeManager;
  private fanoutRouter?: ClusterFanoutRouter;

  constructor(transport: ITransport, nodeId: string, options: {
    storageDir?: string;
    enablePersistence?: boolean;
    applicationRegistry?: ApplicationRegistry;
    clientConnectionManager?: any; // e.g., ClientWebSocketAdapter
    envelopeManager?: OperationEnvelopeManager;
    fanoutRouter?: ClusterFanoutRouter;
  } = {}) {
    super();
    this.transport = transport;
    this.nodeId = nodeId;
    this.roomStorePath = options.storageDir || './room-storage';
    this.enablePersistence = options.enablePersistence ?? true;
    this.applicationRegistry = options.applicationRegistry;
    this.clientConnectionManager = options.clientConnectionManager;
    this.envelopeManager = options.envelopeManager;
    this.fanoutRouter = options.fanoutRouter;
    
    // Initialize WAL components if persistence is enabled
    this.walCoordinator = new WALCoordinatorImpl();
    this.walFile = new WALFileImpl(`${this.roomStorePath}/rooms-${nodeId}.wal`);
  }

  async onJoin(rangeId: RangeId, clusterInfo: ClusterInfo): Promise<void> {
    if (!this.isActive) return;
    
    console.log(`💬 ChatRoomCoordinator: Node ${this.nodeId} acquired range ${rangeId}`);
    console.log(`📊 Cluster info: ${clusterInfo.members.length} members, ${clusterInfo.totalRanges} total ranges`);
    
    // Initialize WAL if not already done
    if (this.enablePersistence) {
      await this.walFile.open();
    }
    
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
        case 'CHAT_MESSAGE':
          await this.handleChatMessage(message);
          break;
          
        case 'SUBSCRIBE_TO_ROOM':
          await this.handleSubscribeToRoom(message);
          break;
          
        case 'UNSUBSCRIBE_FROM_ROOM':
          await this.handleUnsubscribeFromRoom(message);
          break;

      case 'DELIVER_ROOM_MESSAGE':
        await this.handleDeliverRoomMessage(message);
        break;
      case 'UNSUBSCRIBE_FROM_ROOM':
        await this.handleCrossNodeUnsubscribe(message);
        break;        default:
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
    const isNewRoom = !room;
    
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
      
      // Persist room creation
      await this.persistRoomUpdate(room, 'CREATE');
    }

    // Add participant
    room.participants.add(userId);
    room.lastActivity = Date.now();

    // Persist room update for participant addition
    if (!isNewRoom) {
      await this.persistRoomUpdate(room, 'UPDATE');
    }

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

    // Persist room update for participant removal
    await this.persistRoomUpdate(room, 'UPDATE');

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

    const chatMessage: ChatMessageEntity = {
      id: messageId,
      roomId,
      userId,
      content,
      timestamp: Date.now(),
      nodeId: this.nodeId
    };

    console.log(`💬 Message from ${userId} in room ${roomId}: ${content}`);

    // 1. Wrap message in ResourceOperation envelope
    const operation = this.wrapMessageInEnvelope(chatMessage, messageId);
    if (operation) {
      // 2. Persist message to WAL before distribution
      const walSequence = await this.persistMessageToWAL(operation);
      console.log(`📝 Persisted message ${messageId} to WAL with sequence ${walSequence}`);

      // 3. Route message using cluster fanout router
      await this.routeMessage(operation);
    } else {
      // Fallback to original broadcast method
      await this.broadcastToRoomSubscribers(roomId, {
        id: `chat-${messageId}`,
        type: 'CHAT_MESSAGE',
        payload: chatMessage,
        timestamp: Date.now(),
        sourceNodeId: this.nodeId
      });
    }

    // Update room state after message processing
    room.messageCount++;
    room.lastActivity = Date.now();

    // Persist room update for message count increment
    await this.persistRoomUpdate(room, 'UPDATE');

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
   * Handle delivery of room messages from other nodes
   */
  private async handleDeliverRoomMessage(message: ClusterMessage): Promise<void> {
    const { roomId, message: roomMessage, targetParticipants, sourceNode } = message.payload;
    
    console.log(`📬 Delivering cross-node message for room ${roomId} from node ${sourceNode} to ${targetParticipants.length} local participants`);
    
    // Deliver to local participants
    await this.deliverMessageLocally(roomId, roomMessage, targetParticipants);
    
    this.emit('cross-node-message-delivered', {
      roomId,
      messageId: roomMessage.id,
      sourceNode,
      participantCount: targetParticipants.length,
      timestamp: Date.now()
    });
  }

  /**
   * Handle cross-node client unsubscribe
   */
  private async handleCrossNodeUnsubscribe(message: any): Promise<void> {
    try {
      const { roomId, clientId, fromNode, crossNodeDisconnection } = message.payload;

      if (!this.ownsRoom(roomId)) {
        console.warn(`⚠️ Received cross-node unsubscribe for non-owned room ${roomId}`);
        return;
      }

      // Remove from local client subscriptions if exists
      const clientSubs = this.clientSubscriptions.get(clientId);
      if (clientSubs) {
        const roomIndex = clientSubs.findIndex(sub => sub.roomId === roomId);
        if (roomIndex >= 0) {
          clientSubs.splice(roomIndex, 1);
          
          if (clientSubs.length === 0) {
            this.clientSubscriptions.delete(clientId);
          }
        }
      }

      this.emit('cross-node-client-unsubscribed', {
        clientId,
        roomId,
        fromNode,
        crossNodeDisconnection,
        timestamp: Date.now()
      });

      console.log(`🔌 Handled cross-node unsubscribe for client ${clientId} from room ${roomId} (from node: ${fromNode})`);

    } catch (error) {
      console.error('❌ Failed to handle cross-node unsubscribe:', error);
    }
  }

  /**
   * Broadcast message to all subscribers of a room
   */
  private async broadcastToRoomSubscribers(roomId: string, message: ClusterMessage): Promise<void> {
    // If we have fanout router, use it for proper placement-based routing
    if (this.fanoutRouter && message.payload) {
      try {
        // Convert message to ResourceOperation for routing
        const operation = this.wrapMessageInEnvelope(message.payload, message.id || `msg-${Date.now()}`);
        if (operation) {
          await this.routeMessage(operation);
          return;
        }
      } catch (error) {
        console.error('Failed to route via fanout router, falling back:', error);
      }
    }

    // Fallback: Use the enhanced cross-node routing for better message delivery
    await this.routeMessageToParticipants(roomId, message);

    // Also handle traditional subscriptions for backward compatibility
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
    try {
      // 1. Use ApplicationRegistry to find which node owns the room
      if (!this.applicationRegistry) {
        console.warn(`⚠️ No ApplicationRegistry available, falling back to event emission for room ${roomId}`);
        this.emit('forward-message', { roomId, message });
        return;
      }

      // Find room across cluster using ApplicationRegistry
      const room = await this.applicationRegistry.findResourceByName('chat-room', roomId);
      
      if (!room) {
        console.warn(`⚠️ Room ${roomId} not found in cluster, cannot forward message`);
        return;
      }

      const ownerNodeId = room.nodeId;
      
      if (ownerNodeId === this.nodeId) {
        console.warn(`⚠️ Room ${roomId} is owned by current node, should not forward`);
        return;
      }

      // 2. Send message directly to that node via transport
      console.log(`🚀 Forwarding message ${message.type} for room ${roomId} to owner node ${ownerNodeId}`);
      
      await this.transport.sendToNode(ownerNodeId, {
        id: `forwarded-${message.id}`,
        type: message.type,
        payload: {
          ...message.payload,
          forwardedFrom: this.nodeId,
          originalMessageId: message.id
        },
        timestamp: Date.now(),
        sourceNodeId: this.nodeId
      });

      // 3. Handle response/acknowledgment
      this.emit('message-forwarded', { 
        roomId, 
        messageId: message.id, 
        targetNode: ownerNodeId 
      });

    } catch (error) {
      console.error(`❌ Failed to forward message for room ${roomId}:`, error);
      this.emit('message-forward-error', { roomId, messageId: message.id, error });
    }
  }

  /**
   * Establish cross-node room connection for a client
   */
  public async establishCrossNodeRoomConnection(clientId: string, room: ChatRoomResource): Promise<void> {
    try {
      const roomId = room.resourceId;
      const ownerNodeId = room.nodeId;

      console.log(`🌐 Establishing cross-node connection for client ${clientId} to room ${roomId} on node ${ownerNodeId}`);

      // 1. Register client subscription on the room owner node
      if (ownerNodeId !== this.nodeId) {
        await this.transport.sendToNode(ownerNodeId, {
          id: `cross-node-subscribe-${Date.now()}`,
          type: 'SUBSCRIBE_TO_ROOM',
          payload: {
            roomId,
            clientId,
            fromNode: this.nodeId,
            crossNodeConnection: true
          },
          timestamp: Date.now(),
          sourceNodeId: this.nodeId
        });
      }

      // 2. Set up message routing from owner node to client's node
      // Track this client as a cross-node participant
      if (!this.crossNodeParticipants.has(roomId)) {
        this.crossNodeParticipants.set(roomId, new Map());
      }
      this.crossNodeParticipants.get(roomId)!.set(clientId, ownerNodeId);

      // 3. Track cross-node room membership
      this.emit('cross-node-connection-established', {
        clientId,
        roomId,
        clientNode: this.nodeId,
        roomOwnerNode: ownerNodeId,
        timestamp: Date.now()
      });

      console.log(`✅ Cross-node connection established for client ${clientId} to room ${roomId}`);

    } catch (error) {
      console.error(`❌ Failed to establish cross-node connection for client ${clientId}:`, error);
      this.emit('cross-node-connection-error', { clientId, roomId: room.resourceId, error });
      throw error;
    }
  }

  /**
   * Route messages to participants across multiple nodes
   */
  private async routeMessageToParticipants(roomId: string, message: any): Promise<void> {
    try {
      // 1. Get all participants across all nodes for this room
      const localParticipants = this.ownedRooms.get(roomId)?.participants || new Set();
      const crossNodeParticipants = this.crossNodeParticipants.get(roomId) || new Map();

      // 2. Group participants by their connected nodes
      const participantsByNode = new Map<string, string[]>();

      // Add local participants
      if (localParticipants.size > 0) {
        participantsByNode.set(this.nodeId, Array.from(localParticipants));
      }

      // Add cross-node participants
      for (const [clientId, nodeId] of crossNodeParticipants) {
        if (!participantsByNode.has(nodeId)) {
          participantsByNode.set(nodeId, []);
        }
        participantsByNode.get(nodeId)!.push(clientId);
      }

      // 3. Send messages to each node for local delivery
      for (const [nodeId, participants] of participantsByNode) {
        if (nodeId === this.nodeId) {
          // Handle local delivery directly
          await this.deliverMessageLocally(roomId, message, participants);
        } else {
          // Send to remote node for delivery
          await this.transport.sendToNode(nodeId, {
            id: `cross-node-delivery-${Date.now()}`,
            type: 'DELIVER_ROOM_MESSAGE',
            payload: {
              roomId,
              message,
              targetParticipants: participants,
              sourceNode: this.nodeId
            },
            timestamp: Date.now(),
            sourceNodeId: this.nodeId
          });
        }
      }

      this.emit('message-routed-cross-node', {
        roomId,
        messageId: message.id,
        totalNodes: participantsByNode.size,
        totalParticipants: Array.from(participantsByNode.values()).flat().length
      });

    } catch (error) {
      console.error(`❌ Failed to route message to participants for room ${roomId}:`, error);
      this.emit('message-routing-error', { roomId, messageId: message.id, error });
    }
  }

  /**
   * Deliver message to local participants
   */
  private async deliverMessageLocally(roomId: string, message: any, participants: string[]): Promise<void> {
    try {
      console.log(`📤 Delivering message locally to ${participants.length} participants in room ${roomId}`);

      let successCount = 0;
      let errorCount = 0;
      let failedDeliveries: string[] = [];

      // If we have a client connection manager (e.g., ClientWebSocketAdapter), use it directly
      if (this.clientConnectionManager && typeof this.clientConnectionManager.sendToClient === 'function') {
        
        for (const participantId of participants) {
          try {
            // Try to get the WebSocket client ID for this participant
            const websocketClientId = this.clientWebSocketMap.get(participantId) || participantId;
            
            const success = this.clientConnectionManager.sendToClient(websocketClientId, {
              type: 'ROOM_MESSAGE',
              data: {
                roomId,
                message,
                participantId,
                timestamp: Date.now()
              }
            });

            if (success) {
              successCount++;
              console.log(`✅ Message sent to participant ${participantId} (WebSocket: ${websocketClientId})`);
            } else {
              errorCount++;
              failedDeliveries.push(participantId);
              console.warn(`⚠️ Failed to send message to participant ${participantId} (WebSocket: ${websocketClientId}) - client not connected`);
            }
          } catch (error) {
            errorCount++;
            failedDeliveries.push(participantId);
            console.error(`❌ Error sending message to participant ${participantId}:`, error);
          }
        }

        console.log(`✅ Local message delivery completed: ${successCount} successful, ${errorCount} failed`);
        
        this.emit('local-delivery-completed', {
          roomId,
          messageId: message.id,
          totalParticipants: participants.length,
          successCount,
          errorCount,
          failedDeliveries,
          timestamp: Date.now()
        });

      } else {
        // Fallback: Emit events for the application layer to handle
        console.log(`📡 No direct client connection manager, emitting events for application layer`);
        failedDeliveries = [...participants]; // All deliveries are "failed" - handled by events

        this.emit('deliver-message-locally', {
          roomId,
          message,
          participants,
          timestamp: Date.now()
        });

        // Also emit individual participant events for fine-grained handling
        for (const participantId of participants) {
          this.emit('deliver-to-participant', {
            roomId,
            participantId,
            message,
            timestamp: Date.now()
          });
        }

        console.log(`✅ Local message delivery events emitted for room ${roomId}`);
      }

      // Emit delivery stats for monitoring
      this.emit('message-delivery-stats', {
        roomId,
        messageId: message.id,
        totalParticipants: participants.length,
        delivered: successCount,
        failed: errorCount,
        hasDirectDelivery: !!this.clientConnectionManager,
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error(`❌ Failed to deliver message locally for room ${roomId}:`, error);
      this.emit('message-delivery-error', { roomId, participants, message, error });
    }
  }

  /**
   * Check if this node owns a specific room
   */
  private ownsRoom(roomId: string): boolean {
    return this.ownedRooms.has(roomId);
  }

  /**
   * Remove cross-node connection for a client
   */
  public async removeCrossNodeRoomConnection(clientId: string, roomId: string): Promise<void> {
    try {
      const crossNodeClients = this.crossNodeParticipants.get(roomId);
      if (!crossNodeClients || !crossNodeClients.has(clientId)) {
        return; // Client not in cross-node tracking
      }

      const ownerNodeId = crossNodeClients.get(clientId);
      crossNodeClients.delete(clientId);

      // Clean up empty room tracking
      if (crossNodeClients.size === 0) {
        this.crossNodeParticipants.delete(roomId);
      }

      // Notify the room owner node about client disconnection
      if (ownerNodeId && ownerNodeId !== this.nodeId) {
        await this.transport.sendToNode(ownerNodeId, {
          id: `cross-node-unsubscribe-${Date.now()}`,
          type: 'UNSUBSCRIBE_FROM_ROOM',
          payload: {
            roomId,
            clientId,
            fromNode: this.nodeId,
            crossNodeDisconnection: true
          },
          timestamp: Date.now(),
          sourceNodeId: this.nodeId
        });
      }

      this.emit('cross-node-connection-removed', {
        clientId,
        roomId,
        ownerNode: ownerNodeId,
        timestamp: Date.now()
      });

      console.log(`🔌 Removed cross-node connection for client ${clientId} from room ${roomId}`);

    } catch (error) {
      console.error(`❌ Failed to remove cross-node connection for client ${clientId}:`, error);
      this.emit('cross-node-disconnection-error', { clientId, roomId, error });
    }
  }

  /**
   * Load rooms for a range from persistent storage
   */
  private async loadRoomsForRange(rangeId: RangeId): Promise<void> {
    if (!this.enablePersistence) {
      console.log(`🔄 Loading rooms for range ${rangeId} (in-memory mode)`);
      return;
    }

    try {
      this.emit('loading-rooms-for-range', { rangeId, nodeId: this.nodeId });
      
      // Open WAL file and read all entries
      await this.walFile.open();
      const entries = await this.walFile.readEntries();
      
      let roomsLoaded = 0;
      
      // Replay WAL entries to reconstruct room state
      for (const entry of entries) {
        const update = entry.data as ChatRoomEntityUpdate;
        
        // Only process entries for this range
        if (update.metadata?.rangeId !== rangeId) continue;
        
        // Skip deleted rooms
        if (update.operation === 'DELETE') {
          this.ownedRooms.delete(update.metadata.roomId);
          this.roomToRange.delete(update.metadata.roomId);
          continue;
        }
        
        // Reconstruct room from WAL entry
        const room: ChatRoomEntity = {
          id: update.metadata.roomId,
          name: update.metadata.roomName,
          participants: new Set(update.metadata.participants || []),
          messageCount: update.metadata.messageCount || 0,
          lastActivity: update.metadata.lastActivity || Date.now(),
          ownerNode: update.ownerNodeId || this.nodeId
        };
        
        this.ownedRooms.set(room.id, room);
        this.roomToRange.set(room.id, rangeId);
        roomsLoaded++;
      }
      
      console.log(`🔄 Loaded ${roomsLoaded} rooms for range ${rangeId} from WAL`);
      
      // Broadcast range acquisition to cluster
      await this.broadcastRangeEvent('RANGE_ACQUIRED', {
        rangeId,
        nodeId: this.nodeId,
        roomCount: roomsLoaded,
        timestamp: Date.now()
      });
      
      this.emit('rooms-loaded-for-range', { rangeId, roomCount: roomsLoaded });
    } catch (error) {
      console.error(`❌ Failed to load rooms for range ${rangeId}:`, error);
      this.emit('rooms-load-error', { rangeId, error });
    }
  }

  /**
   * Transfer room ownership when leaving a range
   */
  private async transferRoomsForRange(rangeId: RangeId): Promise<void> {
    try {
      console.log(`🔄 Transferring rooms for range ${rangeId} from node ${this.nodeId}`);
      
      const roomsToTransfer = Array.from(this.ownedRooms.entries())
        .filter(([roomId, room]) => this.roomToRange.get(roomId) === rangeId);
      
      this.emit('transferring-rooms-for-range', { rangeId, roomCount: roomsToTransfer.length });
      
      for (const [roomId, room] of roomsToTransfer) {
        // Persist room transfer to WAL
        await this.persistRoomUpdate(room, 'TRANSFER', rangeId);
        
        // Broadcast room transfer event to cluster
        await this.broadcastRoomStateChange('ROOM_TRANSFERRING', {
          roomId,
          currentOwner: this.nodeId,
          targetOwner: 'TBD', // Would be determined by cluster coordination
          room: room,
          timestamp: Date.now()
        });
      }
      
      // Broadcast range release to cluster
      await this.broadcastRangeEvent('RANGE_RELEASED', {
        rangeId,
        nodeId: this.nodeId,
        transferredRoomCount: roomsToTransfer.length,
        timestamp: Date.now()
      });
      
      console.log(`🔄 Transferred ${roomsToTransfer.length} rooms for range ${rangeId}`);
      this.emit('rooms-transferred-for-range', { rangeId, roomCount: roomsToTransfer.length });
    } catch (error) {
      console.error(`❌ Failed to transfer rooms for range ${rangeId}:`, error);
      this.emit('rooms-transfer-error', { rangeId, error });
    }
  }

  /**
   * Get the range ID for a room
   */
  private getRangeForRoom(roomId: string): string {
    return this.roomToRange.get(roomId) || 'unknown-range';
  }

  /**
   * Persist room state changes to WAL
   */
  private async persistRoomUpdate(
    room: ChatRoomEntity, 
    operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'TRANSFER',
    rangeId?: string
  ): Promise<void> {
    if (!this.enablePersistence) return;

    try {
      const actualRangeId = rangeId || this.getRangeForRoom(room.id);
      
      const update: ChatRoomEntityUpdate = {
        entityId: `room-${room.name}-${this.nodeId}`,
        ownerNodeId: this.nodeId,
        version: 1, // Add version property as required by EntityUpdate
        timestamp: Date.now(),
        operation,
        metadata: {
          roomId: room.id,
          roomName: room.name,
          participants: Array.from(room.participants),
          messageCount: room.messageCount,
          lastActivity: room.lastActivity,
          rangeId: actualRangeId,
          createdAt: Date.now()
        }
      };

      const entry = this.walCoordinator.createEntry(update);
      await this.walFile.append(entry);
      
      // Emit persistence event for monitoring
      this.emit('room-persisted', { roomId: room.id, operation, rangeId: actualRangeId });
    } catch (error) {
      console.error(`❌ Failed to persist room update for ${room.id}:`, error);
      this.emit('room-persistence-error', { roomId: room.id, operation, error });
    }
  }

  /**
   * Broadcast range-level events to the cluster
   */
  private async broadcastRangeEvent(eventType: string, payload: any): Promise<void> {
    try {
      const rangeMessage: ClusterMessage = {
        id: `range-event-${Date.now()}-${Math.random()}`,
        type: 'RANGE_EVENT',
        payload: {
          eventType,
          ...payload
        },
        timestamp: Date.now(),
        sourceNodeId: this.nodeId
      };

      // Broadcast to all nodes via transport
      await this.transport.broadcast(rangeMessage);
      this.emit('range-event-broadcasted', { eventType, payload });
    } catch (error) {
      console.error(`❌ Failed to broadcast range event ${eventType}:`, error);
      this.emit('range-event-broadcast-error', { eventType, error });
    }
  }

  /**
   * Broadcast room state changes to interested nodes
   */
  private async broadcastRoomStateChange(eventType: string, payload: any): Promise<void> {
    try {
      const stateMessage: ClusterMessage = {
        id: `room-state-${Date.now()}-${Math.random()}`,
        type: 'ROOM_STATE_CHANGE',
        payload: {
          eventType,
          ...payload
        },
        timestamp: Date.now(),
        sourceNodeId: this.nodeId
      };

      // Broadcast to all nodes
      await this.transport.broadcast(stateMessage);
      this.emit('room-state-change-broadcasted', { eventType, payload });
    } catch (error) {
      console.error(`❌ Failed to broadcast room state change ${eventType}:`, error);
      this.emit('room-state-change-broadcast-error', { eventType, error });
    }
  }

  /**
   * Enhanced room event broadcasting - Create room with cluster notification
   */
  async createRoomWithBroadcast(roomData: {
    id: string;
    name: string;
    isPublic: boolean;
    maxParticipants: number;
  }): Promise<ChatRoomEntity> {
    const room: ChatRoomEntity = {
      id: roomData.id,
      name: roomData.name,
      participants: new Set(),
      messageCount: 0,
      lastActivity: Date.now(),
      ownerNode: this.nodeId
    };

    // Store locally
    this.ownedRooms.set(room.id, room);
    this.roomToRange.set(room.id, 'default-range'); // Simplified

    // Broadcast room creation to cluster
    await this.broadcastRoomStateChange('ROOM_CREATED', {
      roomId: room.id,
      room: room,
      isPublic: roomData.isPublic,
      maxParticipants: roomData.maxParticipants,
      ownerNode: this.nodeId,
      timestamp: Date.now()
    });

    this.emit('room-created-with-broadcast', room);
    return room;
  }

  /**
   * Enhanced room event broadcasting - Update room state with cluster sync
   */
  async updateRoomStateWithBroadcast(roomId: string, updates: Partial<ChatRoomEntity>): Promise<void> {
    const room = this.ownedRooms.get(roomId);
    if (!room) {
      throw new Error(`Room ${roomId} not found on node ${this.nodeId}`);
    }

    // Apply updates
    Object.assign(room, updates);
    room.lastActivity = Date.now();

    // Broadcast state update
    await this.broadcastRoomStateChange('ROOM_UPDATED', {
      roomId,
      room: room,
      updates,
      ownerNode: this.nodeId,
      timestamp: Date.now()
    });

    this.emit('room-state-updated-with-broadcast', { roomId, updates });
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
   * Set the client connection manager for direct message delivery
   */
  public setClientConnectionManager(manager: any): void {
    this.clientConnectionManager = manager;
    console.log(`🔌 Client connection manager set for ChatRoomCoordinator on node ${this.nodeId}`);
    this.emit('client-connection-manager-set', { nodeId: this.nodeId });
  }

  /**
   * Map room participant to WebSocket client ID
   * This allows the system to route messages to the correct WebSocket connection
   */
  public mapParticipantToWebSocket(participantId: string, websocketClientId: string): void {
    this.clientWebSocketMap.set(participantId, websocketClientId);
    console.log(`🔗 Mapped participant ${participantId} to WebSocket client ${websocketClientId}`);
    
    this.emit('participant-websocket-mapped', {
      participantId,
      websocketClientId,
      nodeId: this.nodeId,
      timestamp: Date.now()
    });
  }

  /**
   * Remove participant mapping when client disconnects
   */
  public removeParticipantMapping(participantId: string): void {
    const websocketClientId = this.clientWebSocketMap.get(participantId);
    this.clientWebSocketMap.delete(participantId);
    
    if (websocketClientId) {
      console.log(`🔌 Removed mapping for participant ${participantId} (was WebSocket client ${websocketClientId})`);
      
      this.emit('participant-websocket-unmapped', {
        participantId,
        websocketClientId,
        nodeId: this.nodeId,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Get WebSocket client ID for a participant
   */
  public getWebSocketClientId(participantId: string): string | undefined {
    return this.clientWebSocketMap.get(participantId);
  }

  /**
   * Get all participant mappings
   */
  public getParticipantMappings(): Map<string, string> {
    return new Map(this.clientWebSocketMap);
  }

  /**
   * Get room subscribers (public API)
   */
  public getRoomSubscribers(roomId: string): ClientSubscription[] {
    return this.clientSubscriptions.get(roomId) || [];
  }

  /**
   * Wrap message in ResourceOperation envelope
   */
  public wrapMessageInEnvelope(
    message: ChatMessageEntity, 
    correlationId: string
  ): ResourceOperation<ChatMessageEntity> | null {
    if (!this.envelopeManager) {
      console.warn('No envelope manager configured - message wrapping skipped');
      return null;
    }

    try {
      const operation = this.envelopeManager.wrapOperation(
        message.roomId,
        'CREATE',
        message,
        { 
          correlationId,
          traceId: correlationId,
          spanId: `span-${Date.now()}`,
          baggage: {}
        }
      );

      // Convert to our ResourceOperation interface if needed
      if (operation) {
        return {
          opId: operation.opId,
          resourceId: operation.resourceId,
          type: 'CREATE',
          version: 1,
          timestamp: operation.timestamp,
          originNodeId: operation.originNodeId,
          payload: operation.payload,
          leaseTerm: 1, // Add required leaseTerm property
          vectorClock: {
            nodeId: this.nodeId,
            vector: new Map([[this.nodeId, 1]]),
            increment: function() { return this; },
            compare: function() { return 0; },
            merge: function() { return this; }
          },
          correlationId: operation.correlationId
        };
      }

      return null;
    } catch (error) {
      console.error('Failed to wrap message in envelope:', error);
      return null;
    }
  }

  /**
   * Persist message to WAL
   */
  public async persistMessageToWAL(
    operation: ResourceOperation<ChatMessageEntity>
  ): Promise<number | null> {
    if (!this.enablePersistence) {
      return null;
    }

    try {
      // Convert to proper EntityUpdate format
      const entityUpdate: EntityUpdate = {
        entityId: `message-${operation.opId}`,
        operation: 'CREATE',
        version: operation.version,
        timestamp: operation.timestamp,
        metadata: {
          operation: operation,
          messageData: operation.payload
        }
      };

      const walEntry: WALEntry = {
        id: `wal-message-${operation.opId}`,
        type: 'CHAT_MESSAGE',
        ownerNodeId: this.nodeId,
        logSequenceNumber: Date.now(), // Will be assigned by WAL
        timestamp: Date.now(),
        data: entityUpdate,
        checksum: ''
      };

      // Use walFile directly
      await this.walFile.append(walEntry);
      return walEntry.logSequenceNumber;
    } catch (error) {
      console.error('Failed to persist message to WAL:', error);
      return null;
    }
  }

  /**
   * Route message using cluster fanout router
   */
  public async routeMessage(
    operation: ResourceOperation<ChatMessageEntity>
  ): Promise<void> {
    if (!this.fanoutRouter) {
      console.warn('No fanout router configured - using fallback routing');
      // Fallback to existing cluster broadcast
      await this.broadcastToRoomSubscribers(operation.resourceId, {
        id: operation.opId,
        type: 'CHAT_MESSAGE',
        payload: operation.payload,
        timestamp: operation.timestamp,
        sourceNodeId: this.nodeId
      });
      return;
    }

    try {
      const routes = await this.fanoutRouter.route(operation.resourceId, {
        preferPrimary: true,
        replicationFactor: 2,
        useGossipFallback: true
      });
      await this.fanoutRouter.fanout(operation.resourceId, operation);
      
      console.log(`🧭 Routed message ${operation.opId} to ${routes.length} cluster routes`);
    } catch (error) {
      console.error('Failed to route message via fanout router:', error);
      // Fallback to existing broadcast
      await this.broadcastToRoomSubscribers(operation.resourceId, {
        id: operation.opId,
        type: 'CHAT_MESSAGE',
        payload: operation.payload,
        timestamp: operation.timestamp,
        sourceNodeId: this.nodeId
      });
    }
  }

  /**
   * Shutdown coordinator
   */
  public async shutdown(): Promise<void> {
    this.isActive = false;
    
    // Close WAL file if persistence is enabled
    if (this.enablePersistence && this.walFile) {
      try {
        await this.walFile.close();
      } catch (error) {
        console.error(`❌ Error closing WAL file during shutdown:`, error);
      }
    }
    
    this.ownedRooms.clear();
    this.roomToRange.clear();
    this.clientSubscriptions.clear();
    // Note: removeAllListeners() not available in current EventEmitter setup
  }
}
