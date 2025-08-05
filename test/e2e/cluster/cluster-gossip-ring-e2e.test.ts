/**
 * Ring-Based Cluster E2E Test
 * 
 * Tests the complete ClusterManager with gossip protocol and consistent hash ring.
 * Demonstrates decentralized cluster formation, data distribution, failure recovery,
 * and gossip-based anti-entropy synchronization.
 */

import { describe, test, beforeEach, afterEach, expect } from '@jest/globals';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';
import { TCPAdapter } from '../../../src/transport/adapters/TCPAdapter';
import { NodeInfo } from '../../../src/cluster/types';
import { NodeId } from '../../../src/types';
import { 
  ClusterTestNode, 
  waitForClusterConvergence, 
  validateMembershipConsistency,
  simulateNodeFailure,
  measureGossipPropagationTime,
  createTestClusterNode,
  cleanupClusterNodes 
} from '../helpers/clusterTestHelpers';

describe('Ring-Based Cluster E2E: Gossip Protocol & Hash Ring', () => {
  const TEST_TIMEOUT = 45000;
  
  let node1: ClusterTestNode;
  let node2: ClusterTestNode;
  let node3: ClusterTestNode;
  let allNodes: ClusterTestNode[];

  beforeEach(async () => {
    // Allocate ports for this test (using the global allocatePort function)
    const port1 = (global as any).allocatePort('cluster'); // 4255
    const port2 = (global as any).allocatePort('cluster'); // 4256 
    const port3 = (global as any).allocatePort('cluster'); // 4257

    // Create node info objects (cluster types)
    const node1Info: NodeInfo = {
      id: 'cluster-node-1',
      version: 1,
      status: 'ALIVE',
      lastSeen: Date.now(),
      metadata: { 
        address: '127.0.0.1',
        port: port1,
        role: 'bootstrap', 
        zone: 'test-zone-a' 
      }
    };

    const node2Info: NodeInfo = {
      id: 'cluster-node-2', 
      version: 1,
      status: 'ALIVE',
      lastSeen: Date.now(),
      metadata: { 
        address: '127.0.0.1',
        port: port2,
        role: 'worker', 
        zone: 'test-zone-b' 
      }
    };

    const node3Info: NodeInfo = {
      id: 'cluster-node-3',
      version: 1,
      status: 'ALIVE',
      lastSeen: Date.now(),
      metadata: { 
        address: '127.0.0.1',
        port: port3,
        role: 'worker', 
        zone: 'test-zone-c' 
      }
    };

    // Create NodeId objects for TCPAdapter (transport types)
    const node1Id: NodeId = {
      id: 'cluster-node-1',
      address: '127.0.0.1',
      port: port1
    };

    const node2Id: NodeId = {
      id: 'cluster-node-2',
      address: '127.0.0.1',
      port: port2
    };

    const node3Id: NodeId = {
      id: 'cluster-node-3',
      address: '127.0.0.1',
      port: port3
    };

    // Create cluster test nodes
    node1 = createTestClusterNode(node1Info);
    node2 = createTestClusterNode(node2Info);
    node3 = createTestClusterNode(node3Info);
    allNodes = [node1, node2, node3];

    // Create transport adapters for each node (using NodeId type)
    const transport1 = new TCPAdapter(node1Id, {
      port: port1,
      enableLogging: false,
      connectionTimeout: 5000,
      maxRetries: 3,
      baseRetryDelay: 1000
    });

    const transport2 = new TCPAdapter(node2Id, {
      port: port2,
      enableLogging: false,
      connectionTimeout: 5000,
      maxRetries: 3,
      baseRetryDelay: 1000
    });

    const transport3 = new TCPAdapter(node3Id, {
      port: port3,
      enableLogging: false,
      connectionTimeout: 5000,
      maxRetries: 3,
      baseRetryDelay: 1000
    });

    // Create bootstrap configurations
    // Node 1 is the bootstrap node (no seed nodes)
    const config1 = BootstrapConfig.create({
      seedNodes: [],
      joinTimeout: 10000,
      gossipInterval: 1000,       // Fast gossip for testing
      enableLogging: false,
      failureDetector: {
        heartbeatInterval: 2000,
        failureTimeout: 5000,
        deadTimeout: 10000,
        maxMissedHeartbeats: 3,
        enableActiveProbing: true,
        enableLogging: false
      },
      lifecycle: {
        shutdownTimeout: 5000,
        drainTimeout: 2000,
        enableAutoRebalance: true,
        rebalanceThreshold: 0.1,
        enableGracefulShutdown: true,
        maxShutdownWait: 3000
      }
    });

    // Nodes 2 and 3 use node 1 as seed
    const config2 = BootstrapConfig.create({
      seedNodes: [`${node1Id.address}:${node1Id.port}`],
      joinTimeout: 10000,
      gossipInterval: 1000,
      enableLogging: false,
      failureDetector: {
        heartbeatInterval: 2000,
        failureTimeout: 5000,
        deadTimeout: 10000,
        maxMissedHeartbeats: 3,
        enableActiveProbing: true,
        enableLogging: false
      },
      lifecycle: {
        shutdownTimeout: 5000,
        drainTimeout: 2000,
        enableAutoRebalance: true,
        rebalanceThreshold: 0.1,
        enableGracefulShutdown: true,
        maxShutdownWait: 3000
      }
    });

    const config3 = BootstrapConfig.create({
      seedNodes: [`${node1Id.address}:${node1Id.port}`],
      joinTimeout: 10000,
      gossipInterval: 1000,
      enableLogging: false,
      failureDetector: {
        heartbeatInterval: 2000,
        failureTimeout: 5000,
        deadTimeout: 10000,
        maxMissedHeartbeats: 3,
        enableActiveProbing: true,
        enableLogging: false
      },
      lifecycle: {
        shutdownTimeout: 5000,
        drainTimeout: 2000,
        enableAutoRebalance: true,
        rebalanceThreshold: 0.1,
        enableGracefulShutdown: true,
        maxShutdownWait: 3000
      }
    });

    // Create ClusterManager instances with reduced virtual nodes for testing
    node1.clusterManager = new ClusterManager(
      node1Info.id,
      transport1,
      config1,
      50 // Reduced virtual nodes per node for testing
    );

    node2.clusterManager = new ClusterManager(
      node2Info.id,
      transport2,
      config2,
      50
    );

    node3.clusterManager = new ClusterManager(
      node3Info.id,
      transport3,
      config3,
      50
    );

    // Register cleanup
    (global as any).addCleanupTask(async () => {
      await cleanupClusterNodes(allNodes);
    });
  }, TEST_TIMEOUT);

  afterEach(async () => {
    // Cleanup is handled by the global cleanup task
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  describe('Scenario 1: Gossip-Based Cluster Formation', () => {
    test('should form cluster through gossip protocol and achieve membership convergence', async () => {
      // Phase 1: Start bootstrap node (node1)
      await node1.clusterManager!.start();
      node1.isStarted = true;
      
      // Verify bootstrap node is running
      expect(node1.clusterManager!.membership.getAliveMembers().length).toBe(1);
      expect(node1.clusterManager!.membership.getAliveMembers()[0].id).toBe('cluster-node-1');

      // Phase 2: Start node2 with node1 as seed
      console.log('Starting node2...');
      await node2.clusterManager!.start(); 
      node2.isStarted = true;
      console.log('Node2 started, waiting for convergence...');

      // Wait for gossip convergence between node1 and node2
      await waitForClusterConvergence([node1, node2], 15000);

      // Verify both nodes see each other
      expect(node1.clusterManager!.membership.getAliveMembers().length).toBe(2);
      expect(node2.clusterManager!.membership.getAliveMembers().length).toBe(2);

      // Phase 3: Start node3 with node1 as seed  
      await node3.clusterManager!.start();
      node3.isStarted = true;

      // Wait for full cluster convergence
      await waitForClusterConvergence(allNodes, 15000);

      // Phase 4: Validate final cluster state
      validateMembershipConsistency(allNodes);

      // Verify all nodes see the complete cluster
      for (const node of allNodes) {
        const aliveMembers = node.clusterManager!.membership.getAliveMembers();
        expect(aliveMembers.length).toBe(3);
        
        // Verify specific node IDs are present
        const nodeIds = aliveMembers.map(m => m.id).sort();
        expect(nodeIds).toEqual(['cluster-node-1', 'cluster-node-2', 'cluster-node-3']);
      }

      // Verify hash ring contains all nodes
      for (const node of allNodes) {
        const ringNodes = node.clusterManager!.hashRing.getAllNodes();
        expect(ringNodes.length).toBe(3);
        
        const ringNodeIds = ringNodes.sort();
        expect(ringNodeIds).toEqual(['cluster-node-1', 'cluster-node-2', 'cluster-node-3']);
      }

    }, TEST_TIMEOUT);
  });

  describe('Scenario 2: Consistent Hash Ring Data Distribution', () => {
    test('should distribute keys consistently across ring and maintain replication', async () => {
      // Start all nodes and wait for convergence
      await node1.clusterManager!.start();
      node1.isStarted = true;
      await node2.clusterManager!.start();
      node2.isStarted = true;
      await node3.clusterManager!.start();
      node3.isStarted = true;

      await waitForClusterConvergence(allNodes, 15000);

      // Generate test keys
      const testKeys = [
        'user:12345',
        'session:abcdef',
        'cache:item-1',
        'cache:item-2',
        'profile:user-789',
        'settings:global',
        'data:chunk-001',
        'data:chunk-002',
        'temp:session-xyz',
        'index:search-results'
      ];

      // Test consistent routing across all nodes
      for (const key of testKeys) {
        // Get responsible nodes from each cluster member
        const nodesFromNode1 = node1.clusterManager!.hashRing.getNodes(key, 2); // 2 replicas
        const nodesFromNode2 = node2.clusterManager!.hashRing.getNodes(key, 2);
        const nodesFromNode3 = node3.clusterManager!.hashRing.getNodes(key, 2);

        // Verify consistent routing - all nodes should return same responsible nodes
        expect(nodesFromNode1.sort()).toEqual(nodesFromNode2.sort());
        expect(nodesFromNode2.sort()).toEqual(nodesFromNode3.sort());

        // Verify replication factor
        expect(nodesFromNode1.length).toBe(2);
        expect(nodesFromNode1[0]).not.toBe(nodesFromNode1[1]); // Different nodes for replication
      }

      // Test load distribution
      const keyDistribution = new Map<string, number>();
      
      for (const key of testKeys) {
        const primaryNode = node1.clusterManager!.hashRing.getNodes(key, 1)[0];
        const count = keyDistribution.get(primaryNode) || 0;
        keyDistribution.set(primaryNode, count + 1);
      }

      // Verify reasonable load distribution (each node should have some keys)
      expect(keyDistribution.size).toBeGreaterThan(1); // Keys should be distributed
      for (const [nodeId, count] of keyDistribution) {
        expect(count).toBeGreaterThan(0);
        console.log(`Node ${nodeId} is primary for ${count} keys`);
      }

    }, TEST_TIMEOUT);
  });

  describe('Scenario 3: Node Failure and Ring Rebalancing', () => {
    test('should detect node failure via gossip and rebalance hash ring automatically', async () => {
      // Establish 3-node cluster
      await node1.clusterManager!.start();
      node1.isStarted = true;
      await node2.clusterManager!.start();
      node2.isStarted = true;
      await node3.clusterManager!.start();
      node3.isStarted = true;

      await waitForClusterConvergence(allNodes, 15000);

      // Verify initial state
      validateMembershipConsistency(allNodes);
      expect(node1.clusterManager!.membership.getAliveMembers().length).toBe(3);

      // Test key routing before failure
      const testKey = 'test:before-failure';
      const nodesBeforeFailure = node1.clusterManager!.hashRing.getNodes(testKey, 2);
      expect(nodesBeforeFailure.length).toBe(2);

      // Gracefully stop node2 to simulate failure
      await node2.clusterManager!.stop();
      node2.isStarted = false;

      // Wait for failure detection via gossip (should be faster than 10 seconds)
      let failureDetected = false;
      const failureDetectionStart = Date.now();
      
      while (!failureDetected && (Date.now() - failureDetectionStart) < 10000) {
        const aliveMembers1 = node1.clusterManager!.membership.getAliveMembers();
        const aliveMembers3 = node3.clusterManager!.membership.getAliveMembers();
        
        // Check if both remaining nodes no longer see node2 as alive
        const node2InCluster1 = aliveMembers1.some(m => m.id === 'cluster-node-2');
        const node2InCluster3 = aliveMembers3.some(m => m.id === 'cluster-node-2');
        
        if (!node2InCluster1 && !node2InCluster3) {
          failureDetected = true;
        } else {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      expect(failureDetected).toBe(true);
      console.log(`Node failure detected in ${Date.now() - failureDetectionStart}ms`);

      // Verify hash ring rebalancing (node2 should be removed)
      const ringNodes1 = node1.clusterManager!.hashRing.getAllNodes();
      const ringNodes3 = node3.clusterManager!.hashRing.getAllNodes();
      
      expect(ringNodes1.length).toBe(2);
      expect(ringNodes3.length).toBe(2);
      expect(ringNodes1.includes('cluster-node-2')).toBe(false);
      expect(ringNodes3.includes('cluster-node-2')).toBe(false);

      // Test key routing after failure (should still work with remaining nodes)
      const nodesAfterFailure = node1.clusterManager!.hashRing.getNodes(testKey, 2);
      expect(nodesAfterFailure.length).toBeLessThanOrEqual(2); // May be fewer if only 2 nodes remain
      expect(nodesAfterFailure.every(n => n !== 'cluster-node-2')).toBe(true);

      // Restart node2 and verify rejoin
      await node2.clusterManager!.start();
      node2.isStarted = true;

      // Wait for rejoin and convergence
      await waitForClusterConvergence(allNodes, 15000);

      // Verify full cluster is restored
      validateMembershipConsistency(allNodes);
      expect(node1.clusterManager!.membership.getAliveMembers().length).toBe(3);
      expect(node1.clusterManager!.hashRing.getAllNodes().length).toBe(3);

    }, TEST_TIMEOUT);
  });

  describe('Scenario 4: Gossip Protocol and Anti-Entropy', () => {
    test('should propagate state changes via gossip and achieve eventual consistency', async () => {
      // Start all nodes
      await node1.clusterManager!.start();
      node1.isStarted = true;
      await node2.clusterManager!.start(); 
      node2.isStarted = true;
      await node3.clusterManager!.start();
      node3.isStarted = true;

      await waitForClusterConvergence(allNodes, 15000);

      // Measure gossip propagation time by simulating a membership change
      const propagationTime = await measureGossipPropagationTime(node1, [node2, node3]);
      
      // Gossip propagation should be reasonably fast (under 5 seconds)
      expect(propagationTime).toBeLessThan(5000);
      console.log(`Gossip propagation completed in ${propagationTime}ms`);

      // Test anti-entropy by temporarily partitioning and healing
      console.log('Testing anti-entropy synchronization...');
      
      // Briefly stop node3 to create inconsistency
      await node3.clusterManager!.stop();
      node3.isStarted = false;
      
      // Wait for the cluster to detect the failure
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Restart node3 - it should resync via anti-entropy
      await node3.clusterManager!.start();
      node3.isStarted = true;
      
      // Wait for anti-entropy to kick in and resync
      await waitForClusterConvergence(allNodes, 15000);
      
      // Verify cluster has converged to consistent state
      validateMembershipConsistency(allNodes);
      
      // All nodes should have the same view
      const membership1 = node1.clusterManager!.membership.getAliveMembers();
      const membership2 = node2.clusterManager!.membership.getAliveMembers();
      const membership3 = node3.clusterManager!.membership.getAliveMembers();
      
      expect(membership1.length).toBe(3);
      expect(membership2.length).toBe(3);
      expect(membership3.length).toBe(3);
      
      console.log('Anti-entropy synchronization successful');

    }, TEST_TIMEOUT);
  });

  describe('Scenario 5: Performance and Basic Monitoring', () => {
    test('should maintain performance characteristics and basic cluster metrics', async () => {
      // Start cluster
      await node1.clusterManager!.start();
      node1.isStarted = true;
      await node2.clusterManager!.start();
      node2.isStarted = true;
      await node3.clusterManager!.start();
      node3.isStarted = true;

      await waitForClusterConvergence(allNodes, 15000);

      // Test basic cluster metrics
      for (const node of allNodes) {
        const memberCount = node.clusterManager!.getMemberCount();
        const ringSize = node.clusterManager!.hashRing.getAllNodes().length;
        
        expect(memberCount).toBe(3);
        expect(ringSize).toBe(3);
        
        console.log(`Node ${node.nodeInfo.id} metrics:`, {
          memberCount,
          ringSize,
          isStarted: node.isStarted
        });
      }

      // Test performance under load (simplified)
      const startTime = Date.now();
      const testKeys = Array.from({ length: 100 }, (_, i) => `perf-test-key-${i}`);
      
      // Test hash ring performance
      for (const key of testKeys) {
        const nodes = node1.clusterManager!.hashRing.getNodes(key, 2);
        expect(nodes.length).toBe(2);
      }
      
      const hashRingPerfTime = Date.now() - startTime;
      console.log(`Hash ring lookups for 100 keys: ${hashRingPerfTime}ms`);
      
      // Hash ring should be fast (under 100ms for 100 lookups)
      expect(hashRingPerfTime).toBeLessThan(100);

      console.log('Ring-based cluster performance test completed successfully');

    }, TEST_TIMEOUT);
  });
});
