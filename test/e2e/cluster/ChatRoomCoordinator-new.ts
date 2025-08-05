import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { ClientWebSocketAdapter } from '../../../src/transport/adapters/ClientWebSocketAdapter';
import { RangeCoordinator } from '../../../src/coordinators/RangeCoordinator';
import { InMemoryCoordinator } from '../../../src/coordinators/InMemoryCoordinator';
import { ChatRoomHandler } from './ChatRoomHandler';
import { 
  ClusterMessage, 
  ClusterInfo, 
  RangeId 
} from '../../../src/coordinators/types';

/**
 * ChatRoomCoordinator - Orchestrates distributed chat room system
 * Integrates ClusterManager, RangeCoordinator, and ChatRoomHandler
 */
export class ChatRoomCoordinator {
  private clusterManager: ClusterManager;
  private clientAdapter: ClientWebSocketAdapter;
  private chatHandler: ChatRoomHandler;
  private nodeId: string;
  private isStarted = false;
  private enableLogging: boolean;

  constructor(
    clusterManager: ClusterManager,
    clientAdapter: ClientWebSocketAdapter,
    nodeId: string,
    enableLogging: boolean = false
  ) {
    this.clusterManager = clusterManager;
    this.clientAdapter = clientAdapter;
    this.nodeId = nodeId;
    this.enableLogging = enableLogging;

    // Create chat room handler
    this.chatHandler = new ChatRoomHandler(nodeId, clientAdapter, enableLogging);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Handle cluster topology changes
    this.clusterManager.on('membership-updated', (membership: any) => {
      this.handleTopologyChange(membership);
    });

    // Handle client connections
    this.clientAdapter.on('client-connected', ({ clientId }) => {
      this.log(`🔌 Client ${clientId} connected`);
    });

    this.clientAdapter.on('client-disconnected', ({ clientId }) => {
      this.log(`🔌 Client ${clientId} disconnected`);
    });
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    this.log(`🚀 Starting ChatRoomCoordinator for node ${this.nodeId}`);

    // Start cluster manager
    await this.clusterManager.start();
    this.log(`✅ Cluster manager started`);

    // Start client WebSocket adapter
    await this.clientAdapter.start();
    this.log(`✅ Client WebSocket adapter started`);

    this.isStarted = true;
    this.log(`🎉 ChatRoomCoordinator fully started`);
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    this.log(`🛑 Stopping ChatRoomCoordinator for node ${this.nodeId}`);

    // Stop client adapter
    await this.clientAdapter.stop();
    this.log(`✅ Client WebSocket adapter stopped`);

    // Stop cluster manager
    await this.clusterManager.stop();
    this.log(`✅ Cluster manager stopped`);

    this.isStarted = false;
    this.log(`🎉 ChatRoomCoordinator fully stopped`);
  }

  private handleTopologyChange(membership: any): void {
    this.log(`🔄 Cluster topology changed: ${membership.aliveMembers?.length || 0} alive members`);
  }

  // Public API methods

  /**
   * Get the room handler for testing/inspection
   */
  getChatHandler(): ChatRoomHandler {
    return this.chatHandler;
  }

  /**
   * Get room state for a specific room (if this node owns it)
   */
  getRoomState(roomId: string): any {
    return this.chatHandler.getRoomState(roomId);
  }

  /**
   * Get all rooms managed by this node
   */
  getAllRooms(): Map<string, any> {
    return this.chatHandler.getAllRooms();
  }

  /**
   * Get client subscriptions for a room
   */
  getClientSubscriptions(roomId: string): any[] {
    return this.chatHandler.getClientSubscriptions(roomId);
  }

  /**
   * Get cluster membership info
   */
  getClusterMembers(): string[] {
    return this.clusterManager.membership.getAliveMembers().map(m => m.id);
  }

  /**
   * Get node responsible for a room using consistent hashing
   */
  getRoomOwner(roomId: string): string | null {
    return this.clusterManager.hashRing.getNode(roomId);
  }

  /**
   * Send a cluster message (for testing message routing)
   */
  async sendClusterMessage(message: ClusterMessage): Promise<void> {
    // In a real implementation, this would use the cluster's message routing
    // For now, we'll handle it locally if we own the target range
    if (message.targetRangeId && this.chatHandler.getRoomState(message.targetRangeId)) {
      await this.chatHandler.onMessage(message);
    } else {
      this.log(`📤 Would route message ${message.id} to owner of range ${message.targetRangeId}`);
    }
  }

  /**
   * Force a room to be assigned to this node (for testing)
   */
  async acquireRoom(roomId: string): Promise<void> {
    const clusterInfo: ClusterInfo = {
      nodeId: this.nodeId,
      members: this.getClusterMembers(),
      totalRanges: 256,
      assignedRanges: [roomId],
      ringId: 'chat-rooms'
    };

    await this.chatHandler.onJoin(roomId, clusterInfo);
  }

  /**
   * Get connection count
   */
  getConnectionCount(): number {
    return this.clientAdapter.getConnectionCount();
  }

  /**
   * Get connected client IDs
   */
  getConnectedClients(): string[] {
    return this.clientAdapter.getConnectedClients();
  }

  private log(...args: any[]): void {
    if (this.enableLogging) {
      console.log(`[ChatRoomCoordinator:${this.nodeId}]`, ...args);
    }
  }
}
