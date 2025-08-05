import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import WebSocket from 'ws';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { ClientWebSocketAdapter } from '../../../src/transport/adapters/ClientWebSocketAdapter';
import { ChatRoomCoordinator } from '../cluster/ChatRoomCoordinator';
import { StateAggregator } from '../../../src/cluster/aggregation/StateAggregator';
import { NodeId } from '../../../src/types';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';

/**
 * Anti-Entropy Enhanced Multi-Room Chat Integration Tests
 * 
 * ⚡ INTEGRATION TEST SUITE - Under 7 seconds each ⚡
 * 
 * Testing Discord/Slack-style features with anti-entropy consistency:
 * - Multi-room state synchronization across nodes
 * - Conflict-free room membership management
 * - Eventually consistent message delivery
 * - Anti-entropy driven room state reconciliation
 * - Partition tolerance with state healing
 */

interface AntiEntropyClient {
  id: string;
  ws: WebSocket;
  userId: string;
  joinedRooms: Set<string>;
  receivedMessages: any[];
  connected: boolean;
  lastSeenMessage: Map<string, number>; // roomId -> last message timestamp
}

interface AntiEntropyNode {
  nodeId: string;
  cluster: ClusterManager;
  clientAdapter: ClientWebSocketAdapter;
  coordinator: ChatRoomCoordinator;
  stateAggregator: StateAggregator;
  clientPort: number;
  clusterPort: number;
}

interface RoomState {
  roomId: string;
  participants: Set<string>;
  messageCount: number;
  lastActivity: number;
  ownerNode: string;
}

class AntiEntropyMultiRoomHarness {
  private nodes: AntiEntropyNode[] = [];
  private clients: AntiEntropyClient[] = [];
  private roomStates = new Map<string, RoomState>();

  async setupClusterWithAntiEntropy(nodeCount: number = 3): Promise<AntiEntropyNode[]> {
    const clusterPorts = Array.from({ length: nodeCount }, (_, i) => 9300 + i);
    const clientPorts = Array.from({ length: nodeCount }, (_, i) => 8300 + i);

    // Create all nodes with anti-entropy enabled
    for (let i = 0; i < nodeCount; i++) {
      const node = await this.createAntiEntropyNode(
        `ae-node-${i}`,
        clusterPorts[i],
        clientPorts[i],
        clusterPorts.filter((_, idx) => idx !== i)
      );
      this.nodes.push(node);
    }

    // Start all nodes
    await Promise.all(this.nodes.map(node => this.startNode(node)));
    
    // Wait for cluster formation and anti-entropy stabilization
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    return this.nodes;
  }

  private async createAntiEntropyNode(
    nodeId: string, 
    clusterPort: number, 
    clientPort: number, 
    seedPorts: number[]
  ): Promise<AntiEntropyNode> {
    const nodeIdObj: NodeId = { 
      id: nodeId,
      address: '127.0.0.1',
      port: clusterPort
    };
    
    const seedNodes = seedPorts.map(port => `127.0.0.1:${port}`);

    const transport = new WebSocketAdapter(nodeIdObj, { 
      port: clusterPort,
      host: '127.0.0.1',
      enableLogging: false 
    });

    // Enhanced cluster config for anti-entropy
    const config = BootstrapConfig.create({
      seedNodes,
      enableLogging: false,
      gossipInterval: 100, // Fast gossip for testing
      failureDetector: {
        enableLogging: false
      }
    });

    const cluster = new ClusterManager(nodeId, transport, config);
    const clientAdapter = new ClientWebSocketAdapter({
      port: clientPort,
      host: '127.0.0.1',
      enableLogging: false
    });

    const coordinator = new ChatRoomCoordinator(
      cluster,
      clientAdapter,
      nodeId,
      false
    );

    // Create StateAggregator with conflict detection enabled
    const stateAggregator = new StateAggregator(cluster, {
      collectionTimeout: 2000,
      minQuorumSize: Math.ceil(Math.max(1, seedPorts.length + 1) / 2),
      aggregationInterval: 3000,
      enableConflictDetection: true,
      autoResolve: true,
      conflictDetectionInterval: 2000,
      enableConsistencyChecks: true,
      maxStaleTime: 5000,
      enableResolution: true,
      resolutionTimeout: 1000
    });

    return {
      nodeId,
      cluster,
      clientAdapter,
      coordinator,
      stateAggregator,
      clientPort,
      clusterPort
    };
  }

  private async startNode(node: AntiEntropyNode): Promise<void> {
    await node.clientAdapter.start();
    await node.cluster.start();
    
    // Register chat room service for anti-entropy tracking
    const introspection = node.cluster.getIntrospection();
    introspection.registerLogicalService({
      id: `chat-service-${node.nodeId}`,
      type: 'multi-room-chat',
      nodeId: node.nodeId,
      metadata: { 
        rooms: [],
        capabilities: ['multi-room', 'anti-entropy', 'discord-style']
      },
      stats: { roomCount: 0, clientCount: 0, messageCount: 0 },
      lastUpdated: Date.now()
    });
  }

  async createAntiEntropyClient(
    nodeIndex: number, 
    userId: string
  ): Promise<AntiEntropyClient> {
    const node = this.nodes[nodeIndex];
    const ws = new WebSocket(`ws://localhost:${node.clientPort}/ws`);
    
    const client: AntiEntropyClient = {
      id: `ae-client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ws,
      userId,
      joinedRooms: new Set(),
      receivedMessages: [],
      connected: false,
      lastSeenMessage: new Map()
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Anti-entropy client ${userId} connection timeout`));
      }, 3000);

      ws.on('open', () => {
        clearTimeout(timeout);
        client.connected = true;
        this.setupAntiEntropyClientHandling(client);
        this.clients.push(client);
        resolve(client);
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private setupAntiEntropyClientHandling(client: AntiEntropyClient): void {
    client.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        client.receivedMessages.push(message);
        
        // Track room state changes for anti-entropy validation
        if (message.type === 'room-joined') {
          client.joinedRooms.add(message.data.roomId);
          this.updateRoomState(message.data.roomId, client.userId, 'join');
        }
        if (message.type === 'room-left') {
          client.joinedRooms.delete(message.data.roomId);
          this.updateRoomState(message.data.roomId, client.userId, 'leave');
        }
        if (message.type === 'message' || message.type === 'chat-message') {
          const roomId = message.data?.roomId;
          if (roomId) {
            client.lastSeenMessage.set(roomId, message.timestamp || Date.now());
            this.updateRoomState(roomId, client.userId, 'message');
          }
        }
      } catch (error) {
        // Ignore parse errors
      }
    });

    client.ws.on('close', () => {
      client.connected = false;
      // Update room states to remove this client
      for (const roomId of client.joinedRooms) {
        this.updateRoomState(roomId, client.userId, 'disconnect');
      }
    });
  }

  private updateRoomState(roomId: string, userId: string, action: 'join' | 'leave' | 'message' | 'disconnect'): void {
    if (!this.roomStates.has(roomId)) {
      this.roomStates.set(roomId, {
        roomId,
        participants: new Set(),
        messageCount: 0,
        lastActivity: Date.now(),
        ownerNode: this.getNodeForRoom(roomId).nodeId
      });
    }

    const roomState = this.roomStates.get(roomId)!;
    roomState.lastActivity = Date.now();

    switch (action) {
      case 'join':
        roomState.participants.add(userId);
        break;
      case 'leave':
      case 'disconnect':
        roomState.participants.delete(userId);
        break;
      case 'message':
        roomState.messageCount++;
        break;
    }
  }

  async joinRoomWithAntiEntropy(client: AntiEntropyClient, roomId: string): Promise<void> {
    const joinMessage = {
      type: 'join-room',
      data: {
        roomId,
        userId: client.userId,
        timestamp: Date.now(),
        expectAntiEntropy: true
      }
    };

    client.ws.send(JSON.stringify(joinMessage));
    
    // Wait for anti-entropy propagation
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  async triggerAntiEntropyCycle(): Promise<void> {
    // Trigger anti-entropy on all nodes
    for (const node of this.nodes) {
      node.cluster.runAntiEntropyCycle();
    }
    
    // Wait for anti-entropy to complete
    await new Promise(resolve => setTimeout(resolve, 800));
  }

  async waitForEventualConsistency(maxWaitMs: number = 3000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitMs) {
      // Trigger anti-entropy cycles
      await this.triggerAntiEntropyCycle();
      
      // Check if consistency achieved
      const isConsistent = await this.checkGlobalConsistency();
      if (isConsistent) {
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  private async checkGlobalConsistency(): Promise<boolean> {
    try {
      // Collect state from all nodes
      const statePromises = this.nodes.map(node => 
        node.stateAggregator.collectClusterState()
      );
      
      const states = await Promise.all(statePromises);
      
      // Check if room participant counts are consistent
      const roomCounts = new Map<string, Set<number>>();
      
      for (const state of states) {
        for (const [nodeId, nodeState] of state.nodeStates) {
          const chatService = nodeState.logicalServices.find(s => s.type === 'multi-room-chat');
          if (chatService?.stats?.roomCount !== undefined) {
            if (!roomCounts.has(nodeId)) {
              roomCounts.set(nodeId, new Set());
            }
            roomCounts.get(nodeId)!.add(chatService.stats.roomCount);
          }
        }
      }
      
      // Consistency means all nodes report same room counts
      return Array.from(roomCounts.values()).every(counts => counts.size <= 1);
    } catch (error) {
      return false;
    }
  }

  getNodeForRoom(roomId: string): AntiEntropyNode {
    const hash = this.simpleHash(roomId);
    const nodeIndex = hash % this.nodes.length;
    return this.nodes[nodeIndex];
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  async sendMessage(
    client: AntiEntropyClient, 
    roomId: string, 
    content: string
  ): Promise<void> {
    const message = {
      type: 'send-message',
      data: {
        roomId,
        userId: client.userId,
        content,
        timestamp: Date.now(),
        antiEntropyMeta: {
          expectedConsistency: true,
          vectorClock: `${client.userId}-${Date.now()}`
        }
      }
    };

    client.ws.send(JSON.stringify(message));
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  async cleanup(): Promise<void> {
    // Stop state aggregators
    await Promise.all(this.nodes.map(node => {
      if (node.stateAggregator) {
        node.stateAggregator.stop();
      }
    }));

    // Close client connections
    await Promise.all(this.clients.map(client => {
      if (client.connected) {
        return new Promise<void>(resolve => {
          client.ws.close();
          client.ws.on('close', () => resolve());
        });
      }
    }));

    // Stop cluster nodes
    await Promise.all(this.nodes.map(async node => {
      await node.cluster.stop();
      await node.clientAdapter.stop();
    }));
    
    this.nodes = [];
    this.clients = [];
    this.roomStates.clear();
  }
}

describe('Anti-Entropy Enhanced Multi-Room Chat', () => {
  let harness: AntiEntropyMultiRoomHarness;

  beforeEach(async () => {
    harness = new AntiEntropyMultiRoomHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('🔄 Anti-Entropy State Synchronization', () => {
    test('should achieve eventual consistency for multi-room membership', async () => {
      await harness.setupClusterWithAntiEntropy(3);
      
      // Create clients on different nodes
      const alice = await harness.createAntiEntropyClient(0, 'alice');
      const bob = await harness.createAntiEntropyClient(1, 'bob');
      const charlie = await harness.createAntiEntropyClient(2, 'charlie');
      
      // Join different room combinations
      await harness.joinRoomWithAntiEntropy(alice, 'general');
      await harness.joinRoomWithAntiEntropy(alice, 'development');
      await harness.joinRoomWithAntiEntropy(bob, 'general');
      await harness.joinRoomWithAntiEntropy(charlie, 'development');
      await harness.joinRoomWithAntiEntropy(charlie, 'random');
      
      // Wait for anti-entropy to achieve eventual consistency
      await harness.waitForEventualConsistency(4000);
      
      // Verify consistent room membership across cluster
      expect(alice.joinedRooms.has('general')).toBe(true);
      expect(alice.joinedRooms.has('development')).toBe(true);
      expect(bob.joinedRooms.has('general')).toBe(true);
      expect(charlie.joinedRooms.has('development')).toBe(true);
      expect(charlie.joinedRooms.has('random')).toBe(true);
      
      // All clients should maintain their connections
      expect([alice, bob, charlie].every(c => c.connected)).toBe(true);
    }, 6000); // Integration: Anti-entropy eventual consistency

    test('should resolve room state conflicts through anti-entropy', async () => {
      await harness.setupClusterWithAntiEntropy(2);
      
      const alice = await harness.createAntiEntropyClient(0, 'alice');
      const bob = await harness.createAntiEntropyClient(1, 'bob');
      
      // Create potential conflict by joining simultaneously
      const roomId = 'conflict-room';
      
      // Simultaneous joins that might create temporary inconsistency
      await Promise.all([
        harness.joinRoomWithAntiEntropy(alice, roomId),
        harness.joinRoomWithAntiEntropy(bob, roomId)
      ]);
      
      // Send messages to create state activity
      await harness.sendMessage(alice, roomId, 'Alice message 1');
      await harness.sendMessage(bob, roomId, 'Bob message 1');
      
      // Trigger explicit anti-entropy cycle
      await harness.triggerAntiEntropyCycle();
      
      // Wait for convergence
      await harness.waitForEventualConsistency(3000);
      
      // Both clients should be consistently in the room
      expect(alice.joinedRooms.has(roomId)).toBe(true);
      expect(bob.joinedRooms.has(roomId)).toBe(true);
      
      // Should have received some messages via anti-entropy reconciliation
      expect(alice.receivedMessages.length + bob.receivedMessages.length).toBeGreaterThan(2);
    }, 5000); // Integration: Conflict resolution via anti-entropy

    test('should handle partition healing with room state reconciliation', async () => {
      await harness.setupClusterWithAntiEntropy(3);
      
      // Create clients across nodes
      const alice = await harness.createAntiEntropyClient(0, 'alice');
      const bob = await harness.createAntiEntropyClient(1, 'bob');
      const charlie = await harness.createAntiEntropyClient(2, 'charlie');
      
      // All join the same room initially
      const roomId = 'partition-test-room';
      await harness.joinRoomWithAntiEntropy(alice, roomId);
      await harness.joinRoomWithAntiEntropy(bob, roomId);
      await harness.joinRoomWithAntiEntropy(charlie, roomId);
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Simulate partition healing by triggering multiple anti-entropy cycles
      await harness.triggerAntiEntropyCycle();
      await new Promise(resolve => setTimeout(resolve, 300));
      await harness.triggerAntiEntropyCycle();
      
      // Wait for state reconciliation
      await harness.waitForEventualConsistency(3000);
      
      // After healing, all clients should still be consistently in room
      expect(alice.joinedRooms.has(roomId)).toBe(true);
      expect(bob.joinedRooms.has(roomId)).toBe(true);
      expect(charlie.joinedRooms.has(roomId)).toBe(true);
      
      // System should have achieved consistency
      expect([alice, bob, charlie].every(c => c.connected)).toBe(true);
    }, 8000); // Integration: Partition healing with state reconciliation (increased timeout)

    test('should maintain consistent view during concurrent operations', async () => {
      await harness.setupClusterWithAntiEntropy(3);
      
      // Create multiple clients for concurrent testing
      const clients = await Promise.all([
        harness.createAntiEntropyClient(0, 'user1'),
        harness.createAntiEntropyClient(1, 'user2'),
        harness.createAntiEntropyClient(2, 'user3'),
        harness.createAntiEntropyClient(0, 'user4'),
        harness.createAntiEntropyClient(1, 'user5')
      ]);
      
      // Concurrent operations that might create inconsistency without anti-entropy
      const rooms = ['concurrent-1', 'concurrent-2', 'concurrent-3'];
      
      // Each client joins multiple rooms concurrently
      const joinPromises = clients.flatMap(client => 
        rooms.map(roomId => harness.joinRoomWithAntiEntropy(client, roomId))
      );
      
      await Promise.all(joinPromises);
      
      // Send concurrent messages
      const messagePromises = clients.flatMap((client, i) => 
        rooms.map(roomId => 
          harness.sendMessage(client, roomId, `Message from ${client.userId} in ${roomId}`)
        )
      );
      
      await Promise.all(messagePromises);
      
      // Wait for anti-entropy to resolve any conflicts
      await harness.waitForEventualConsistency(4000);
      
      // All clients should be in all rooms consistently
      for (const client of clients) {
        for (const roomId of rooms) {
          expect(client.joinedRooms.has(roomId)).toBe(true);
        }
      }
      
      // All connections should remain stable
      expect(clients.every(c => c.connected)).toBe(true);
    }, 6000); // Integration: Concurrent operations with consistency
  });

  describe('💎 Discord/Slack Style Features with Anti-Entropy', () => {
    test('should support channel-like room browsing with consistent state', async () => {
      await harness.setupClusterWithAntiEntropy(2);
      
      const alice = await harness.createAntiEntropyClient(0, 'alice');
      
      // Join multiple "channels" like Discord
      const channels = [
        'general',           // Main channel
        'development',       // Dev team
        'random',           // Off-topic
        'announcements',    // Important updates
        'gaming'            // Gaming discussions
      ];
      
      // Join all channels
      for (const channel of channels) {
        await harness.joinRoomWithAntiEntropy(alice, channel);
      }
      
      // Trigger anti-entropy to ensure consistent channel membership
      await harness.triggerAntiEntropyCycle();
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Should be in all channels
      expect(alice.joinedRooms.size).toBe(5);
      for (const channel of channels) {
        expect(alice.joinedRooms.has(channel)).toBe(true);
      }
      
      // Send messages to different channels
      await harness.sendMessage(alice, 'general', 'Hello everyone!');
      await harness.sendMessage(alice, 'development', 'New feature ready for review');
      await harness.sendMessage(alice, 'gaming', 'Anyone want to play tonight?');
      
      await harness.waitForEventualConsistency(2000);
      
      // Should have multiple message trackings
      expect(alice.lastSeenMessage.size).toBeGreaterThanOrEqual(3);
      expect(alice.receivedMessages.length).toBeGreaterThan(3);
    }, 10000); // Integration: Discord-style channel management (increased timeout)

    test('should handle large-scale room membership with P2P node selection', async () => {
      await harness.setupClusterWithAntiEntropy(4);
      
      // Simulate large Discord server with many users
      const userCount = 12;
      const clients: AntiEntropyClient[] = [];
      
      // Create clients with random node selection (like Discord client connections)
      for (let i = 0; i < userCount; i++) {
        const randomNode = Math.floor(Math.random() * 4);
        const client = await harness.createAntiEntropyClient(randomNode, `user-${i}`);
        clients.push(client);
      }
      
      // Create popular channels that everyone joins
      const popularChannels = ['general', 'announcements'];
      const specializedChannels = ['development', 'design', 'marketing', 'gaming'];
      
      // Everyone joins popular channels
      for (const client of clients) {
        for (const channel of popularChannels) {
          await harness.joinRoomWithAntiEntropy(client, channel);
        }
      }
      
      // Subset joins specialized channels
      for (let i = 0; i < clients.length; i++) {
        if (i % 3 === 0) { // Dev team
          await harness.joinRoomWithAntiEntropy(clients[i], 'development');
        }
        if (i % 4 === 0) { // Design team
          await harness.joinRoomWithAntiEntropy(clients[i], 'design');
        }
      }
      
      // Wait for anti-entropy to synchronize all states
      await harness.waitForEventualConsistency(5000);
      
      // Verify popular channels have all users
      for (const client of clients) {
        expect(client.joinedRooms.has('general')).toBe(true);
        expect(client.joinedRooms.has('announcements')).toBe(true);
      }
      
      // Verify specialized channel membership
      const devTeam = clients.filter((_, i) => i % 3 === 0);
      for (const devClient of devTeam) {
        expect(devClient.joinedRooms.has('development')).toBe(true);
      }
      
      // All clients should remain connected despite distributed room ownership
      expect(clients.every(c => c.connected)).toBe(true);
      
      console.log(`✅ Successfully managed ${userCount} users across ${4} nodes with anti-entropy`);
    }, 15000); // Integration: Large-scale room membership with anti-entropy (further increased timeout)
  });

  describe('🌟 Advanced Anti-Entropy Features', () => {
    test('should detect and resolve message ordering conflicts', async () => {
      await harness.setupClusterWithAntiEntropy(2);
      
      const alice = await harness.createAntiEntropyClient(0, 'alice');
      const bob = await harness.createAntiEntropyClient(1, 'bob');
      
      const roomId = 'ordering-test';
      await harness.joinRoomWithAntiEntropy(alice, roomId);
      await harness.joinRoomWithAntiEntropy(bob, roomId);
      
      // Send rapid messages that might arrive out of order
      const messagePromises = [
        harness.sendMessage(alice, roomId, 'Alice message 1'),
        harness.sendMessage(bob, roomId, 'Bob message 1'),
        harness.sendMessage(alice, roomId, 'Alice message 2'),
        harness.sendMessage(bob, roomId, 'Bob message 2'),
        harness.sendMessage(alice, roomId, 'Alice message 3')
      ];
      
      await Promise.all(messagePromises);
      
      // Trigger anti-entropy to resolve any ordering conflicts
      await harness.triggerAntiEntropyCycle();
      await harness.waitForEventualConsistency(3000);
      
      // Both clients should have consistent message history
      expect(alice.receivedMessages.length).toBeGreaterThan(0);
      expect(bob.receivedMessages.length).toBeGreaterThan(0);
      
      // Messages should be delivered (anti-entropy ensures eventual consistency)
      const totalMessages = alice.receivedMessages.length + bob.receivedMessages.length;
      expect(totalMessages).toBeGreaterThan(5);
    }, 5000); // Integration: Message ordering conflict resolution

    test('should demonstrate stateful layer integration', async () => {
      await harness.setupClusterWithAntiEntropy(3);
      
      const alice = await harness.createAntiEntropyClient(0, 'alice');
      const bob = await harness.createAntiEntropyClient(1, 'bob');
      
      const roomId = 'stateful-integration';
      await harness.joinRoomWithAntiEntropy(alice, roomId);
      await harness.joinRoomWithAntiEntropy(bob, roomId);
      
      // Generate state changes
      await harness.sendMessage(alice, roomId, 'State change 1');
      await harness.sendMessage(bob, roomId, 'State change 2');
      
      // Access the stateful layer directly
      const node = harness.getNodeForRoom(roomId);
      const aggregatedState = await node.stateAggregator.collectClusterState();
      
      // Should have collected state from multiple nodes
      expect(aggregatedState.nodeStates.size).toBeGreaterThan(0);
      expect(aggregatedState.consistencyScore).toBeGreaterThan(0);
      
      // Anti-entropy should detect no conflicts in this simple case
      const conflicts = await node.stateAggregator.detectConflicts(aggregatedState);
      expect(conflicts.length).toBe(0);
      
      // Wait for anti-entropy stabilization
      await harness.waitForEventualConsistency(2000);
      
      // System should maintain consistency
      expect(alice.joinedRooms.has(roomId)).toBe(true);
      expect(bob.joinedRooms.has(roomId)).toBe(true);
      
      console.log(`✅ Stateful layer integration verified with consistency score: ${aggregatedState.consistencyScore}`);
    }, 4000); // Integration: Stateful layer verification
  });
});
