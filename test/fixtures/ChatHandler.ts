import {
  RangeHandler,
  ClusterMessage,
  ClusterInfo,
  RangeId
} from '../../src/coordinators/types';

/**
 * Example chat handler that demonstrates how to implement a range-based service.
 * 
 * This handler manages chat rooms/channels assigned to specific ranges,
 * allowing for horizontal scaling of chat services across multiple nodes.
 */
export class ChatHandler implements RangeHandler {
  private activeRooms = new Map<string, Set<string>>(); // room -> users
  private messageHistory = new Map<string, ClusterMessage[]>(); // room -> messages
  private rangeRooms = new Map<RangeId, Set<string>>(); // range -> rooms
  private isActive = true; // Track if handler is still active
  private enableLogging: boolean;

  constructor() {
    // Disable logging in test mode for cleaner output
    this.enableLogging = process.env.NODE_ENV !== 'test';
  }

  private log(...args: any[]): void {
    if (this.enableLogging) {
      console.log(...args);
    }
  }

  private error(...args: any[]): void {
    if (this.enableLogging) {
      console.error(...args);
    }
  }

  async onJoin(rangeId: RangeId, clusterInfo: ClusterInfo): Promise<void> {
    if (!this.isActive) return;
    
    this.log(`💬 ChatHandler: Joined range ${rangeId}`);
    this.log(`📊 Cluster info: ${clusterInfo.members.length} members, ${clusterInfo.totalRanges} total ranges`);
    
    // Initialize range-specific state
    this.rangeRooms.set(rangeId, new Set());
    
    // Load data for this range (in production, from database)
    await this.loadRangeData(rangeId);
    
    if (this.isActive) {
      this.log(`✅ ChatHandler: Ready to handle range ${rangeId}`);
    }
  }

  async onMessage(message: ClusterMessage): Promise<void> {
    this.log(`📨 ChatHandler: Processing message ${message.id} of type ${message.type}`);
    
    try {
      switch (message.type) {
        case 'SEND_CHAT':
          await this.handleChatMessage(message);
          break;
          
        case 'JOIN_ROOM':
          await this.handleJoinRoom(message);
          break;
          
        case 'LEAVE_ROOM':
          await this.handleLeaveRoom(message);
          break;
          
        case 'GET_ROOM_HISTORY':
          await this.handleGetHistory(message);
          break;
          
        default:
          this.log(`⚠️ ChatHandler: Unknown message type ${message.type}`);
      }
    } catch (error) {
      this.error(`❌ ChatHandler: Error processing message ${message.id}:`, error);
    }
  }

  async onLeave(rangeId: RangeId): Promise<void> {
    this.log(`👋 ChatHandler: Leaving range ${rangeId}`);
    
    // Mark as inactive to prevent further operations
    this.isActive = false;
    
    // Flush any pending data (in production, to database)
    await this.flushRangeData(rangeId);
    
    // Clean up range-specific state
    const rooms = this.rangeRooms.get(rangeId);
    if (rooms) {
      for (const roomId of rooms) {
        this.activeRooms.delete(roomId);
        this.messageHistory.delete(roomId);
      }
      this.rangeRooms.delete(rangeId);
    }
    
    this.log(`✅ ChatHandler: Range ${rangeId} cleanup completed`);
  }

  async onTopologyChange(clusterInfo: ClusterInfo): Promise<void> {
    this.log(`🔄 ChatHandler: Topology changed - ${clusterInfo.members.length} members`);
    this.log(`📊 Assigned ranges: ${clusterInfo.assignedRanges.join(', ')}`);
    
    // Optionally rebalance room assignments or update routing tables
    await this.updateRoutingTable(clusterInfo);
  }

  private async handleChatMessage(message: ClusterMessage): Promise<void> {
    const { roomId, userId, text } = message.payload;
    
    if (!this.activeRooms.has(roomId)) {
      this.log(`⚠️ Room ${roomId} not found, creating it`);
      this.activeRooms.set(roomId, new Set());
      this.messageHistory.set(roomId, []);
    }
    
    // Store message
    const history = this.messageHistory.get(roomId)!;
    history.push({
      ...message,
      timestamp: Date.now()
    });
    
    // Keep only last 100 messages in memory
    if (history.length > 100) {
      history.splice(0, history.length - 100);
    }
    
    this.log(`💬 Stored chat message in room ${roomId} from user ${userId}: "${text}"`);
    
    // In production, you would broadcast to connected users
    await this.broadcastToRoom(roomId, message);
  }

  private async handleJoinRoom(message: ClusterMessage): Promise<void> {
    const { roomId, userId } = message.payload;
    
    if (!this.activeRooms.has(roomId)) {
      this.activeRooms.set(roomId, new Set());
      this.messageHistory.set(roomId, []);
    }
    
    this.activeRooms.get(roomId)!.add(userId);
    this.log(`👥 User ${userId} joined room ${roomId}`);
  }

  private async handleLeaveRoom(message: ClusterMessage): Promise<void> {
    const { roomId, userId } = message.payload;
    
    if (this.activeRooms.has(roomId)) {
      this.activeRooms.get(roomId)!.delete(userId);
      this.log(`👋 User ${userId} left room ${roomId}`);
    }
  }

  private async handleGetHistory(message: ClusterMessage): Promise<void> {
    const { roomId } = message.payload;
    
    const history = this.messageHistory.get(roomId) || [];
    this.log(`📜 Retrieved ${history.length} messages for room ${roomId}`);
    
    // In production, you would send this back to the requesting client
  }

  private async loadRangeData(rangeId: RangeId): Promise<void> {
    // Simulate loading from database
    this.log(`📥 Loading chat data for range ${rangeId}...`);
    
    // In production, this would query the database for:
    // - Active rooms in this range
    // - Recent message history
    // - User presence data
    
    await new Promise(resolve => setTimeout(resolve, 100)); // Simulate async load
    this.log(`✅ Chat data loaded for range ${rangeId}`);
  }

  private async flushRangeData(rangeId: RangeId): Promise<void> {
    // Simulate saving to database
    this.log(`📤 Flushing chat data for range ${rangeId}...`);
    
    // In production, this would persist:
    // - Any pending messages
    // - Room state
    // - User presence updates
    
    await new Promise(resolve => setTimeout(resolve, 100)); // Simulate async save
    this.log(`✅ Chat data flushed for range ${rangeId}`);
  }

  private async broadcastToRoom(roomId: string, message: ClusterMessage): Promise<void> {
    const users = this.activeRooms.get(roomId);
    if (users && users.size > 0) {
      this.log(`📡 Broadcasting message to ${users.size} users in room ${roomId}`);
      
      // In production, this would send the message to all connected users
      // through WebSocket connections, server-sent events, etc.
    }
  }

  private async updateRoutingTable(clusterInfo: ClusterInfo): Promise<void> {
    // Update internal routing based on cluster topology
    this.log(`🗺️ Updating routing table with ${clusterInfo.members.length} cluster members`);
    
    // In production, this might update:
    // - Which ranges handle which room ID hashes
    // - Cross-node message routing
    // - Load balancing parameters
  }

  /**
   * Get statistics about this handler's current state
   */
  getStats() {
    const totalRooms = this.activeRooms.size;
    const totalUsers = Array.from(this.activeRooms.values())
      .reduce((sum, users) => sum + users.size, 0);
    const totalMessages = Array.from(this.messageHistory.values())
      .reduce((sum, history) => sum + history.length, 0);

    return {
      totalRooms,
      totalUsers,
      totalMessages,
      rangeCount: this.rangeRooms.size
    };
  }
}
