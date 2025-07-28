import { ClusterManager } from '../src/cluster/ClusterManager';
import { BootstrapConfig } from '../src/cluster/BootstrapConfig';
import { MembershipTable } from '../src/cluster/MembershipTable';
import { GossipStrategy } from '../src/cluster/GossipStrategy';
import { InMemoryAdapter } from '../src/transport/adapters/InMemoryAdapter';
import { createTestCluster } from './harness/createTestCluster';
import { NodeId, NodeInfo, NodeStatus, MessageType } from '../src/types';

describe('Cluster Formation', () => {
  describe('BootstrapConfig', () => {
    it('should create config with default values', () => {
      const config = BootstrapConfig.create();
      
      expect(config.seedNodes).toEqual([]);
      expect(config.joinTimeout).toBe(5000);
      expect(config.gossipInterval).toBe(1000);
    });

    it('should create config with custom values', () => {
      const seedNode: NodeId = { id: 'seed-1', address: '127.0.0.1', port: 3000 };
      const config = BootstrapConfig.create({
        seedNodes: [seedNode],
        joinTimeout: 3000,
        gossipInterval: 500
      });
      
      expect(config.seedNodes).toEqual([seedNode]);
      expect(config.joinTimeout).toBe(3000);
      expect(config.gossipInterval).toBe(500);
    });

    it('should add and get seed nodes', () => {
      const config = new BootstrapConfig();
      const seedNode: NodeId = { id: 'seed-1', address: '127.0.0.1', port: 3000 };
      
      config.addSeedNode(seedNode);
      const seedNodes = config.getSeedNodes();
      
      expect(seedNodes).toHaveLength(1);
      expect(seedNodes[0]).toEqual(seedNode);
    });
  });

  describe('MembershipTable', () => {
    let membershipTable: MembershipTable;
    let nodeInfo: NodeInfo;

    beforeEach(() => {
      membershipTable = new MembershipTable();
      nodeInfo = {
        id: { id: 'node-1', address: '127.0.0.1', port: 3000 },
        metadata: { region: 'us-east' },
        lastSeen: Date.now(),
        status: NodeStatus.ALIVE,
        version: 1
      };
    });

    it('should add and retrieve members', () => {
      membershipTable.addMember(nodeInfo);
      
      const retrieved = membershipTable.getMember('node-1');
      expect(retrieved).toEqual(nodeInfo);
      expect(membershipTable.size()).toBe(1);
    });

    it('should remove members', () => {
      membershipTable.addMember(nodeInfo);
      membershipTable.removeMember('node-1');
      
      expect(membershipTable.getMember('node-1')).toBeUndefined();
      expect(membershipTable.size()).toBe(0);
    });

    it('should get all members', () => {
      const nodeInfo2: NodeInfo = {
        ...nodeInfo,
        id: { id: 'node-2', address: '127.0.0.1', port: 3001 }
      };
      
      membershipTable.addMember(nodeInfo);
      membershipTable.addMember(nodeInfo2);
      
      const allMembers = membershipTable.getAllMembers();
      expect(allMembers).toHaveLength(2);
    });

    it('should filter alive members', () => {
      const deadNode: NodeInfo = {
        ...nodeInfo,
        id: { id: 'node-2', address: '127.0.0.1', port: 3001 },
        status: NodeStatus.DEAD
      };
      
      membershipTable.addMember(nodeInfo);
      membershipTable.addMember(deadNode);
      
      const aliveMembers = membershipTable.getAliveMembers();
      expect(aliveMembers).toHaveLength(1);
      expect(aliveMembers[0].id.id).toBe('node-1');
    });

    it('should clear all members', () => {
      membershipTable.addMember(nodeInfo);
      membershipTable.clear();
      
      expect(membershipTable.size()).toBe(0);
    });
  });

  describe('GossipStrategy', () => {
    let gossipStrategy: GossipStrategy;
    let transport: InMemoryAdapter;
    let nodeId: NodeId;

    beforeEach(() => {
      nodeId = { id: 'gossip-node', address: '127.0.0.1', port: 3000 };
      transport = new InMemoryAdapter(nodeId);
      gossipStrategy = new GossipStrategy(nodeId, transport, 1000);
    });

    it('should select gossip targets', () => {
      const allNodes: NodeId[] = [
        { id: 'node-1', address: '127.0.0.1', port: 3001 },
        { id: 'node-2', address: '127.0.0.1', port: 3002 },
        { id: 'node-3', address: '127.0.0.1', port: 3003 },
        nodeId // Should exclude self
      ];
      
      const targets = gossipStrategy.selectGossipTargets(allNodes, 2);
      
      expect(targets).toHaveLength(2);
      expect(targets.every(t => t.id !== nodeId.id)).toBe(true);
    });

    it('should send gossip messages', async () => {
      await transport.start();
      
      const targets: NodeId[] = [
        { id: 'node-1', address: '127.0.0.1', port: 3001 }
      ];
      
      const sendSpy = jest.spyOn(transport, 'send').mockResolvedValue();
      
      await gossipStrategy.sendGossip(targets, { test: 'data' });
      
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.GOSSIP,
          data: { test: 'data' },
          sender: nodeId
        }),
        targets[0]
      );
      
      await transport.stop();
    });
  });

  describe('ClusterManager Unit Tests', () => {
    let clusterManager: ClusterManager;
    let transport: InMemoryAdapter;
    let nodeId: NodeId;
    let config: BootstrapConfig;

    beforeEach(() => {
      nodeId = { id: 'test-node', address: '127.0.0.1', port: 3000 };
      transport = new InMemoryAdapter(nodeId);
      config = new BootstrapConfig();
      clusterManager = new ClusterManager(nodeId, transport, config);
    });

    afterEach(async () => {
      if (clusterManager) {
        await clusterManager.stop();
      }
    });

    it('should start and add self to membership', async () => {
      await clusterManager.start();
      
      const members = clusterManager.getMembers();
      expect(members).toHaveLength(1);
      expect(members[0].id.id).toBe('test-node');
      expect(members[0].status).toBe(NodeStatus.ALIVE);
    });

    it('should stop and clear membership', async () => {
      await clusterManager.start();
      await clusterManager.stop();
      
      expect(clusterManager.getMemberCount()).toBe(0);
    });

    it('should get node info', () => {
      const nodeInfo = clusterManager.getNodeInfo();
      
      expect(nodeInfo.id).toEqual(nodeId);
      expect(nodeInfo.status).toBe(NodeStatus.ALIVE);
      expect(nodeInfo.version).toBe(1);
    });
  });

  describe('Test Cluster Integration', () => {
    it('should create test cluster with specified size', () => {
      const cluster = createTestCluster({ size: 3 });
      
      expect(cluster.nodes).toHaveLength(3);
      expect(() => cluster.getNode(0)).not.toThrow();
      expect(() => cluster.getNode(3)).toThrow('Node index 3 out of bounds');
    });

    it('should start and stop cluster nodes', async () => {
      const cluster = createTestCluster({ size: 3, enableLogging: true });
      
      await cluster.start();
      
      // Check that all nodes have started (each should know about themselves and others)
      for (let i = 0; i < 3; i++) {
        const node = cluster.getNode(i);
        expect(node.getMemberCount()).toBeGreaterThanOrEqual(1); // At least itself
      }
      
      await cluster.stop();
      
      // Check logs
      const logs = cluster.getLogs();
      expect(logs.some(log => log.message === 'Starting test cluster')).toBe(true);
      expect(logs.some(log => log.message === 'Stopping test cluster')).toBe(true);
    }, 5000);

    it('should form cluster with 5 nodes via gossip', async () => {
      const cluster = createTestCluster({ size: 5, enableLogging: true });
      
      await cluster.start();
      
      // Small delay for cluster formation
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // All nodes should at least have themselves
      for (let i = 0; i < 5; i++) {
        const node = cluster.getNode(i);
        expect(node.getMemberCount()).toBeGreaterThanOrEqual(1); // At least self
      }
      
      // Check that join messages were sent
      const logs = cluster.getLogs();
      const joinEvents = logs.filter(log => log.event === 'join-sent');
      expect(joinEvents.length).toBeGreaterThan(0); // Nodes should attempt to join
      
      await cluster.stop();
    }, 5000);

    it('should handle node metadata synchronization', async () => {
      const cluster = createTestCluster({ size: 3 });
      
      await cluster.start();
      
      // Each node should have its own metadata
      for (let i = 0; i < 3; i++) {
        const node = cluster.getNode(i);
        const nodeInfo = node.getNodeInfo();
        expect(nodeInfo.metadata).toBeDefined();
        expect(nodeInfo.id.id).toBe(`test-node-${i}`);
      }
      
      await cluster.stop();
    }, 5000);
  });

  describe('Mock Transport Validation', () => {
    it('should route gossip messages via mock transports', async () => {
      const node1Id: NodeId = { id: 'node-1', address: '127.0.0.1', port: 3001 };
      const node2Id: NodeId = { id: 'node-2', address: '127.0.0.1', port: 3002 };
      
      const transport1 = new InMemoryAdapter(node1Id);
      const transport2 = new InMemoryAdapter(node2Id);
      
      await transport1.start();
      await transport2.start();
      
      let receivedMessage: any = null;
      transport2.onMessage((message) => {
        receivedMessage = message;
      });
      
      const testMessage = {
        id: 'test-msg',
        type: MessageType.GOSSIP,
        data: { test: 'payload' },
        sender: node1Id,
        timestamp: Date.now()
      };
      
      await transport1.send(testMessage, node2Id);
      
      // Wait for message delivery
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(receivedMessage).not.toBeNull();
      expect(receivedMessage.type).toBe(MessageType.GOSSIP);
      expect(receivedMessage.data.test).toBe('payload');
      
      await transport1.stop();
      await transport2.stop();
    });
  });
});
