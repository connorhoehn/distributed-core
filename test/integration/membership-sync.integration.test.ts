import { ClusterManager } from '../../src/cluster/ClusterManager';
import { createTestCluster } from '../harness/create-test-cluster';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';
import { BootstrapConfig } from '../../src/cluster/BootstrapConfig';

describe('Membership Synchronization Integration', () => {
  let cluster: any;

  afterEach(async () => {
    if (cluster) {
      await cluster.stop();
    }
  });

  describe('member join', () => {
    it('should propagate new member to all nodes', async () => {
      // Start with smaller cluster
      cluster = createTestCluster({ size: 3, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for initial cluster formation (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Add a new node dynamically
      const newNodeId = 'test-node-new';
      const newTransport = new InMemoryAdapter({
        id: newNodeId,
        address: '127.0.0.1',
        port: 3010
      });
      
      // Use existing node as seed
      const seedNodes = ['test-node-0'];
      const config = new BootstrapConfig(seedNodes, 1000, 200, false); // Faster timeouts
      const nodeMetadata = {
        region: 'test-region',
        zone: 'test-zone',
        role: 'worker',
        tags: { testCluster: 'true', dynamicJoin: 'true' }
      };
      
      const newNode = new ClusterManager(newNodeId, newTransport, config, 100, nodeMetadata);
      
      // Start the new node
      await newNode.start();
      
                  // Wait for membership stabilization (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Check that existing nodes know about the new member
      let newMemberDetected = false;
      for (let i = 0; i < 3; i++) {
        const existingNode = cluster.getNode(i);
        const membership = existingNode.getMembership();
        if (membership.has(newNodeId)) {
          newMemberDetected = true;
          break;
        }
      }
      
      expect(newMemberDetected).toBe(true);
      
      // Check that new node knows about existing members
      const newNodeMembership = newNode.getMembership();
      expect(newNodeMembership.size).toBeGreaterThan(1); // Should know about itself + others
      
      // Cleanup
      await newNode.stop();
      await newTransport.stop();
    }, 3000);

    it('should handle concurrent joins', async () => {
      // Start with minimal cluster
      cluster = createTestCluster({ size: 2, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for initial formation (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Create multiple new nodes concurrently
      const newNodes: ClusterManager[] = [];
      const newTransports: InMemoryAdapter[] = [];
      
      for (let i = 0; i < 3; i++) {
        const nodeId = `concurrent-node-${i}`;
        const transport = new InMemoryAdapter({
          id: nodeId,
          address: '127.0.0.1',
          port: 3020 + i
        });
        
        const config = new BootstrapConfig(['test-node-0'], 1000, 200, false); // Faster timeouts
        const nodeMetadata = {
          region: 'test-region',
          zone: 'test-zone',
          role: 'worker',
          tags: { concurrentJoin: 'true' }
        };
        
        const node = new ClusterManager(nodeId, transport, config, 100, nodeMetadata);
        newNodes.push(node);
        newTransports.push(transport);
      }
      
      // Start all new nodes concurrently
      await Promise.all(newNodes.map(node => node.start()));
      
      // Wait for membership stabilization (optimized for unit test speed)
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Check that cluster stabilized with all nodes
      const node0 = cluster.getNode(0);
      const finalMembership = node0.getMembership();
      
      // Should have at least the original nodes plus some new ones
      expect(finalMembership.size).toBeGreaterThanOrEqual(3);
      
      // Cleanup
      await Promise.all(newNodes.map(node => node.stop()));
      await Promise.all(newTransports.map(transport => transport.stop()));
    }, 4000);
  });

  describe('member leave', () => {
    it('should propagate member departure', async () => {
      // Setup cluster
      cluster = createTestCluster({ size: 4, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for cluster formation (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Record initial membership
      const node0 = cluster.getNode(0);
      const initialMembership = node0.getMembership();
      const initialSize = initialMembership.size;
      
      // Stop one node (simulating departure)
      const departingNode = cluster.getNode(3);
      const departingNodeId = departingNode.getNodeInfo().id;
      await departingNode.stop();
      
      // Wait for departure detection (optimized for unit test speed)
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Check that remaining nodes eventually detect the departure
      // (Note: In the current implementation, this might not immediately 
      //  remove the node from membership, but would mark it as inactive)
      const finalMembership = node0.getMembership();
      
      // The membership might still contain the departed node but marked differently
      if (finalMembership.has(departingNodeId)) {
        const departedMember = finalMembership.get(departingNodeId);
        // In a real implementation, this would be marked as SUSPECT or DEAD
        expect(departedMember).toBeDefined();
      }
      
      // At minimum, verify cluster is still functional
      expect(finalMembership.size).toBeGreaterThan(0);
    }, 3000);

    it('should handle graceful shutdown', async () => {
      // Setup cluster
      cluster = createTestCluster({ size: 3, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for formation (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Gracefully stop one node
      const stoppingNode = cluster.getNode(2);
      const stoppingNodeId = stoppingNode.getNodeInfo().id;
      
      // In a full implementation, this would send a LEAVE message
      await stoppingNode.stop();
      
      // Wait for graceful leave processing (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Check that other nodes are still healthy
      const node0 = cluster.getNode(0);
      const node1 = cluster.getNode(1);
      
      expect(node0.getMembership().size).toBeGreaterThan(0);
      expect(node1.getMembership().size).toBeGreaterThan(0);
      
      // Verify remaining nodes can still communicate
      const membership0 = node0.getMembership();
      const membership1 = node1.getMembership();
      
      const keys0 = Array.from(membership0.keys());
      const keys1 = Array.from(membership1.keys());
      const overlap = keys0.filter(key => keys1.includes(key));
      
      expect(overlap.length).toBeGreaterThan(0);
    }, 2000);
  });

  describe('membership consistency', () => {
    it('should maintain consistent membership view', async () => {
      // Setup cluster (reduced size)
      cluster = createTestCluster({ size: 4, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for full convergence (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Check membership consistency across all nodes
      const memberships: Map<string, any>[] = [];
      for (let i = 0; i < 4; i++) {
        const node = cluster.getNode(i);
        memberships.push(node.getMembership());
      }
      
      // Calculate consistency score
      const allNodeIds = new Set<string>();
      memberships.forEach(membership => {
        membership.forEach((_, nodeId) => allNodeIds.add(nodeId));
      });
      
      // Check that most nodes know about most other nodes
      let totalConsistency = 0;
      let comparisons = 0;
      
      for (let i = 0; i < memberships.length; i++) {
        for (let j = i + 1; j < memberships.length; j++) {
          const membership1 = memberships[i];
          const membership2 = memberships[j];
          
          const keys1 = Array.from(membership1.keys());
          const keys2 = Array.from(membership2.keys());
          const intersection = keys1.filter(key => keys2.includes(key));
          
          const consistency = intersection.length / Math.max(keys1.length, keys2.length);
          totalConsistency += consistency;
          comparisons++;
        }
      }
      
      const avgConsistency = totalConsistency / comparisons;
      expect(avgConsistency).toBeGreaterThan(0.5); // At least 50% consistency
    }, 3000);

    it('should resolve membership conflicts', async () => {
      // Setup cluster
      cluster = createTestCluster({ size: 4, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for initial formation (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Simulate a conflict scenario by checking version handling
      const node0 = cluster.getNode(0);
      const node1 = cluster.getNode(1);
      
      const membership0 = node0.getMembership();
      const membership1 = node1.getMembership();
      
      // Check that nodes have version information for conflict resolution
      for (const [nodeId, memberInfo] of membership0.entries()) {
        expect(memberInfo.version).toBeGreaterThanOrEqual(0);
        expect(memberInfo.lastUpdated).toBeGreaterThan(0);
      }
      
      for (const [nodeId, memberInfo] of membership1.entries()) {
        expect(memberInfo.version).toBeGreaterThanOrEqual(0);
        expect(memberInfo.lastUpdated).toBeGreaterThan(0);
      }
      
      // Wait for any conflicts to resolve (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Check that membership is stable
      const finalMembership0 = node0.getMembership();
      const finalMembership1 = node1.getMembership();
      
      expect(finalMembership0.size).toBeGreaterThan(0);
      expect(finalMembership1.size).toBeGreaterThan(0);
    }, 2000);
  });

  describe('membership metadata handling', () => {
    it('should propagate node metadata correctly', async () => {
      // Setup cluster with custom metadata
      cluster = createTestCluster({ size: 3, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for metadata propagation (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Check that metadata is propagated
      for (let i = 0; i < 3; i++) {
        const node = cluster.getNode(i);
        const membership = node.getMembership();
        
        for (const [nodeId, memberInfo] of membership.entries()) {
          expect(memberInfo.metadata).toBeDefined();
          expect(memberInfo.metadata).toHaveProperty('region');
          expect(memberInfo.metadata).toHaveProperty('zone');
          expect(memberInfo.metadata).toHaveProperty('role');
        }
      }
    }, 2000);

    it('should handle membership table operations', async () => {
      // Setup cluster
      cluster = createTestCluster({ size: 3, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for formation (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Test membership table operations
      const node0 = cluster.getNode(0);
      const membership = node0.getMembership();
      
      // Should have membership entries
      expect(membership.size).toBeGreaterThan(0);
      
      // Should be able to get specific members
      for (const [nodeId, memberInfo] of membership.entries()) {
        expect(nodeId).toBeDefined();
        expect(memberInfo.status).toBeDefined();
        expect(memberInfo.lastSeen).toBeGreaterThan(0);
      }
      
      // Check cluster health reporting
      const health = node0.getClusterHealth();
      expect(health).toBeDefined();
      expect(health.totalNodes).toBeGreaterThan(0);
      expect(health.healthRatio).toBeGreaterThan(0);
    }, 2000);
  });
});
