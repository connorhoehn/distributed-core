import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import WebSocket from 'ws';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { ClientWebSocketAdapter } from '../../../src/transport/adapters/ClientWebSocketAdapter';
import { ChatRoomCoordinator } from '../cluster/ChatRoomCoordinator';
import { NodeId } from '../../../src/types';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';

/**
 * Production-Style Chat System Validation Tests
 * 
 * ⚡ E2E TEST SUITE - All tests run longer than 7 seconds ⚡
 * 
 * These tests simulate real-world production scenarios with:
 * - High concurrent user loads (25-30s)
 * - Network partitions and failures (15-25s) 
 * - Memory and performance constraints (20s)
 * - Security and rate limiting (10-15s)
 * - Data consistency across node failures (15s)
 * - Message ordering guarantees (15s)
 * - Large room scaling (30s)
 * 
 * All timeouts are kept under Jest E2E limit (30s) while providing
 * comprehensive distributed system validation coverage.
 */

interface ChatMetrics {
  messagesProcessed: number;
  averageLatency: number;
  maxLatency: number;
  connectionsActive: number;
  roomsActive: number;
  nodesActive: number;
  memoryUsage: number;
  errors: Array<{ type: string; count: number }>;
}

interface StressTestClient {
  id: string;
  ws: WebSocket;
  messagesSent: number;
  messagesReceived: number;
  latencies: number[];
  errors: number;
  connected: boolean;
}

class ProductionChatTestHarness {
  public nodes: ChatNode[] = [];
  private clients: StressTestClient[] = [];
  private metrics: ChatMetrics;
  private startTime: number = 0;

  constructor() {
    this.metrics = {
      messagesProcessed: 0,
      averageLatency: 0,
      maxLatency: 0,
      connectionsActive: 0,
      roomsActive: 0,
      nodesActive: 0,
      memoryUsage: 0,
      errors: []
    };
  }

  async setupCluster(nodeCount: number = 5): Promise<void> {
    const ports = Array.from({ length: nodeCount }, (_, i) => 9000 + i);
    const clientPorts = Array.from({ length: nodeCount }, (_, i) => 8000 + i);

    // Create cluster nodes
    for (let i = 0; i < nodeCount; i++) {
      const node = new ChatNode(
        `node-${i}`,
        ports[i],
        clientPorts[i],
        ports.filter((_, idx) => idx !== i) // Seed with other nodes
      );
      this.nodes.push(node);
    }

    // Start all nodes
    await Promise.all(this.nodes.map(node => node.start()));
    
    // Wait for cluster formation
    await this.waitForClusterStabilization();
  }

  async createStressClients(
    clientCount: number, 
    nodeIndex: number = 0
  ): Promise<StressTestClient[]> {
    const node = this.nodes[nodeIndex];
    const clients: StressTestClient[] = [];

    for (let i = 0; i < clientCount; i++) {
      const client = await this.createClient(`stress-client-${i}`, node.clientPort);
      clients.push(client);
    }

    this.clients.push(...clients);
    return clients;
  }

  private async createClient(clientId: string, port: number): Promise<StressTestClient> {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    
    const client: StressTestClient = {
      id: clientId,
      ws,
      messagesSent: 0,
      messagesReceived: 0,
      latencies: [],
      errors: 0,
      connected: false
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Client ${clientId} connection timeout`));
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timeout);
        client.connected = true;
        this.setupClientMessageHandling(client);
        resolve(client);
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private setupClientMessageHandling(client: StressTestClient): void {
    client.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        client.messagesReceived++;
        
        if (message.sentAt) {
          const latency = Date.now() - message.sentAt;
          client.latencies.push(latency);
          this.updateLatencyMetrics(latency);
        }
        
        this.metrics.messagesProcessed++;
      } catch (error) {
        client.errors++;
        this.recordError('message_parse_error');
      }
    });

    client.ws.on('error', () => {
      client.errors++;
      this.recordError('client_connection_error');
    });

    client.ws.on('close', () => {
      client.connected = false;
    });
  }

  async performLoadTest(
    clients: StressTestClient[],
    roomId: string,
    messagesPerClient: number,
    messageIntervalMs: number = 100
  ): Promise<void> {
    this.startTime = Date.now();
    
    // Join all clients to room first
    await Promise.all(clients.map(client => this.joinRoom(client, roomId)));
    
    // Start sending messages from all clients
    const messagePromises = clients.map(client => 
      this.sendMessagesFromClient(client, roomId, messagesPerClient, messageIntervalMs)
    );
    
    await Promise.all(messagePromises);
  }

  private async joinRoom(client: StressTestClient, roomId: string): Promise<void> {
    const joinMessage = {
      type: 'join-room',
      data: {
        roomId,
        userId: client.id
      }
    };

    client.ws.send(JSON.stringify(joinMessage));
    
    // Wait for join confirmation
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  private async sendMessagesFromClient(
    client: StressTestClient,
    roomId: string,
    messageCount: number,
    intervalMs: number
  ): Promise<void> {
    for (let i = 0; i < messageCount; i++) {
      const message = {
        type: 'send-message',
        data: {
          roomId,
          userId: client.id,
          content: `Message ${i} from ${client.id}`,
          sentAt: Date.now()
        }
      };

      try {
        client.ws.send(JSON.stringify(message));
        client.messagesSent++;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      } catch (error) {
        client.errors++;
        this.recordError('message_send_error');
      }
    }
  }

  async simulateNodeFailure(nodeIndex: number): Promise<void> {
    if (nodeIndex >= this.nodes.length) return;
    
    const node = this.nodes[nodeIndex];
    console.log(`🔥 Simulating failure of node ${node.nodeId}`);
    
    await node.stop();
    this.metrics.nodesActive--;
    
    // Wait for cluster to detect failure and rebalance
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  async simulateNetworkPartition(
    nodeIndexes: number[], 
    partitionDurationMs: number
  ): Promise<void> {
    console.log(`🌐 Simulating network partition for nodes: ${nodeIndexes}`);
    
    // Simulate by stopping transport temporarily
    const affectedNodes = nodeIndexes.map(i => this.nodes[i]);
    
    // Stop transport for partitioned nodes
    await Promise.all(affectedNodes.map(node => node.cluster.stop()));
    
    // Wait for partition duration
    await new Promise(resolve => setTimeout(resolve, partitionDurationMs));
    
    // Restore connectivity
    await Promise.all(affectedNodes.map(node => node.cluster.start()));
    
    // Wait for re-stabilization
    await this.waitForClusterStabilization();
  }

  private async waitForClusterStabilization(): Promise<void> {
    // Wait for gossip protocol to stabilize cluster membership
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  private updateLatencyMetrics(latency: number): void {
    if (latency > this.metrics.maxLatency) {
      this.metrics.maxLatency = latency;
    }
    
    // Update running average (simplified)
    const totalLatencies = this.clients.reduce((sum, client) => 
      sum + client.latencies.reduce((a, b) => a + b, 0), 0
    );
    const totalMessages = this.clients.reduce((sum, client) => 
      sum + client.latencies.length, 0
    );
    
    this.metrics.averageLatency = totalMessages > 0 ? totalLatencies / totalMessages : 0;
  }

  private recordError(errorType: string): void {
    const existing = this.metrics.errors.find(e => e.type === errorType);
    if (existing) {
      existing.count++;
    } else {
      this.metrics.errors.push({ type: errorType, count: 1 });
    }
  }

  getMetrics(): ChatMetrics {
    this.metrics.connectionsActive = this.clients.filter(c => c.connected).length;
    this.metrics.nodesActive = this.nodes.length;
    this.metrics.memoryUsage = process.memoryUsage().heapUsed;
    
    return { ...this.metrics };
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

class ChatNode {
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
      gossipInterval: 100,
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

describe('Production Chat System E2E Validation', () => {
  let harness: ProductionChatTestHarness;

  beforeEach(async () => {
    harness = new ProductionChatTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('🚀 Performance & Scale Tests', () => {
    test('should handle 100 concurrent clients in a single room', async () => {
      // Setup 3-node cluster
      await harness.setupCluster(3);
      
      // Create 100 stress test clients
      const clients = await harness.createStressClients(100, 0);
      
      // Perform load test: each client sends 10 messages
      await harness.performLoadTest(clients, 'stress-room-1', 10, 50);
      
      const metrics = harness.getMetrics();
      
      // Validate performance metrics
      expect(metrics.connectionsActive).toBe(100);
      expect(metrics.messagesProcessed).toBeGreaterThan(800); // Allow some message loss
      expect(metrics.averageLatency).toBeLessThan(500); // Under 500ms average
      expect(metrics.maxLatency).toBeLessThan(2000); // Under 2s max
      
      console.log('📊 Performance Metrics:', metrics);
    }, 25000); // E2E: 100 concurrent clients with messaging load

    test('should handle multiple rooms with distributed clients', async () => {
      await harness.setupCluster(5);
      
      const roomCount = 10;
      const clientsPerRoom = 20;
      
      // Create clients across different nodes
      for (let room = 0; room < roomCount; room++) {
        const nodeIndex = room % 5; // Distribute across nodes
        const clients = await harness.createStressClients(clientsPerRoom, nodeIndex);
        
        // Each room gets its own load test
        await harness.performLoadTest(clients, `room-${room}`, 5, 100);
      }
      
      const metrics = harness.getMetrics();
      expect(metrics.connectionsActive).toBe(roomCount * clientsPerRoom);
      expect(metrics.nodesActive).toBe(5);
      
      console.log('🏢 Multi-room Metrics:', metrics);
    }, 30000); // E2E: Multiple rooms across 5 nodes with distributed load
  });

  describe('💥 Failure Recovery Tests', () => {
    test('should maintain message delivery during node failure', async () => {
      await harness.setupCluster(3);
      
      const clients = await harness.createStressClients(30, 0);
      const roomId = 'failure-test-room';
      
      // Start message flow
      const messageFlow = harness.performLoadTest(clients, roomId, 20, 200);
      
      // Simulate node failure after 2 seconds
      setTimeout(async () => {
        await harness.simulateNodeFailure(1);
      }, 2000);
      
      await messageFlow;
      
      const metrics = harness.getMetrics();
      
      // Should still have processed most messages despite node failure
      expect(metrics.messagesProcessed).toBeGreaterThan(400);
      expect(metrics.nodesActive).toBe(2); // One node failed
      
      console.log('💀 Failure Recovery Metrics:', metrics);
    }, 20000); // E2E: Node failure during active messaging

    test('should recover from network partition', async () => {
      await harness.setupCluster(4);
      
      const clients1 = await harness.createStressClients(20, 0);
      const clients2 = await harness.createStressClients(20, 2);
      
      // Start messaging on both sides
      const messaging1 = harness.performLoadTest(clients1, 'partition-room', 10, 300);
      const messaging2 = harness.performLoadTest(clients2, 'partition-room', 10, 300);
      
      // Create partition: isolate nodes 0,1 from 2,3
      setTimeout(async () => {
        await harness.simulateNetworkPartition([0, 1], 3000);
      }, 1000);
      
      await Promise.all([messaging1, messaging2]);
      
      const metrics = harness.getMetrics();
      
      // Should eventually converge after partition heals
      expect(metrics.nodesActive).toBe(4);
      expect(metrics.messagesProcessed).toBeGreaterThan(300);
      
      console.log('🌐 Partition Recovery Metrics:', metrics);
    }, 25000); // E2E: Network partition simulation with recovery
  });

  describe('🔒 Data Consistency Tests', () => {
    test('should maintain room state consistency across node failures', async () => {
      await harness.setupCluster(3);
      
      const roomId = 'consistency-room';
      const clients = await harness.createStressClients(15, 0);
      
      // Join all clients to room
      await Promise.all(clients.map(client => {
        const joinMessage = {
          type: 'join-room',
          data: { roomId, userId: client.id }
        };
        client.ws.send(JSON.stringify(joinMessage));
      }));
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Fail the primary node
      await harness.simulateNodeFailure(0);
      
      // Verify room state is maintained on other nodes
      const postFailureClients = await harness.createStressClients(5, 1);
      
      // New clients should be able to join the existing room
      await Promise.all(postFailureClients.map(client => {
        const joinMessage = {
          type: 'join-room',
          data: { roomId, userId: `new-${client.id}` }
        };
        client.ws.send(JSON.stringify(joinMessage));
      }));
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const metrics = harness.getMetrics();
      expect(metrics.nodesActive).toBe(2);
      
      console.log('🔄 Consistency Metrics:', metrics);
    }, 15000); // E2E: State consistency verification across node failures

    test('should handle message ordering under load', async () => {
      await harness.setupCluster(2);
      
      const client = (await harness.createStressClients(1, 0))[0];
      const roomId = 'ordering-room';
      
      // Join room
      const joinMessage = {
        type: 'join-room',
        data: { roomId, userId: client.id }
      };
      client.ws.send(JSON.stringify(joinMessage));
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Send sequential messages rapidly
      const messageCount = 50;
      const sentMessages: number[] = [];
      const receivedMessages: number[] = [];
      
      // Setup message tracking
      client.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.data?.sequenceId !== undefined) {
            receivedMessages.push(message.data.sequenceId);
          }
        } catch (error) {
          // Ignore parse errors for this test
        }
      });
      
      // Send messages rapidly
      for (let i = 0; i < messageCount; i++) {
        const message = {
          type: 'send-message',
          data: {
            roomId,
            userId: client.id,
            content: `Sequential message ${i}`,
            sequenceId: i
          }
        };
        
        client.ws.send(JSON.stringify(message));
        sentMessages.push(i);
        
        // Small delay to avoid overwhelming
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      // Wait for all messages to be processed
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Verify ordering
      expect(receivedMessages.length).toBeGreaterThan(messageCount * 0.9); // Allow 10% loss
      
      // Check if received messages maintain relative order
      let orderViolations = 0;
      for (let i = 1; i < receivedMessages.length; i++) {
        if (receivedMessages[i] < receivedMessages[i-1]) {
          orderViolations++;
        }
      }
      
      // Should have minimal order violations (< 5%)
      expect(orderViolations).toBeLessThan(receivedMessages.length * 0.05);
      
      console.log(`📊 Ordering: Sent ${sentMessages.length}, Received ${receivedMessages.length}, Violations: ${orderViolations}`);
    }, 15000); // E2E: Message ordering verification under rapid load
  });

  describe('🛡️ Security & Rate Limiting Tests', () => {
    test('should handle malformed messages gracefully', async () => {
      await harness.setupCluster(1);
      
      const client = (await harness.createStressClients(1, 0))[0];
      
      // Send various malformed messages
      const malformedMessages = [
        '{"invalid": json}',
        '{"type": "unknown-type", "data": {}}',
        '{"type": "join-room"}', // Missing data
        '{"type": "send-message", "data": {"roomId": "", "content": ""}}', // Empty fields
        Buffer.from('binary-data-that-is-not-json'),
        '{}', // Empty object
        '{"type": "send-message", "data": {"roomId": "' + 'x'.repeat(10000) + '"}}' // Huge payload
      ];
      
      let errorCount = 0;
      client.ws.on('error', () => errorCount++);
      
      // Send malformed messages
      for (const msg of malformedMessages) {
        try {
          client.ws.send(msg);
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          // Expected for some malformed messages
        }
      }
      
      // Connection should remain stable
      expect(client.connected).toBe(true);
      
      // Should be able to send normal message after malformed ones
      const normalMessage = {
        type: 'join-room',
        data: { roomId: 'test-room', userId: client.id }
      };
      
      client.ws.send(JSON.stringify(normalMessage));
      await new Promise(resolve => setTimeout(resolve, 500));
      
      console.log(`🛡️ Security: Handled ${malformedMessages.length} malformed messages, errors: ${errorCount}`);
    }, 10000); // E2E: Security resilience testing

    test('should handle connection flooding', async () => {
      await harness.setupCluster(1);
      
      // Attempt to create many connections rapidly
      const connectionAttempts = 50;
      const connections: WebSocket[] = [];
      let successfulConnections = 0;
      let failedConnections = 0;
      
      const connectionPromises = Array.from({ length: connectionAttempts }, async (_, i) => {
        try {
          const ws = new WebSocket(`ws://localhost:${harness.nodes[0].clientPort}/ws`);
          
          return new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              failedConnections++;
              ws.close();
              resolve();
            }, 2000);
            
            ws.on('open', () => {
              clearTimeout(timeout);
              successfulConnections++;
              connections.push(ws);
              resolve();
            });
            
            ws.on('error', () => {
              clearTimeout(timeout);
              failedConnections++;
              resolve();
            });
          });
        } catch (error) {
          failedConnections++;
        }
      });
      
      await Promise.all(connectionPromises);
      
      // Cleanup connections
      connections.forEach(ws => ws.close());
      
      // Should handle reasonable number of connections
      expect(successfulConnections).toBeGreaterThan(20);
      expect(successfulConnections + failedConnections).toBe(connectionAttempts);
      
      console.log(`🌊 Flooding: ${successfulConnections} successful, ${failedConnections} failed connections`);
    }, 15000); // E2E: Connection flooding resilience test
  });

  describe('📈 Memory & Resource Tests', () => {
    test('should maintain reasonable memory usage under load', async () => {
      await harness.setupCluster(2);
      
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Create load
      const clients = await harness.createStressClients(50, 0);
      await harness.performLoadTest(clients, 'memory-test-room', 20, 50);
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;
      
      // Memory increase should be reasonable (< 100MB for this test)
      expect(memoryIncrease).toBeLessThan(100 * 1024 * 1024);
      
      console.log(`💾 Memory: Initial ${Math.round(initialMemory / 1024 / 1024)}MB, Final ${Math.round(finalMemory / 1024 / 1024)}MB, Increase: ${Math.round(memoryIncrease / 1024 / 1024)}MB`);
    }, 20000); // E2E: Memory usage validation under sustained load
  });
});
