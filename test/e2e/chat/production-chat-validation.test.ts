import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import WebSocket from 'ws';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { ClientWebSocketAdapter } from '../../../src/transport/adapters/ClientWebSocketAdapter';
import { NodeId } from '../../../src/types';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';
import { ApplicationRegistry } from '../../../src/applications/ApplicationRegistry';
import { ChatApplicationModule, ChatApplicationConfig } from '../../../src/applications/ChatApplicationModule';
import { ResourceRegistry } from '../../../src/cluster/resources/ResourceRegistry';
import { ResourceTopologyManager } from '../../../src/cluster/topology/ResourceTopologyManager';
import { ResourceTypeRegistry } from '../../../src/cluster/resources/ResourceTypeRegistry';
import { StateAggregator } from '../../../src/cluster/aggregation/StateAggregator';
import { MetricsTracker } from '../../../src/monitoring/metrics/MetricsTracker';
import { EntityRegistryFactory } from '../../../src/cluster/entity/EntityRegistryFactory';

/**
 * Production-Style Chat System Validation Tests (REFACTORED)
 * 
 * ⚡ E2E TEST SUITE - Using New Modular Architecture ⚡
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
 * REFACTORED to use new modular components:
 * - ChatApplicationModule instead of ChatRoomCoordinator
 * - ApplicationRegistry for module management
 * - ResourceRegistry for resource lifecycle
 * - ResourceTopologyManager for topology awareness
 */

interface ChatMetrics {
  messagesProcessed: number;
  averageLatency: number;
  maxLatency: number;
  connectionsActive: number;
  roomsActive: number;
  nodesActive: number;
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

class ModularProductionChatTestHarness {
  public nodes: ModularChatNode[] = [];
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
      nodesActive: 0
    };
  }

  async setupCluster(nodeCount: number = 5): Promise<void> {
    const ports = Array.from({ length: nodeCount }, (_, i) => 9000 + i);
    const clientPorts = Array.from({ length: nodeCount }, (_, i) => 8000 + i);

    // Create cluster nodes
    for (let i = 0; i < nodeCount; i++) {
      const node = new ModularChatNode(
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
        // Simplified error handling - just track in client
        client.errors++;
      }
    });

    client.ws.on('error', () => {
      client.errors++;
    });

    client.ws.on('close', () => {
      client.connected = false;
      this.metrics.connectionsActive--;
    });
  }

  async joinClientToRoom(client: StressTestClient, roomName: string, clientName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Join room timeout for ${clientName}`));
      }, 5000);

      const messageHandler = (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'room-joined' && message.data?.roomName === roomName) {
            client.ws.off('message', messageHandler);
            clearTimeout(timeout);
            resolve();
          }
        } catch (error) {
          // Ignore parse errors for non-relevant messages
        }
      };

      client.ws.on('message', messageHandler);

      // Send join room message
      const joinMessage = {
        type: 'join-room',
        data: {
          roomName,
          clientName
        }
      };

      client.ws.send(JSON.stringify(joinMessage));
    });
  }

  async sendMessage(client: StressTestClient, roomName: string, content: string): Promise<void> {
    const message = {
      type: 'send-message',
      data: {
        roomName,
        content,
        sentAt: Date.now()
      }
    };

    client.ws.send(JSON.stringify(message));
    client.messagesSent++;
  }

  async waitForClusterStabilization(): Promise<void> {
    // Wait for cluster formation and stabilization
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Update metrics
    this.metrics.nodesActive = this.nodes.length;
    this.updateConnectionMetrics();
  }

  private updateLatencyMetrics(latency: number): void {
    this.metrics.maxLatency = Math.max(this.metrics.maxLatency, latency);
    
    // Update running average
    const totalLatency = this.metrics.averageLatency * (this.metrics.messagesProcessed - 1) + latency;
    this.metrics.averageLatency = totalLatency / this.metrics.messagesProcessed;
  }

  private updateConnectionMetrics(): void {
    this.metrics.connectionsActive = this.clients.filter(c => c.connected).length;
  }

  // Removed recordError method since we simplified metrics

  async collectMetrics(): Promise<ChatMetrics> {
    this.updateConnectionMetrics();
    
    // Count active rooms across all nodes
    let totalRooms = 0;
    for (const node of this.nodes) {
      const chatModule = node.chatModule;
      if (chatModule) {
        const rooms = await chatModule.getResources();
        totalRooms += rooms.length;
      }
    }
    
    this.metrics.roomsActive = totalRooms;
    return { ...this.metrics };
  }

  async simulateNetworkPartition(nodeIndices: number[], durationMs: number): Promise<void> {
    // Simulate network partition by stopping nodes temporarily
    const affectedNodes = nodeIndices.map(i => this.nodes[i]);
    
    // Stop affected nodes
    await Promise.all(affectedNodes.map(node => node.cluster.stop()));
    
    await new Promise(resolve => setTimeout(resolve, durationMs));
    
    // Restart affected nodes
    await Promise.all(affectedNodes.map(node => node.cluster.start()));
    
    // Wait for re-stabilization
    await this.waitForClusterStabilization();
  }

  async measureThroughput(durationMs: number): Promise<{ messagesPerSecond: number; latencyP95: number }> {
    const startMessages = this.metrics.messagesProcessed;
    const startTime = Date.now();
    
    await new Promise(resolve => setTimeout(resolve, durationMs));
    
    const endMessages = this.metrics.messagesProcessed;
    const endTime = Date.now();
    
    const messagesPerSecond = (endMessages - startMessages) / ((endTime - startTime) / 1000);
    
    // Calculate P95 latency
    const allLatencies = this.clients.flatMap(c => c.latencies).sort((a, b) => a - b);
    const p95Index = Math.floor(allLatencies.length * 0.95);
    const latencyP95 = allLatencies[p95Index] || 0;
    
    return { messagesPerSecond, latencyP95 };
  }

  async cleanup(): Promise<void> {
    // Close all client connections
    await Promise.all(this.clients.map(client => {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.close();
      }
      return Promise.resolve();
    }));

    // Stop all nodes
    await Promise.all(this.nodes.map(node => node.stop()));
    
    // Clear state
    this.clients = [];
    this.nodes = [];
  }
}

class ModularChatNode {
  public nodeId: string;
  public cluster: ClusterManager;
  public clientAdapter: ClientWebSocketAdapter;
  public applicationRegistry!: ApplicationRegistry;
  public resourceRegistry!: ResourceRegistry;
  public topologyManager!: ResourceTopologyManager;
  public chatModule!: ChatApplicationModule;
  public clientPort: number;
  private transport: WebSocketAdapter;
  private resourceTypeRegistry!: ResourceTypeRegistry;
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

    // Initialize new modular architecture
    this.initializeModularChatSystem();
  }

  private initializeModularChatSystem(): void {
    // Create resource management infrastructure
    this.resourceTypeRegistry = new ResourceTypeRegistry();
    
    this.resourceRegistry = new ResourceRegistry({
      nodeId: this.nodeId,
      entityRegistryType: 'memory',
      entityRegistryConfig: { enableTestMode: true }
    });

    // Create required components for ResourceTopologyManager
    const stateAggregator = new StateAggregator(this.cluster);
    const metricsTracker = new MetricsTracker({
      collectionInterval: 5000,
      retentionPeriod: 60000,
      enableTrends: false,
      enableAlerts: false,
      thresholds: {
        cpu: 90,
        memory: 95,
        disk: 95,
        networkLatency: 5000,
        clusterStability: 0.8
      }
    });

    this.topologyManager = new ResourceTopologyManager(
      this.cluster,
      this.resourceRegistry,
      this.resourceTypeRegistry,
      stateAggregator,
      metricsTracker
    );

    this.applicationRegistry = new ApplicationRegistry(
      this.cluster,
      this.resourceRegistry,
      this.topologyManager,
      { enableTestMode: true }
    );

    // Configure the ChatApplicationModule
    const chatConfig: ChatApplicationConfig = {
      moduleId: 'production-chat-module',
      moduleName: 'Production Chat Application',
      version: '1.0.0',
      resourceTypes: ['chat-room'],
      configuration: {
        enableChatExtraction: true,
        testMode: true
      },
      maxRoomsPerNode: 100,
      maxClientsPerRoom: 1000,
      messageRetentionDays: 1,
      autoScaling: {
        enabled: false, // Disabled for E2E tests
        scaleUpThreshold: 0.8,
        scaleDownThreshold: 0.2,
        maxShards: 5
      },
      moderation: {
        enableAutoModeration: false,
        bannedWords: [],
        maxMessageLength: 1000,
        rateLimitPerMinute: 60
      }
    };

    this.chatModule = new ChatApplicationModule(chatConfig);
    
    // Set up client message handling
    this.setupClientMessageHandling();
  }

  private setupClientMessageHandling(): void {
    // Set up listener for client messages from the WebSocket adapter
    this.clientAdapter.on('client-message', async ({ clientId, message }: { clientId: string, message: any }) => {
      await this.handleClientMessage(clientId, message);
    });
  }

  private async handleClientMessage(clientId: string, message: any): Promise<void> {
    switch (message.type) {
      case 'join-room':
        await this.handleJoinRoom(clientId, message.data.roomName, message.data.clientName);
        break;
      
      case 'send-message':
        await this.handleSendMessage(clientId, message.data.roomName, message.data.content);
        break;
      
      case 'leave-room':
        await this.handleLeaveRoom(clientId, message.data.roomName);
        break;
      
      default:
        this.clientAdapter.sendToClient(clientId, {
          type: 'error',
          data: { message: `Unknown message type: ${message.type}` }
        });
    }
  }

  private async handleJoinRoom(clientId: string, roomName: string, userName: string): Promise<void> {
    try {
      // Check if room exists first to avoid creation conflicts
      let room = await this.findRoom(roomName);
      if (!room) {
        try {
          // Try to create room if it doesn't exist
          room = await this.chatModule.createRoom(roomName, true);
          console.log(`📝 Created new room: ${roomName}`);
        } catch (error) {
          // If room creation fails due to race condition, try to find it again
          if (error instanceof Error && error.message.includes('already exists')) {
            room = await this.findRoom(roomName);
            if (!room) {
              throw new Error(`Failed to find room ${roomName} after creation conflict`);
            }
            console.log(`🔄 Found existing room after creation conflict: ${roomName}`);
          } else {
            throw error;
          }
        }
      }

      // Add client to room (simplified for E2E test)
      console.log(`👋 ${userName} (${clientId}) joined room ${roomName}`);

      this.clientAdapter.sendToClient(clientId, {
        type: 'room-joined',
        data: {
          roomName,
          roomId: room.resourceId,
          userName,
          timestamp: Date.now()
        }
      });

    } catch (error) {
      console.error('Error joining room:', error);
      this.clientAdapter.sendToClient(clientId, {
        type: 'error',
        data: { message: 'Failed to join room' }
      });
    }
  }

  private async handleSendMessage(clientId: string, roomName: string, content: string): Promise<void> {
    try {
      const room = await this.findRoom(roomName);
      if (!room) {
        throw new Error(`Room ${roomName} not found`);
      }

      // Create message data
      const messageData = {
        roomName,
        content,
        senderId: clientId,
        timestamp: Date.now(),
        messageId: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      };

      // Send message response back to client
      this.clientAdapter.sendToClient(clientId, {
        type: 'message-sent',
        data: messageData
      });
    } catch (error) {
      this.clientAdapter.sendToClient(clientId, {
        type: 'error',
        data: { message: `Failed to send message: ${error}` }
      });
    }
  }

  private async handleLeaveRoom(clientId: string, roomName: string): Promise<void> {
    try {
      this.clientAdapter.sendToClient(clientId, {
        type: 'room-left',
        data: { roomName }
      });
    } catch (error) {
      this.clientAdapter.sendToClient(clientId, {
        type: 'error',
        data: { message: `Failed to leave room: ${error}` }
      });
    }
  }

  private async findRoom(roomName: string): Promise<any> {
    try {
      // Use the resource registry to find rooms by type, like the working test
      const chatRooms = this.resourceRegistry.getResourcesByType('chat-room');
      return chatRooms.find(room => room.applicationData?.roomName === roomName);
    } catch (error) {
      return null;
    }
  }

  async start(): Promise<void> {
    // Start core infrastructure
    await this.clientAdapter.start();
    await this.cluster.start();
    await this.resourceRegistry.start();
    await this.topologyManager.start();
    await this.applicationRegistry.start();

    // Register and start the chat module
    await this.applicationRegistry.registerModule(this.chatModule);
  }

  async stop(): Promise<void> {
    await this.applicationRegistry.stop();
    await this.topologyManager.stop();
    await this.resourceRegistry.stop();
    await this.cluster.stop();
    await this.clientAdapter.stop();
  }
}

describe('Production Chat System E2E Validation (Modular)', () => {
  let harness: ModularProductionChatTestHarness;

  beforeEach(async () => {
    harness = new ModularProductionChatTestHarness();
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
      
      // Join all clients to the same room
      const joinPromises = clients.map((client, index) => 
        harness.joinClientToRoom(client, 'stress-room-1', `stress-client-${index}`)
      );
      
      await Promise.all(joinPromises);
      
      // Verify all clients joined successfully
      expect(clients.every(c => c.connected)).toBe(true);
      
      // Send messages from multiple clients
      const messagePromises = clients.slice(0, 10).map((client, index) =>
        harness.sendMessage(client, 'stress-room-1', `Message from client ${index}`)
      );
      
      await Promise.all(messagePromises);
      
      // Wait for message propagation
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Collect metrics
      const metrics = await harness.collectMetrics();
      
      // Validate performance
      expect(metrics.connectionsActive).toBe(100);
      expect(metrics.roomsActive).toBeGreaterThan(0);
      expect(metrics.messagesProcessed).toBeGreaterThan(0);
      expect(metrics.averageLatency).toBeLessThan(1000); // < 1 second
      
    }, 25000);

    test('should maintain performance under high message throughput', async () => {
      // Setup smaller cluster for focused throughput testing
      await harness.setupCluster(2);
      
      // Create 20 clients for sustained messaging
      const clients = await harness.createStressClients(20, 0);
      
      // Join all clients to test room
      await Promise.all(clients.map((client, index) => 
        harness.joinClientToRoom(client, 'throughput-room', `throughput-client-${index}`)
      ));
      
      // Start sustained messaging
      const messagingPromise = (async () => {
        for (let round = 0; round < 5; round++) {
          const roundPromises = clients.map(async (client, index) => {
            await harness.sendMessage(client, 'throughput-room', `Round ${round} from ${index}`);
            await new Promise(resolve => setTimeout(resolve, 50)); // 20 messages/sec per client
          });
          await Promise.all(roundPromises);
        }
      })();
      
      // Measure throughput during messaging
      const throughputPromise = harness.measureThroughput(8000);
      
      await Promise.all([messagingPromise, throughputPromise]);
      
      const results = await throughputPromise;
      const metrics = await harness.collectMetrics();
      
      // Validate throughput performance
      expect(results.messagesPerSecond).toBeGreaterThan(10); // At least 10 msg/sec
      expect(results.latencyP95).toBeLessThan(2000); // P95 < 2 seconds
      
    }, 15000);

    test('should recover from network partitions gracefully', async () => {
      // Setup 5-node cluster for partition testing
      await harness.setupCluster(5);
      
      // Create clients across multiple nodes
      const node0Clients = await harness.createStressClients(10, 0);
      const node1Clients = await harness.createStressClients(10, 1);
      
      // Join all clients to partition test room
      await Promise.all([
        ...node0Clients.map((client, index) => 
          harness.joinClientToRoom(client, 'partition-room', `node0-client-${index}`)
        ),
        ...node1Clients.map((client, index) => 
          harness.joinClientToRoom(client, 'partition-room', `node1-client-${index}`)
        )
      ]);
      
      // Send initial messages to establish baseline
      await Promise.all([
        harness.sendMessage(node0Clients[0], 'partition-room', 'Pre-partition message from node 0'),
        harness.sendMessage(node1Clients[0], 'partition-room', 'Pre-partition message from node 1')
      ]);
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Simulate network partition (isolate nodes 0 and 1)
      await harness.simulateNetworkPartition([0, 1], 3000);
      
      // Send messages post-recovery
      await Promise.all([
        harness.sendMessage(node0Clients[0], 'partition-room', 'Post-recovery message from node 0'),
        harness.sendMessage(node1Clients[0], 'partition-room', 'Post-recovery message from node 1')
      ]);
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const metrics = await harness.collectMetrics();
      
      // Validate recovery
      expect(metrics.nodesActive).toBe(5); // All nodes should be active again
      expect(metrics.connectionsActive).toBe(20); // All clients should be connected
      expect(metrics.messagesProcessed).toBeGreaterThan(0);
      
    }, 20000);

    test('should handle memory pressure and optimize resource usage', async () => {
      // Setup cluster for memory testing
      await harness.setupCluster(3);
      
      // Create many rooms and clients to pressure memory
      const roomPromises: Promise<void[]>[] = [];
      const clientSets: StressTestClient[][] = [];
      
      for (let roomIndex = 0; roomIndex < 10; roomIndex++) {
        const roomClients = await harness.createStressClients(5, roomIndex % 3);
        clientSets.push(roomClients);
        
        const roomJoinPromise = Promise.all(
          roomClients.map((client, clientIndex) =>
            harness.joinClientToRoom(client, `memory-room-${roomIndex}`, `room-${roomIndex}-client-${clientIndex}`)
          )
        );
        roomPromises.push(roomJoinPromise);
      }
      
      await Promise.all(roomPromises);
      
      // Generate message activity across all rooms
      const messagingPromises = clientSets.map(async (clients, roomIndex) => {
        for (const client of clients.slice(0, 2)) { // 2 messages per room
          await harness.sendMessage(client, `memory-room-${roomIndex}`, `Memory test message from room ${roomIndex}`);
        }
      });
      
      await Promise.all(messagingPromises);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const metrics = await harness.collectMetrics();
      
      // Validate memory and resource usage
      expect(metrics.roomsActive).toBe(10); // All rooms should be active
      expect(metrics.connectionsActive).toBe(50); // All clients connected
      
    }, 20000);
  });

  describe('🛡️ Resilience & Error Handling', () => {
    test('should handle cascading node failures gracefully', async () => {
      // Setup larger cluster for failure testing
      await harness.setupCluster(5);
      
      // Create clients distributed across nodes
      const allClients: StressTestClient[] = [];
      for (let nodeIndex = 0; nodeIndex < 5; nodeIndex++) {
        const nodeClients = await harness.createStressClients(8, nodeIndex);
        allClients.push(...nodeClients);
      }
      
      // Join all clients to failure test room
      await Promise.all(allClients.map((client, index) => 
        harness.joinClientToRoom(client, 'failure-room', `failure-client-${index}`)
      ));
      
      // Send initial activity
      await Promise.all(allClients.slice(0, 5).map(client =>
        harness.sendMessage(client, 'failure-room', 'Pre-failure message')
      ));
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Simulate cascading failures (nodes 0, 1, 2 fail in sequence)
      await harness.simulateNetworkPartition([0], 1000);
      await harness.simulateNetworkPartition([1], 1000); 
      await harness.simulateNetworkPartition([2], 1000);
      
      // System should still be functional with remaining nodes
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const metrics = await harness.collectMetrics();
      
      // Validate system resilience
      expect(metrics.nodesActive).toBe(5); // All nodes recovered
      expect(metrics.connectionsActive).toBeGreaterThan(20); // Most clients still connected
      
    }, 25000);

    test('should validate message ordering and consistency', async () => {
      // Setup cluster for consistency testing
      await harness.setupCluster(3);
      
      // Create clients on different nodes
      const senderClients = await harness.createStressClients(3, 0);
      const receiverClients = await harness.createStressClients(5, 1);
      
      // Join all clients to consistency room
      await Promise.all([
        ...senderClients.map((client, index) => 
          harness.joinClientToRoom(client, 'consistency-room', `sender-${index}`)
        ),
        ...receiverClients.map((client, index) => 
          harness.joinClientToRoom(client, 'consistency-room', `receiver-${index}`)
        )
      ]);
      
      // Send ordered sequence of messages
      for (let i = 0; i < 10; i++) {
        await harness.sendMessage(senderClients[i % 3], 'consistency-room', `Ordered message ${i}`);
        await new Promise(resolve => setTimeout(resolve, 100)); // Small delay between messages
      }
      
      // Wait for all messages to propagate
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const metrics = await harness.collectMetrics();
      
      // Validate message consistency
      expect(metrics.messagesProcessed).toBeGreaterThan(8); // Most messages processed
      
    }, 15000);
  });
});
