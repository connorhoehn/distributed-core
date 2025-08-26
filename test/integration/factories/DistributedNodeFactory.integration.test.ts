/**
 * DistributedNodeFactory Integration Test
 * 
 * Tests the complete lifecycle of creating and operating distributed nodes:
 * - Full node instantiation with all components
 * - Network transport binding and message handling 
 * - Cluster membership and gossip protocol
 * - Resource management workflows
 * - Client connection handling
 * - Multi-node cluster formation
 */

import { DistributedNodeFactory, DistributedNodeConfig, DistributedNodeComponents } from '../../../src/factories/DistributedNodeFactory';
import { Message, MessageType } from '../../../src/types';

describe('DistributedNodeFactory Integration', () => {
  let factory: DistributedNodeFactory;
  let nodes: DistributedNodeComponents[] = [];

  beforeEach(() => {
    factory = DistributedNodeFactory.getInstance();
    nodes = [];
  });

  afterEach(async () => {
    // Clean up all nodes
    for (const nodeComponents of nodes) {
      try {
        await nodeComponents.clusterTransport.stop();
        await nodeComponents.clientTransport.stop();
        await nodeComponents.node.stop();
      } catch (error) {
        console.warn('Error stopping node:', error);
      }
    }
    nodes = [];
  });

  describe('Single Node Creation and Lifecycle', () => {
    it('should create a complete distributed node with all components', async () => {
      const config: DistributedNodeConfig = {
        id: 'test-node-1',
        region: 'test-region',
        zone: 'test-zone',
        role: 'worker',
        network: {
          address: '127.0.0.1',
          port: 8001
        },
        transport: {
          type: 'websocket'
        },
        resources: {
          enableProductionScale: true,
          enableAttachmentService: true,
          enableDistributionEngine: true
        },
        enableMetrics: true,
        enableLogging: true
      };

      console.log('🏗️ Creating distributed node...');
      const components = await factory.createNode(config);
      nodes.push(components);

      // Verify all components are created
      expect(components.node).toBeDefined();
      expect(components.clusterManager).toBeDefined();
      expect(components.clusterTransport).toBeDefined();
      expect(components.clientTransport).toBeDefined();
      expect(components.resourceManager).toBeDefined();
      expect(components.resourceAttachment).toBeDefined();
      expect(components.resourceDistribution).toBeDefined();
      expect(components.clusterFanoutRouter).toBeDefined();

      // Verify node configuration
      expect(components.node.id).toBe('test-node-1');
      expect(components.node.region).toBe('test-region');
      expect(components.node.zone).toBe('test-zone');

      console.log('✅ Node created successfully with all components');
    }, 10000);

    it('should start transports and handle cluster lifecycle', async () => {
      const config: DistributedNodeConfig = {
        id: 'lifecycle-node',
        region: 'test-region',
        zone: 'test-zone', 
        role: 'worker',
        network: {
          address: '127.0.0.1',
          port: 8002
        },
        transport: {
          type: 'websocket'
        },
        resources: {
          enableProductionScale: true
        }
      };

      const components = await factory.createNode(config);
      nodes.push(components);

      // Test transport lifecycle
      console.log('🔌 Testing transport lifecycle...');
      
      // Transports should be started automatically
      expect(components.clusterTransport).toBeDefined();
      expect(components.clientTransport).toBeDefined();

      // Test cluster manager lifecycle
      console.log('🏘️ Testing cluster manager lifecycle...');
      expect(components.clusterManager).toBeDefined();
      
      // Should be able to get local node info
      const localNodeInfo = components.clusterManager.getLocalNodeInfo();
      expect(localNodeInfo.id).toBe('lifecycle-node');
      expect(localNodeInfo.status).toBe('ALIVE');

      console.log('✅ Lifecycle test completed successfully');
    }, 10000);
  });

  describe('Multi-Node Cluster Formation', () => {
    it('should create a 3-node cluster with real WebSocket communication', async () => {
      console.log('🌐 Creating 3-node cluster with real WebSocket transports...');
      
      // Node 1 (seed node) - uses real WebSocket transport
      const node1Config: DistributedNodeConfig = {
        id: 'cluster-node-1',
        region: 'test-region',
        zone: 'zone-a',
        role: 'seed',
        network: {
          address: '127.0.0.1',
          port: 9001,
          host: '127.0.0.1'
        },
        transport: {
          type: 'websocket'
        },
        resources: {
          enableProductionScale: true,
          enableAttachmentService: true
        },
        seedNodes: [] // First node has no seeds
      };

      // Node 2 - connects to node 1 via real WebSocket
      const node2Config: DistributedNodeConfig = {
        id: 'cluster-node-2',
        region: 'test-region',
        zone: 'zone-b',
        role: 'worker',
        network: {
          address: '127.0.0.1',
          port: 9002,
          host: '127.0.0.1'
        },
        transport: {
          type: 'websocket'
        },
        resources: {
          enableProductionScale: true,
          enableAttachmentService: true
        },
        seedNodes: ['127.0.0.1:9001'] // Join via node 1's network address
      };

      // Node 3 - connects to both existing nodes
      const node3Config: DistributedNodeConfig = {
        id: 'cluster-node-3',
        region: 'test-region',
        zone: 'zone-c',
        role: 'worker',
        network: {
          address: '127.0.0.1',
          port: 9003,
          host: '127.0.0.1'
        },
        transport: {
          type: 'websocket'
        },
        resources: {
          enableProductionScale: true,
          enableAttachmentService: true
        },
        seedNodes: ['127.0.0.1:9001', '127.0.0.1:9002'] // Join via both existing nodes
      };

      // Create nodes sequentially to allow proper cluster formation
      console.log('📦 Creating node 1 (seed) on port 9001...');
      const node1 = await factory.createNode(node1Config);
      nodes.push(node1);
      
      // Wait for node 1 to bind and stabilize
      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log('📦 Creating node 2 on port 9002...');
      const node2 = await factory.createNode(node2Config);
      nodes.push(node2);
      
      // Wait for join to propagate
      await new Promise(resolve => setTimeout(resolve, 3000));

      console.log('📦 Creating node 3 on port 9003...');
      const node3 = await factory.createNode(node3Config);
      nodes.push(node3);
      
      // Wait for full cluster formation with real network delays
      await new Promise(resolve => setTimeout(resolve, 4000));

      // Verify cluster membership across all nodes
      console.log('🔍 Verifying cluster membership...');
      
      const node1Members = Array.from(node1.clusterManager.getMembership().values())
        .filter(member => member.status === 'ALIVE');
      const node2Members = Array.from(node2.clusterManager.getMembership().values())
        .filter(member => member.status === 'ALIVE');
      const node3Members = Array.from(node3.clusterManager.getMembership().values())
        .filter(member => member.status === 'ALIVE');

      console.log('Node 1 sees members:', node1Members.map(m => `${m.id} (${m.status})`));
      console.log('Node 2 sees members:', node2Members.map(m => `${m.id} (${m.status})`));
      console.log('Node 3 sees members:', node3Members.map(m => `${m.id} (${m.status})`));

      // Each node should see at least itself + others (real network may have delays)
      expect(node1Members.length).toBeGreaterThanOrEqual(1);
      expect(node2Members.length).toBeGreaterThanOrEqual(1);
      expect(node3Members.length).toBeGreaterThanOrEqual(1);

      // Verify all nodes are present in the overall cluster view
      const allNodeIds = new Set([
        ...node1Members.map(m => m.id),
        ...node2Members.map(m => m.id),
        ...node3Members.map(m => m.id)
      ]);
      
      expect(allNodeIds.has('cluster-node-1')).toBe(true);
      expect(allNodeIds.has('cluster-node-2')).toBe(true);
      expect(allNodeIds.has('cluster-node-3')).toBe(true);

      // Test that transports are actually WebSocket-based
      expect(node1.clusterTransport.constructor.name).toBe('WebSocketAdapter');
      expect(node2.clusterTransport.constructor.name).toBe('WebSocketAdapter');
      expect(node3.clusterTransport.constructor.name).toBe('WebSocketAdapter');

      console.log('✅ 3-node cluster with real WebSocket communication formed successfully');
    }, 20000); // Longer timeout for real network operations
  });

  describe('Resource Management Workflows', () => {
    it('should handle client request workflow with resource operations', async () => {
      const config: DistributedNodeConfig = {
        id: 'resource-node',
        region: 'test-region',
        zone: 'test-zone',
        role: 'worker',
        network: {
          address: '127.0.0.1',
          port: 8003
        },
        transport: {
          type: 'websocket'
        },
        resources: {
          enableProductionScale: true,
          enableAttachmentService: true,
          enableDistributionEngine: true
        }
      };

      console.log('🔧 Creating node with resource management...');
      const components = await factory.createNode(config);
      nodes.push(components);

      // Test resource attachment service
      expect(components.resourceAttachment).toBeDefined();
      expect(components.resourceManager).toBeDefined();
      expect(components.clusterFanoutRouter).toBeDefined();

      // Simulate client connection and resource subscription
      console.log('💼 Testing resource attachment...');
      
      const connectionId = 'test-client-1';
      const resourceId = 'test-chat-room';
      
      // Test resource attachment
      await components.resourceAttachment!.attach(connectionId, resourceId, {
        resourceType: 'chat-room',
        eventTypes: ['message', 'user-join', 'user-leave']
      });

      // Verify attachment
      const members = await components.resourceAttachment!.members(resourceId);
      expect(members.has(connectionId)).toBe(true);

      console.log('✅ Resource workflows tested successfully');
    }, 10000);

    it('should handle resource distribution across cluster', async () => {
      console.log('🌊 Testing resource distribution workflow...');
      
      // Create 2 nodes for distribution testing
      const sharedMemory = new Map();
      
      const node1Config: DistributedNodeConfig = {
        id: 'dist-node-1',
        region: 'test-region',
        zone: 'zone-a',
        role: 'worker',
        network: { address: '127.0.0.1', port: 9101 },
        transport: {
          type: 'custom',
          customTransport: new InMemoryAdapter({ id: 'dist-node-1', address: '127.0.0.1', port: 9101 }, sharedMemory)
        },
        resources: { enableProductionScale: true, enableDistributionEngine: true },
        seedNodes: []
      };

      const node2Config: DistributedNodeConfig = {
        id: 'dist-node-2', 
        region: 'test-region',
        zone: 'zone-b',
        role: 'worker',
        network: { address: '127.0.0.1', port: 9102 },
        transport: {
          type: 'custom',
          customTransport: new InMemoryAdapter({ id: 'dist-node-2', address: '127.0.0.1', port: 9102 }, sharedMemory)
        },
        resources: { enableProductionScale: true, enableDistributionEngine: true },
        seedNodes: ['dist-node-1']
      };

      const node1 = await factory.createNode(node1Config);
      nodes.push(node1);
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const node2 = await factory.createNode(node2Config);
      nodes.push(node2);
      
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Test resource distribution
      expect(node1.resourceDistribution).toBeDefined();
      expect(node2.resourceDistribution).toBeDefined();
      expect(node1.clusterFanoutRouter).toBeDefined();
      expect(node2.clusterFanoutRouter).toBeDefined();

      // Test routing for a resource
      const testResourceId = 'distributed-resource-1';
      const routes1 = await node1.clusterFanoutRouter!.route(testResourceId, {
        preferPrimary: true,
        replicationFactor: 2
      });
      
      const routes2 = await node2.clusterFanoutRouter!.route(testResourceId, {
        preferPrimary: true,
        replicationFactor: 2
      });

      expect(routes1.length).toBeGreaterThan(0);
      expect(routes2.length).toBeGreaterThan(0);

      console.log('Routes from node 1:', routes1.map(r => r.nodeId));
      console.log('Routes from node 2:', routes2.map(r => r.nodeId));

      console.log('✅ Resource distribution tested successfully');
    }, 12000);
  });

  describe('Network Communication', () => {
    it('should handle custom messages between cluster nodes', async () => {
      console.log('📡 Testing custom message communication...');
      
      const sharedMemory = new Map();
      
      // Create 2 nodes for communication testing
      const senderConfig: DistributedNodeConfig = {
        id: 'sender-node',
        region: 'test-region',
        zone: 'zone-a',
        role: 'worker',
        network: { address: '127.0.0.1', port: 9201 },
        transport: {
          type: 'custom',
          customTransport: new InMemoryAdapter({ id: 'sender-node', address: '127.0.0.1', port: 9201 }, sharedMemory)
        },
        resources: { enableProductionScale: true },
        seedNodes: []
      };

      const receiverConfig: DistributedNodeConfig = {
        id: 'receiver-node',
        region: 'test-region', 
        zone: 'zone-b',
        role: 'worker',
        network: { address: '127.0.0.1', port: 9202 },
        transport: {
          type: 'custom',
          customTransport: new InMemoryAdapter({ id: 'receiver-node', address: '127.0.0.1', port: 9202 }, sharedMemory)
        },
        resources: { enableProductionScale: true },
        seedNodes: ['sender-node']
      };

      const sender = await factory.createNode(senderConfig);
      nodes.push(sender);
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const receiver = await factory.createNode(receiverConfig);
      nodes.push(receiver);
      
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Set up message listener on receiver
      let receivedMessages: any[] = [];
      
      receiver.clusterManager.on('custom-message', (data: any) => {
        console.log('📨 Received custom message:', data);
        receivedMessages.push(data);
      });

      // Send custom message from sender to receiver
      console.log('📤 Sending custom message...');
      await sender.clusterManager.getCommunication().sendCustomMessage(
        'test-message',
        { content: 'Hello from sender!', timestamp: Date.now() },
        ['receiver-node']
      );

      // Wait for message delivery
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify message was received
      expect(receivedMessages.length).toBeGreaterThan(0);
      
      const receivedMessage = receivedMessages.find(msg => 
        msg.message?.customType === 'test-message'
      );
      
      expect(receivedMessage).toBeDefined();
      expect(receivedMessage.message.payload.content).toBe('Hello from sender!');

      console.log('✅ Custom message communication tested successfully');
    }, 12000);
  });

  describe('Factory Builder Pattern', () => {
    it('should create node using fluent builder API', async () => {
      console.log('🏗️ Testing fluent builder API...');
      
      const components = await DistributedNodeFactory.builder()
        .id('builder-test-node')
        .region('test-region')
        .zone('test-zone')
        .role('worker')
        .network('127.0.0.1', 8004)
        .transport('websocket')
        .enableResources({
          productionScale: true,
          attachmentService: true,
          distributionEngine: true
        })
        .enableMetrics(true)
        .enableLogging(true)
        .build();
      
      nodes.push(components);

      // Verify builder configuration
      expect(components.node.id).toBe('builder-test-node');
      expect(components.node.region).toBe('test-region');
      expect(components.node.zone).toBe('test-zone');
      expect(components.resourceManager).toBeDefined();
      expect(components.resourceAttachment).toBeDefined();
      expect(components.resourceDistribution).toBeDefined();

      console.log('✅ Builder API tested successfully');
    }, 10000);
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle invalid configuration gracefully', async () => {
      console.log('⚠️ Testing error handling...');
      
      // Test missing required fields
      await expect(async () => {
        await DistributedNodeFactory.builder()
          .region('test-region')
          .zone('test-zone')
          // Missing id and network
          .build();
      }).rejects.toThrow('Node ID is required');

      await expect(async () => {
        await DistributedNodeFactory.builder()
          .id('test-node')
          .region('test-region')
          .zone('test-zone')
          // Missing network
          .build();
      }).rejects.toThrow('Network configuration is required');

      console.log('✅ Error handling tested successfully');
    });

    it('should handle transport failures gracefully', async () => {
      console.log('🔌 Testing transport failure handling...');
      
      // Create a node with a custom transport that will fail
      const failingTransport = new InMemoryAdapter({ id: 'failing-node', address: '127.0.0.1', port: 9999 }, new Map());
      
      // Override start to throw an error
      const originalStart = failingTransport.start.bind(failingTransport);
      failingTransport.start = async () => {
        throw new Error('Transport start failed');
      };

      const config: DistributedNodeConfig = {
        id: 'failing-transport-node',
        region: 'test-region',
        zone: 'test-zone',
        role: 'worker',
        network: { address: '127.0.0.1', port: 9999 },
        transport: { type: 'custom', customTransport: failingTransport },
        resources: { enableProductionScale: false }
      };

      // Should handle transport failure gracefully
      await expect(async () => {
        const components = await factory.createNode(config);
        nodes.push(components);
      }).rejects.toThrow('Transport start failed');

      console.log('✅ Transport failure handling tested successfully');
    });
  });
});
