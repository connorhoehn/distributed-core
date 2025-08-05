import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import WebSocket from 'ws';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { ClientWebSocketAdapter } from '../../../src/transport/adapters/ClientWebSocketAdapter';
import { ChatRoomCoordinator } from './ChatRoomCoordinator';
import { NodeId, Message, MessageType } from '../../../src/types';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';

// Chat room interface from distributed coordinator system
interface ChatRoom {
  id: string;
  name: string;
  participants: Set<string>;
  messageHistory: ChatMessage[];
  lastActivity: number;
  nodeId: string;
}

// Chat message structure for external clients
interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  content: string;
  timestamp: number;
  nodeId: string;
}

// Client message types
interface ClientJoinMessage {
  type: 'join-room';
  data: {
    roomId: string;
    userId: string;
  };
}

interface ClientChatMessage {
  type: 'send-message';
  data: {
    roomId: string;
    userId: string;
    content: string;
  };
}

interface ClientLeaveMessage {
  type: 'leave-room';
  data: {
    roomId: string;
    userId: string;
  };
}

type ClientMessage = ClientJoinMessage | ClientChatMessage | ClientLeaveMessage;

/**
 * Chat node that integrates proper distributed coordination with WebSocket transport
 */
class ChatNode {
  private cluster: ClusterManager;
  private clientAdapter: ClientWebSocketAdapter;
  private chatCoordinator: ChatRoomCoordinator;
  private transport: WebSocketAdapter;
  
  constructor(
    private nodeId: NodeId,
    private port: number,
    seeds: NodeId[] = []
  ) {
    // Create WebSocket transport for cluster communication
    this.transport = new WebSocketAdapter(nodeId, { 
      port,
      enableLogging: false 
    });
    
    // Create bootstrap config
    const seedStrings = seeds.map(seed => `${seed.address}:${seed.port}`);
    const config = BootstrapConfig.create({
      seedNodes: seedStrings,
      enableLogging: false,
      gossipInterval: 100,
      failureDetector: {
        enableLogging: false
      }
    });
    
    // Create cluster manager 
    this.cluster = new ClusterManager(nodeId.id, this.transport, config);
    
    // Create client WebSocket adapter for external client connections
    this.clientAdapter = new ClientWebSocketAdapter({
      port: port + 1000, // Use different port for client connections (10001, 10002, 10003)
      enableLogging: false 
    });
    
    // Create chat room coordinator with proper distributed architecture
    this.chatCoordinator = new ChatRoomCoordinator(
      this.cluster,
      this.clientAdapter,
      nodeId.id,
      false // enableLogging
    );
  }
  
  async start(): Promise<void> {
    await this.clientAdapter.start();
    await this.cluster.start();
  }
  
  async stop(): Promise<void> {
    await this.cluster.stop();
    await this.clientAdapter.stop();
  }
  
  async sendChatMessage(roomId: string, userId: string, messageText: string): Promise<void> {
    // First, join the room
    const joinMessage: ClientJoinMessage = {
      type: 'join-room',
      data: {
        roomId,
        userId
      }
    };
    
    // Send join message through client adapter
    this.clientAdapter.emit('client-message', {
      clientId: `test-client-${userId}`,
      message: joinMessage
    });
    
    // Wait a bit for the join to process
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Then send the actual chat message
    const clientMessage: ClientChatMessage = {
      type: 'send-message',
      data: {
        roomId,
        userId,
        content: messageText
      }
    };
    
    // Send through client adapter as if from an external client
    this.clientAdapter.emit('client-message', {
      clientId: `test-client-${userId}`,
      message: clientMessage
    });
  }
  
  getPort(): number {
    return this.port;
  }
  
  getClientPort(): number {
    return this.port + 1000;
  }
  
  getChatRooms(): Map<string, any> {
    return this.chatCoordinator.getOwnedRooms();
  }
  
  getRoomLocations(): Map<string, string> {
    return this.chatCoordinator.getRoomLocations();
  }
}

describe('Chat Room WebSocket E2E Test', () => {
  let node1: ChatNode;
  let node2: ChatNode;
  let node3: ChatNode;
  let client1: WebSocket;
  let client2: WebSocket;
  
  const timeout = 10000;
  
  beforeEach(async () => {
    // Create test nodes
    const nodeId1: NodeId = { id: 'chat-node-1', address: 'localhost', port: 9001 };
    const nodeId2: NodeId = { id: 'chat-node-2', address: 'localhost', port: 9002 };
    const nodeId3: NodeId = { id: 'chat-node-3', address: 'localhost', port: 9003 };
    
    // Create nodes with seed configuration
    node1 = new ChatNode(nodeId1, 9001);
    node2 = new ChatNode(nodeId2, 9002, [nodeId1]);
    node3 = new ChatNode(nodeId3, 9003, [nodeId1]);
    
    // Start cluster
    await node1.start();
    await node2.start();
    await node3.start();
    
    // Wait for cluster formation
    await new Promise(resolve => setTimeout(resolve, 2000));
  }, timeout);
  
  afterEach(async () => {
    // Close WebSocket connections
    if (client1 && client1.readyState === WebSocket.OPEN) {
      client1.close();
    }
    if (client2 && client2.readyState === WebSocket.OPEN) {
      client2.close();
    }
    
    // Stop nodes
    if (node1) await node1.stop();
    if (node2) await node2.stop();
    if (node3) await node3.stop();
  }, timeout);
  
  test('should handle chat room messages across cluster nodes', async () => {
    const roomId = 'test-room-1';
    
    // Send messages from different nodes programmatically
    await node1.sendChatMessage(roomId, 'user1', 'Hello from node 1');
    await node2.sendChatMessage(roomId, 'user2', 'Hello from node 2');
    await node3.sendChatMessage(roomId, 'user3', 'Hello from node 3');
    
    // Wait for gossip propagation
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Verify all nodes have the messages
    const node1Rooms = node1.getChatRooms();
    const node2Rooms = node2.getChatRooms();
    const node3Rooms = node3.getChatRooms();
    
    // Check if at least one node has the room (rooms may be distributed)
    const hasRoomOnAnyNode = node1Rooms.has(roomId) || 
                            node2Rooms.has(roomId) || 
                            node3Rooms.has(roomId);
    
    expect(hasRoomOnAnyNode).toBe(true);
    
    // Count total messages across all nodes
    let totalMessages = 0;
    [node1Rooms, node2Rooms, node3Rooms].forEach(rooms => {
      const room = rooms.get(roomId);
      if (room) {
        totalMessages += room.messageHistory.length;
      }
    });
    
    expect(totalMessages).toBeGreaterThanOrEqual(1);
    
    // Check room locations are tracked
    const roomLocations1 = node1.getRoomLocations();
    const roomLocations2 = node2.getRoomLocations();
    const roomLocations3 = node3.getRoomLocations();
    
    const hasLocationTracking = roomLocations1.has(roomId) || 
                               roomLocations2.has(roomId) || 
                               roomLocations3.has(roomId);
    
    expect(hasLocationTracking).toBe(true);
  }, timeout);
  
  test('should handle WebSocket client connections', async () => {
    // Create WebSocket clients that connect to nodes
    client1 = new WebSocket(`ws://localhost:${node1.getClientPort()}/ws`);
    client2 = new WebSocket(`ws://localhost:${node2.getClientPort()}/ws`);
    
    await Promise.all([
      new Promise(resolve => client1.on('open', resolve)),
      new Promise(resolve => client2.on('open', resolve))
    ]);
    
    // Send messages from WebSocket clients
    const testMessage1 = {
      type: 'join-room',
      data: {
        roomId: 'websocket-room',
        userId: 'websocket-user-1'
      }
    };
    
    const testMessage2 = {
      type: 'send-message',
      data: {
        roomId: 'websocket-room',
        userId: 'websocket-user-1',
        content: 'Hello from WebSocket client'
      }
    };
    
    client1.send(JSON.stringify(testMessage1));
    await new Promise(resolve => setTimeout(resolve, 500));
    client1.send(JSON.stringify(testMessage2));
    
    // Wait for processing and propagation
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Verify messages were processed
    const node1Rooms = node1.getChatRooms();
    const node2Rooms = node2.getChatRooms();
    const node3Rooms = node3.getChatRooms();
    
    // At least one node should have the room
    const hasRoom = node1Rooms.has('websocket-room') || 
                   node2Rooms.has('websocket-room') || 
                   node3Rooms.has('websocket-room');
    
    expect(hasRoom).toBe(true);
    
    // Check room location tracking
    const roomLocations = [
      ...node1.getRoomLocations().entries(),
      ...node2.getRoomLocations().entries(),
      ...node3.getRoomLocations().entries()
    ];
    
    const websocketRoomLocation = roomLocations.find(([roomId]) => roomId === 'websocket-room');
    expect(websocketRoomLocation).toBeDefined();
  }, timeout);
});
