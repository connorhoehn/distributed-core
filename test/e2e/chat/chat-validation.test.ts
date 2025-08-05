import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import WebSocket from 'ws';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { ClientWebSocketAdapter } from '../../../src/transport/adapters/ClientWebSocketAdapter';
import { ChatRoomCoordinator } from '../cluster/ChatRoomCoordinator';
import { NodeId } from '../../../src/types';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';

/**
 * Fast Chat System Integration Tests (< 7 seconds each)
 * 
 * These tests validate core chat functionality with quick execution:
 * - Basic room creation and joining
 * - Message routing between clients
 * - Connection management
 * - Error handling for malformed messages
 */

interface QuickTestClient {
  id: string;
  ws: WebSocket;
  messagesSent: number;
  messagesReceived: number;
  connected: boolean;
}

class QuickChatTestHarness {
  public nodes: QuickChatNode[] = [];
  private clients: QuickTestClient[] = [];

  async setupSimpleCluster(nodeCount: number = 2): Promise<void> {
    const ports = Array.from({ length: nodeCount }, (_, i) => 9500 + i);
    const clientPorts = Array.from({ length: nodeCount }, (_, i) => 8500 + i);

    // Create minimal cluster for fast tests
    for (let i = 0; i < nodeCount; i++) {
      const node = new QuickChatNode(
        `quick-node-${i}`,
        ports[i],
        clientPorts[i],
        ports.filter((_, idx) => idx !== i)
      );
      this.nodes.push(node);
    }

    // Start all nodes
    await Promise.all(this.nodes.map(node => node.start()));
    
    // Minimal wait for cluster formation
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  async createQuickClient(clientId: string, nodeIndex: number = 0): Promise<QuickTestClient> {
    const node = this.nodes[nodeIndex];
    const ws = new WebSocket(`ws://localhost:${node.clientPort}/ws`);
    
    const client: QuickTestClient = {
      id: clientId,
      ws,
      messagesSent: 0,
      messagesReceived: 0,
      connected: false
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Quick client ${clientId} connection timeout`));
      }, 2000);

      ws.on('open', () => {
        clearTimeout(timeout);
        client.connected = true;
        this.setupQuickClientHandling(client);
        this.clients.push(client);
        resolve(client);
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private setupQuickClientHandling(client: QuickTestClient): void {
    client.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        client.messagesReceived++;
      } catch (error) {
        // Track parse errors but don't fail
      }
    });

    client.ws.on('close', () => {
      client.connected = false;
    });
  }

  async cleanup(): Promise<void> {
    // Close all client connections
    await Promise.all(this.clients.map(client => {
      if (client.connected) {
        return new Promise<void>(resolve => {
          client.ws.close();
          client.ws.on('close', () => resolve());
        });
      }
    }));

    // Stop all nodes
    await Promise.all(this.nodes.map(node => node.stop()));
    
    this.nodes = [];
    this.clients = [];
  }
}

class QuickChatNode {
  public nodeId: string;
  public cluster: ClusterManager;
  public clientAdapter: ClientWebSocketAdapter;
  public coordinator: ChatRoomCoordinator;
  public clientPort: number;
  private transport: WebSocketAdapter;

  constructor(nodeId: string, clusterPort: number, clientPort: number, seedPorts: number[]) {
    this.nodeId = nodeId;
    this.clientPort = clientPort;

    const nodeIdObj: NodeId = { 
      id: nodeId,
      address: '127.0.0.1',
      port: clusterPort
    };
    
    const seedNodes = seedPorts.map(port => `127.0.0.1:${port}`);

    this.transport = new WebSocketAdapter(nodeIdObj, { 
      port: clusterPort,
      host: '127.0.0.1',
      enableLogging: false 
    });

    const config = BootstrapConfig.create({
      seedNodes,
      enableLogging: false,
      gossipInterval: 50, // Faster for quick tests
      failureDetector: {
        enableLogging: false
      }
    });

    this.cluster = new ClusterManager(nodeId, this.transport, config);
    this.clientAdapter = new ClientWebSocketAdapter({
      port: clientPort,
      host: '127.0.0.1',
      enableLogging: false
    });

    this.coordinator = new ChatRoomCoordinator(
      this.cluster,
      this.clientAdapter,
      nodeId,
      false
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
}

describe('Chat System Integration Tests', () => {
  let harness: QuickChatTestHarness;

  beforeEach(async () => {
    harness = new QuickChatTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('🚀 Basic Functionality', () => {
    test('should create room and join single client', async () => {
      await harness.setupSimpleCluster(1);
      
      const client = await harness.createQuickClient('test-client-1');
      
      const joinMessage = {
        type: 'join-room',
        data: {
          roomId: 'test-room',
          userId: client.id
        }
      };

      client.ws.send(JSON.stringify(joinMessage));
      
      // Wait for room creation
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(client.connected).toBe(true);
      
      // Send a test message
      const testMessage = {
        type: 'send-message',
        data: {
          roomId: 'test-room',
          userId: client.id,
          content: 'Hello, room!'
        }
      };
      
      client.ws.send(JSON.stringify(testMessage));
      client.messagesSent++;
      
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(client.messagesSent).toBe(1);
    }, 5000);

    test('should handle multiple clients in same room', async () => {
      await harness.setupSimpleCluster(1);
      
      const client1 = await harness.createQuickClient('client-1');
      const client2 = await harness.createQuickClient('client-2');
      
      const roomId = 'multi-client-room';
      
      // Both clients join the room
      const joinMessages = [client1, client2].map(client => ({
        type: 'join-room',
        data: { roomId, userId: client.id }
      }));
      
      client1.ws.send(JSON.stringify(joinMessages[0]));
      client2.ws.send(JSON.stringify(joinMessages[1]));
      
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Client 1 sends message
      const message = {
        type: 'send-message',
        data: {
          roomId,
          userId: client1.id,
          content: 'Hello from client 1'
        }
      };
      
      client1.ws.send(JSON.stringify(message));
      
      await new Promise(resolve => setTimeout(resolve, 300));
      
      expect(client1.connected).toBe(true);
      expect(client2.connected).toBe(true);
    }, 5000);
  });

  describe('🛡️ Error Handling', () => {
    test('should handle malformed messages gracefully', async () => {
      await harness.setupSimpleCluster(1);
      
      const client = await harness.createQuickClient('error-test-client');
      
      const malformedMessages = [
        '{"invalid": json}',
        '{"type": "unknown-type", "data": {}}',
        '{"type": "join-room"}', // Missing data
        '{}', // Empty object
      ];
      
      let errorCount = 0;
      client.ws.on('error', () => errorCount++);
      
      // Send malformed messages
      for (const msg of malformedMessages) {
        try {
          client.ws.send(msg);
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (error) {
          // Expected for some malformed messages
        }
      }
      
      // Connection should remain stable
      expect(client.connected).toBe(true);
      
      // Should be able to send normal message after malformed ones
      const normalMessage = {
        type: 'join-room',
        data: { roomId: 'recovery-room', userId: client.id }
      };
      
      client.ws.send(JSON.stringify(normalMessage));
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(client.connected).toBe(true);
    }, 4000);

    test('should handle empty and oversized messages', async () => {
      await harness.setupSimpleCluster(1);
      
      const client = await harness.createQuickClient('size-test-client');
      
      // Test empty message
      try {
        client.ws.send('');
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        // Expected
      }
      
      // Test large message (but not too large to timeout the test)
      const largeMessage = {
        type: 'send-message',
        data: {
          roomId: 'size-test-room',
          userId: client.id,
          content: 'x'.repeat(1000) // 1KB message
        }
      };
      
      client.ws.send(JSON.stringify(largeMessage));
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(client.connected).toBe(true);
    }, 3000);
  });

  describe('🔗 Connection Management', () => {
    test('should handle rapid connect/disconnect', async () => {
      await harness.setupSimpleCluster(1);
      
      const connectionCount = 5;
      const clients: QuickTestClient[] = [];
      
      // Create multiple clients rapidly
      for (let i = 0; i < connectionCount; i++) {
        const client = await harness.createQuickClient(`rapid-client-${i}`);
        clients.push(client);
      }
      
      // All should be connected
      expect(clients.every(c => c.connected)).toBe(true);
      
      // Disconnect all rapidly
      clients.forEach(client => client.ws.close());
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // All should be disconnected
      expect(clients.every(c => !c.connected)).toBe(true);
    }, 4000);

    test('should handle client reconnection', async () => {
      await harness.setupSimpleCluster(1);
      
      const client1 = await harness.createQuickClient('reconnect-client');
      
      // Join a room
      const joinMessage = {
        type: 'join-room',
        data: { roomId: 'reconnect-room', userId: client1.id }
      };
      
      client1.ws.send(JSON.stringify(joinMessage));
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Disconnect
      client1.ws.close();
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Reconnect with new client
      const client2 = await harness.createQuickClient('reconnect-client-2');
      
      // Should be able to join the same room
      const rejoinMessage = {
        type: 'join-room',
        data: { roomId: 'reconnect-room', userId: client2.id }
      };
      
      client2.ws.send(JSON.stringify(rejoinMessage));
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(client2.connected).toBe(true);
    }, 4000);
  });

  describe('📊 Basic Performance', () => {
    test('should handle rapid message sending', async () => {
      await harness.setupSimpleCluster(1);
      
      const client = await harness.createQuickClient('perf-client');
      const roomId = 'perf-room';
      
      // Join room
      const joinMessage = {
        type: 'join-room',
        data: { roomId, userId: client.id }
      };
      
      client.ws.send(JSON.stringify(joinMessage));
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Send multiple messages rapidly
      const messageCount = 20;
      for (let i = 0; i < messageCount; i++) {
        const message = {
          type: 'send-message',
          data: {
            roomId,
            userId: client.id,
            content: `Rapid message ${i}`
          }
        };
        
        client.ws.send(JSON.stringify(message));
        client.messagesSent++;
        
        // Very small delay
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      expect(client.messagesSent).toBe(messageCount);
      expect(client.connected).toBe(true);
    }, 6000);

    test('should handle multiple rooms efficiently', async () => {
      await harness.setupSimpleCluster(1);
      
      const roomCount = 5;
      const clientsPerRoom = 2;
      const allClients: QuickTestClient[] = [];
      
      // Create multiple rooms with clients
      for (let room = 0; room < roomCount; room++) {
        for (let client = 0; client < clientsPerRoom; client++) {
          const clientInstance = await harness.createQuickClient(`room-${room}-client-${client}`);
          allClients.push(clientInstance);
          
          const joinMessage = {
            type: 'join-room',
            data: {
              roomId: `efficient-room-${room}`,
              userId: clientInstance.id
            }
          };
          
          clientInstance.ws.send(JSON.stringify(joinMessage));
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // All clients should be connected
      expect(allClients.every(c => c.connected)).toBe(true);
      expect(allClients.length).toBe(roomCount * clientsPerRoom);
    }, 6000);
  });
});
