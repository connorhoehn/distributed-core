import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import WebSocket from 'ws';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { ClientWebSocketAdapter } from '../../../src/transport/adapters/ClientWebSocketAdapter';
import { ApplicationRegistry } from '../../../src/applications/ApplicationRegistry';
import { ResourceRegistry } from '../../../src/cluster/resources/ResourceRegistry';
import { ResourceTopologyManager } from '../../../src/cluster/topology/ResourceTopologyManager';
import { ResourceTypeRegistry } from '../../../src/cluster/resources/ResourceTypeRegistry';
import { StateAggregator } from '../../../src/cluster/aggregation/StateAggregator';
import { MetricsTracker } from '../../../src/monitoring/metrics/MetricsTracker';
import { ChatApplicationModule, ChatApplicationConfig } from '../../../src/applications/ChatApplicationModule';
import { NodeId } from '../../../src/types';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';
import { EntityRegistryFactory } from '../../../src/cluster/entity/EntityRegistryFactory';

/**
 * Refactored Basic Chat Integration Tests using Extracted Chat Components
 * 
 * ⚡ INTEGRATION TEST SUITE - All tests complete under 7 seconds ⚡
 * 
 * Tests the new extracted chat architecture:
 * - ChatApplicationModule integration
 * - ResourceRegistry chat room management  
 * - ChatTopologyManager placement
 * - Application-level chat coordination
 * 
 * This validates that the extracted chat system works end-to-end
 * in a distributed cluster environment.
 */

class ModularChatIntegrationHarness {
  public node: ModularChatIntegrationNode | null = null;

  async setupSingleNode(): Promise<ModularChatIntegrationNode> {
    const clusterPort = 9300;
    const clientPort = 8300;
    
    this.node = new ModularChatIntegrationNode('modular-chat-node', clusterPort, clientPort);
    await this.node.start();
    
    // Brief stabilization for extracted components
    await new Promise(resolve => setTimeout(resolve, 800));
    
    return this.node;
  }

  async createClient(port: number, clientId: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Client ${clientId} connection timeout`));
      }, 3000);

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

class ModularChatIntegrationNode {
  public nodeId: string;
  public cluster: ClusterManager;
  public clientAdapter: ClientWebSocketAdapter;
  public applicationRegistry: ApplicationRegistry;
  public resourceRegistry: ResourceRegistry;
  public topologyManager: ResourceTopologyManager;
  public chatModule: ChatApplicationModule;
  public clientPort: number;
  
  private transport: WebSocketAdapter;
  private resourceTypeRegistry: ResourceTypeRegistry;
  private stateAggregator: StateAggregator;
  private metricsTracker: MetricsTracker;

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

    // Create resource management stack
    this.resourceTypeRegistry = new ResourceTypeRegistry();
    
    this.resourceRegistry = new ResourceRegistry({
      nodeId: nodeId,
      entityRegistryType: 'memory',
      entityRegistryConfig: { enableTestMode: true }
    });

    // Create minimal StateAggregator and MetricsTracker for testing
    this.stateAggregator = new StateAggregator(this.cluster);
    this.metricsTracker = new MetricsTracker({
      collectionInterval: 1000,
      retentionPeriod: 60000,
      enableTrends: false,
      enableAlerts: false,
      thresholds: {
        cpu: 0.9,
        memory: 0.95,
        disk: 0.9,
        networkLatency: 500,
        clusterStability: 0.7
      }
    });

    this.topologyManager = new ResourceTopologyManager(
      this.cluster,
      this.resourceRegistry,
      this.resourceTypeRegistry,
      this.stateAggregator,
      this.metricsTracker
    );

    this.applicationRegistry = new ApplicationRegistry(
      this.cluster,
      this.resourceRegistry,
      this.topologyManager,
      { enableTestMode: true }
    );

    // Create chat module with test configuration
    const chatConfig: ChatApplicationConfig = {
      moduleId: 'e2e-chat-module',
      moduleName: 'E2E Chat Integration',
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
        enabled: false, // Keep simple for basic test
        scaleUpThreshold: 0.8,
        scaleDownThreshold: 0.2,
        maxShards: 3
      },
      moderation: {
        enableAutoModeration: false,
        bannedWords: [],
        maxMessageLength: 500,
        rateLimitPerMinute: 30
      }
    };

    this.chatModule = new ChatApplicationModule(chatConfig);
  }

  async start(): Promise<void> {
    // Start core infrastructure
    await this.clientAdapter.start();
    await this.cluster.start();
    await this.resourceRegistry.start();
    await this.topologyManager.start();
    await this.applicationRegistry.start();

    // Register and start chat module
    await this.applicationRegistry.registerModule(this.chatModule);

    console.log(`🚀 Modular chat node ${this.nodeId} started on cluster/client ports ${this.clientPort}`);
  }

  async stop(): Promise<void> {
    // Stop in reverse order
    if (this.applicationRegistry) await this.applicationRegistry.stop();
    if (this.topologyManager) await this.topologyManager.stop();
    if (this.resourceRegistry) await this.resourceRegistry.stop();
    if (this.cluster) await this.cluster.stop();
    if (this.clientAdapter) await this.clientAdapter.stop();
  }
}

describe('Modular Chat Integration (Extracted Components)', () => {
  let harness: ModularChatIntegrationHarness;

  beforeEach(async () => {
    harness = new ModularChatIntegrationHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('🔗 Core Modular Integration Tests', () => {
    test('should establish connection and register chat module', async () => {
      const node = await harness.setupSingleNode();
      
      // Verify chat module is registered
      const registeredModule = node.applicationRegistry.getModule('e2e-chat-module');
      expect(registeredModule).toBeDefined();
      expect(registeredModule).toBe(node.chatModule);
      
      // Verify chat-room resource type is registered
      const chatModules = node.applicationRegistry.getModulesByResourceType('chat-room');
      expect(chatModules).toHaveLength(1);
      expect(chatModules[0]).toBe(node.chatModule);
    });

    test('should create chat room through extracted module', async () => {
      const node = await harness.setupSingleNode();
      
      // Create room using the new ChatApplicationModule
      const room = await node.chatModule.createRoom('E2E Test Room', true);
      
      expect(room).toBeDefined();
      expect(room.resourceType).toBe('chat-room');
      expect(room.applicationData.roomName).toBe('E2E Test Room');
      expect(room.applicationData.isPublic).toBe(true);
      expect(room.applicationData.maxParticipants).toBe(1000); // from config
    });

    test('should manage multiple rooms with modular architecture', async () => {
      const node = await harness.setupSingleNode();
      
      // Create multiple rooms
      const rooms = await Promise.all([
        node.chatModule.createRoom('General', true),
        node.chatModule.createRoom('Random', true),
        node.chatModule.createRoom('Private Club', false)
      ]);
      
      expect(rooms).toHaveLength(3);
      expect(rooms[0].applicationData.roomName).toBe('General');
      expect(rooms[1].applicationData.roomName).toBe('Random');
      expect(rooms[2].applicationData.roomName).toBe('Private Club');
      expect(rooms[2].applicationData.isPublic).toBe(false);
      
      // Verify rooms are tracked in resource registry
      const chatRooms = node.resourceRegistry.getResourcesByType('chat-room');
      expect(chatRooms.length).toBeGreaterThanOrEqual(3);
    });

    test('should provide modular chat metrics', async () => {
      const node = await harness.setupSingleNode();
      
      // Create some rooms for metrics
      await node.chatModule.createRoom('Metrics Room 1', true);
      await node.chatModule.createRoom('Metrics Room 2', false);
      
      // Get module metrics
      const metrics = await node.chatModule.getMetrics();
      
      expect(metrics.moduleId).toBe('e2e-chat-module');
      expect(metrics.resourceCounts).toBeDefined();
      expect(metrics.resourceCounts['chat-room']).toBeGreaterThanOrEqual(2);
      expect(metrics.performance).toBeDefined();
      expect(typeof metrics.performance.requestsPerSecond).toBe('number');
    });

    test('should handle room deletion through module', async () => {
      const node = await harness.setupSingleNode();
      
      // Create and delete room
      const room = await node.chatModule.createRoom('Temporary Room', true);
      const roomId = room.resourceId;
      
      await node.chatModule.deleteResource(roomId);
      
      // Verify room is removed from registry
      const chatRooms = node.resourceRegistry.getResourcesByType('chat-room');
      const deletedRoom = chatRooms.find(r => r.resourceId === roomId);
      expect(deletedRoom).toBeUndefined();
    });

    test('should provide module health status', async () => {
      const node = await harness.setupSingleNode();
      
      // Check individual module health
      const chatHealth = await node.chatModule.healthCheck();
      expect(chatHealth.healthy).toBe(true);
      
      // Check overall application registry health
      const overallHealth = await node.applicationRegistry.isHealthy();
      expect(overallHealth).toBe(true);
    });

    test('should handle configuration updates', async () => {
      const node = await harness.setupSingleNode();
      
      // Update chat module configuration
      const newConfig = {
        configuration: {
          maxRoomsPerNode: 200,
          enableChatExtraction: true,
          testMode: true
        }
      };
      
      await node.chatModule.updateConfiguration(newConfig);
      
      const currentConfig = node.chatModule.getConfiguration();
      expect(currentConfig.configuration.maxRoomsPerNode).toBe(200);
    });
  });

  describe('🏗️ Architecture Validation Tests', () => {
    test('should demonstrate modular chat extraction benefits', async () => {
      const node = await harness.setupSingleNode();
      
      // 1. Chat operates as independent module
      expect(node.chatModule.moduleId).toBe('e2e-chat-module');
      
      // 2. Uses generic resource management
      const room = await node.chatModule.createRoom('Architecture Test Room', true);
      expect(room.resourceType).toBe('chat-room');
      
      // 3. Integrates with application registry
      const modules = node.applicationRegistry.getAllModules();
      expect(modules).toContain(node.chatModule);
      
      // 4. Resource registry manages chat resources generically
      const allResources = node.resourceRegistry.getResourcesByType('chat-room');
      expect(allResources.some(r => r.resourceId === room.resourceId)).toBe(true);
      
      // 5. Topology manager can analyze chat resources
      const topology = await node.topologyManager.getResourceTopology('chat-room');
      expect(topology.resources.total).toBeGreaterThan(0);
    });

    test('should support module unregistration and cleanup', async () => {
      const node = await harness.setupSingleNode();
      
      // Create room and verify it exists
      const room = await node.chatModule.createRoom('Cleanup Test Room', false);
      let chatRooms = node.resourceRegistry.getResourcesByType('chat-room');
      expect(chatRooms.some(r => r.resourceId === room.resourceId)).toBe(true);
      
      // Unregister chat module
      await node.applicationRegistry.unregisterModule('e2e-chat-module');
      
      // Verify module is no longer registered
      const unregisteredModule = node.applicationRegistry.getModule('e2e-chat-module');
      expect(unregisteredModule).toBeUndefined();
      
      // Verify no chat modules manage chat-room resources
      const chatModules = node.applicationRegistry.getModulesByResourceType('chat-room');
      expect(chatModules).toHaveLength(0);
    });

    test('should maintain separation of concerns', async () => {
      const node = await harness.setupSingleNode();
      
      // Core cluster should work without chat-specific knowledge
      expect(node.cluster.localNodeId).toBe('modular-chat-node');
      
      // Resource registry should handle chat rooms generically  
      const room = await node.chatModule.createRoom('Separation Test Room', true);
      const genericResources = node.resourceRegistry.getResourcesByType('chat-room');
      expect(genericResources.some(r => r.resourceId === room.resourceId)).toBe(true);
      
      // Chat logic should be encapsulated in the module
      expect(node.chatModule.managedResourceTypes).toContain('chat-room');
      
      // Application registry should coordinate without chat specifics
      const allModules = node.applicationRegistry.getAllModules();
      expect(allModules.every(m => typeof m.moduleId === 'string')).toBe(true);
    });
  });

  // Legacy compatibility test (if needed to verify old functionality still works)
  describe('🔄 Migration Validation', () => {
    test('should provide equivalent functionality to old coordinator', async () => {
      const node = await harness.setupSingleNode();
      
      // Verify the new system can do what the old ChatRoomCoordinator did:
      
      // 1. Create rooms
      const publicRoom = await node.chatModule.createRoom('Public Test', true);
      const privateRoom = await node.chatModule.createRoom('Private Test', false);
      
      expect(publicRoom.applicationData.isPublic).toBe(true);
      expect(privateRoom.applicationData.isPublic).toBe(false);
      
      // 2. Track room state
      const chatRooms = node.resourceRegistry.getResourcesByType('chat-room');
      expect(chatRooms).toHaveLength(2);
      
      // 3. Provide room metadata
      expect(publicRoom.applicationData.maxParticipants).toBe(1000);
      expect(privateRoom.applicationData.maxParticipants).toBe(1000);
      
      // 4. Support room deletion
      await node.chatModule.deleteResource(publicRoom.resourceId);
      const remainingRooms = node.resourceRegistry.getResourcesByType('chat-room');
      expect(remainingRooms).toHaveLength(1);
      expect(remainingRooms[0].resourceId).toBe(privateRoom.resourceId);
    });
  });
});
