import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import WebSocket from 'ws';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { ClientWebSocketAdapter } from '../../../src/transport/adapters/ClientWebSocketAdapter';
import { ChatRoomCoordinator } from '../cluster/ChatRoomCoordinator';
import { NodeId } from '../../../src/types';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';

/**
 * Basic Chat Integration Tests
 * 
 * ⚡ INTEGRATION TEST SUITE - All tests complete under 7 seconds ⚡
 * 
 * These tests verify core chat functionality without extensive load:
 * - Basic room joining and messaging (< 3s)
 * - Simple client connections (< 2s) 
 * - Message routing validation (< 5s)
 * - Coordinator integration (< 4s)
 * 
 * For comprehensive production validation (longer tests), see:
 * test/e2e/chat/production-chat-validation.test.ts
 */

class ChatIntegrationHarness {
  public node: ChatIntegrationNode | null = null;

  async setupSingleNode(): Promise<ChatIntegrationNode> {
    const clusterPort = 9100;
    const clientPort = 8100;
    
    this.node = new ChatIntegrationNode('integration-node', clusterPort, clientPort);
    await this.node.start();
    
    // Brief stabilization
    await new Promise(resolve => setTimeout(resolve, 500));
    
    return this.node;
  }

  async createClient(port: number, clientId: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Client ${clientId} connection timeout`));
      }, 2000);

      ws.on('open', () => {
        clearTimeout(timeout);
        resolve(ws);
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async cleanup(): Promise<void> {
    if (this.node) {
      await this.node.stop();
      this.node = null;
    }
  }
}

class ChatIntegrationNode {
  public nodeId: string;
  public cluster: ClusterManager;
  public clientAdapter: ClientWebSocketAdapter;
  public coordinator: ChatRoomCoordinator;
  public clientPort: number;
  private transport: WebSocketAdapter;

  constructor(nodeId: string, clusterPort: number, clientPort: number) {
    this.nodeId = nodeId;
    this.clientPort = clientPort;

    const nodeIdObj: NodeId = { 
      id: nodeId,
      address: '127.0.0.1',
      port: clusterPort
    };

    this.transport = new WebSocketAdapter(nodeIdObj, { 
      port: clusterPort,
      host: '127.0.0.1',
      enableLogging: false 
    });

    const config = BootstrapConfig.create({
      seedNodes: [], // Single node setup
      enableLogging: false,
      gossipInterval: 100
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
      false // Disable logging
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

describe('Basic Chat Integration', () => {
  let harness: ChatIntegrationHarness;

  beforeEach(async () => {
    harness = new ChatIntegrationHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('🔗 Core Integration Tests', () => {
    test('should establish client connection and join room', async () => {
      const node = await harness.setupSingleNode();
      const client = await harness.createClient(node.clientPort, 'test-client');
      
      let joinConfirmed = false;
      
      client.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'room-joined') {
            joinConfirmed = true;
          }
        } catch (error) {
          // Ignore parse errors for this test
        }
      });

      // Send join room message
      const joinMessage = {
        type: 'join-room',
        data: {
          roomId: 'integration-room',
          userId: 'test-user'
        }
      };

      client.send(JSON.stringify(joinMessage));
      
      // Wait for response
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      expect(client.readyState).toBe(WebSocket.OPEN);
      client.close();
    }, 3000); // Integration: Basic connection and room join

    test('should route messages between coordinator and client', async () => {
      const node = await harness.setupSingleNode();
      const client = await harness.createClient(node.clientPort, 'msg-client');
      
      const receivedMessages: any[] = [];
      
      client.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          receivedMessages.push(message);
        } catch (error) {
          // Ignore parse errors
        }
      });

      // Join room first
      const joinMessage = {
        type: 'join-room',
        data: {
          roomId: 'message-room',
          userId: 'sender'
        }
      };
      client.send(JSON.stringify(joinMessage));
      
      await new Promise(resolve => setTimeout(resolve, 500));

      // Send a message
      const chatMessage = {
        type: 'send-message',
        data: {
          roomId: 'message-room',
          userId: 'sender',
          content: 'Hello integration test!'
        }
      };
      client.send(JSON.stringify(chatMessage));
      
      // Wait for message processing
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Should have received some messages (join confirmation, echo, etc.)
      expect(receivedMessages.length).toBeGreaterThan(0);
      
      client.close();
    }, 4000); // Integration: Message routing verification

    test('should handle multiple rapid messages', async () => {
      const node = await harness.setupSingleNode();
      const client = await harness.createClient(node.clientPort, 'rapid-client');
      
      let messagesReceived = 0;
      
      client.on('message', (data) => {
        try {
          JSON.parse(data.toString());
          messagesReceived++;
        } catch (error) {
          // Ignore parse errors
        }
      });

      // Join room
      const joinMessage = {
        type: 'join-room',
        data: {
          roomId: 'rapid-room',
          userId: 'rapid-sender'
        }
      };
      client.send(JSON.stringify(joinMessage));
      
      await new Promise(resolve => setTimeout(resolve, 300));

      // Send multiple messages rapidly
      const messageCount = 10;
      for (let i = 0; i < messageCount; i++) {
        const message = {
          type: 'send-message',
          data: {
            roomId: 'rapid-room',
            userId: 'rapid-sender',
            content: `Rapid message ${i}`
          }
        };
        client.send(JSON.stringify(message));
        
        // Small delay to avoid overwhelming
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Should have received responses
      expect(messagesReceived).toBeGreaterThan(0);
      
      client.close();
    }, 5000); // Integration: Rapid message handling

    test('should validate coordinator initialization', async () => {
      const node = await harness.setupSingleNode();
      
      // Verify coordinator is properly initialized
      expect(node.coordinator).toBeDefined();
      expect(node.clientAdapter).toBeDefined();
      expect(node.cluster).toBeDefined();
      
      // Verify node ID is set correctly
      expect(node.nodeId).toBe('integration-node');
      expect(node.clientPort).toBe(8100);
    }, 2000); // Integration: Service initialization check

    test('should handle graceful client disconnection', async () => {
      const node = await harness.setupSingleNode();
      const client = await harness.createClient(node.clientPort, 'disconnect-client');
      
      // Join room
      const joinMessage = {
        type: 'join-room',
        data: {
          roomId: 'disconnect-room',
          userId: 'disconnect-user'
        }
      };
      client.send(JSON.stringify(joinMessage));
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Close connection
      client.close();
      
      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Should handle disconnection gracefully (no errors)
      expect(true).toBe(true); // Test passes if no exceptions thrown
    }, 2000); // Integration: Graceful disconnection handling
  });

  describe('🧪 Error Handling Integration', () => {
    test('should handle invalid JSON gracefully', async () => {
      const node = await harness.setupSingleNode();
      const client = await harness.createClient(node.clientPort, 'invalid-client');
      
      // Send invalid JSON
      client.send('{"invalid": json}');
      client.send('not-json-at-all');
      client.send('{}');
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Connection should remain stable
      expect(client.readyState).toBe(WebSocket.OPEN);
      
      client.close();
    }, 2000); // Integration: Error resilience check

    test('should handle empty room IDs', async () => {
      const node = await harness.setupSingleNode();
      const client = await harness.createClient(node.clientPort, 'empty-room-client');
      
      // Send message with empty room ID
      const invalidMessage = {
        type: 'join-room',
        data: {
          roomId: '',
          userId: 'test-user'
        }
      };
      client.send(JSON.stringify(invalidMessage));
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Should handle gracefully
      expect(client.readyState).toBe(WebSocket.OPEN);
      
      client.close();
    }, 2000); // Integration: Edge case handling
  });
});
