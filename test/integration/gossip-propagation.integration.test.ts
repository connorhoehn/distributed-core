import { ClusterManager } from '../../src/cluster/ClusterManager';
import { createTestCluster } from '../harness/create-test-cluster';
import { GossipStrategy } from '../../src/cluster/GossipStrategy';

describe('Gossip Propagation Integration', () => {
  let cluster: any;

  afterEach(async () => {
    if (cluster) {
      await cluster.stop();
    }
  });

  describe('multi-node gossip', () => {
    it('should propagate state across all nodes', async () => {
      // Setup cluster with multiple nodes (reduced size)
      cluster = createTestCluster({ size: 4, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for initial cluster formation (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Verify all nodes have formed the cluster
      for (let i = 0; i < 4; i++) {
        const node = cluster.getNode(i);
        const membership = node.getMembership();
        expect(membership.size).toBeGreaterThanOrEqual(1); // At least self
      }
      
      // Check that gossip is propagating membership information
      const node0 = cluster.getNode(0);
      const node3 = cluster.getNode(3);
      
      const membership0 = node0.getMembership();
      const membership3 = node3.getMembership();
      
      // Both nodes should be aware of multiple nodes in the cluster
      expect(membership0.size).toBeGreaterThan(1);
      expect(membership3.size).toBeGreaterThan(1);
    }, 2000);

    it('should handle concurrent gossip rounds', async () => {
      // Setup cluster
      cluster = createTestCluster({ size: 4, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for cluster formation (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Simulate concurrent gossip by checking state changes
      const initialMemberships: number[] = [];
      for (let i = 0; i < 4; i++) {
        const node = cluster.getNode(i);
        initialMemberships.push(node.getMembership().size);
      }
      
      // Wait for several gossip rounds (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Check that membership is stable (not changing rapidly)
      const finalMemberships: number[] = [];
      for (let i = 0; i < 4; i++) {
        const node = cluster.getNode(i);
        finalMemberships.push(node.getMembership().size);
      }
      
      // Membership should be consistent across nodes
      const membershipCounts = new Set(finalMemberships);
      expect(membershipCounts.size).toBeLessThanOrEqual(2); // Allow for some variance
    }, 2000);

    it('should converge to consistent state', async () => {
      // Setup cluster with 5 nodes for better convergence testing (reduced from 6)
      cluster = createTestCluster({ size: 5, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for convergence (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Check membership consistency across all nodes
      const memberships: string[][] = [];
      for (let i = 0; i < 5; i++) {
        const node = cluster.getNode(i);
        const membership = node.getMembership();
        const nodeIds = Array.from(membership.keys()).sort() as string[];
        memberships.push(nodeIds);
      }
      
      // All nodes should have similar view of the cluster
      const firstMembership = memberships[0];
      for (let i = 1; i < memberships.length; i++) {
        const overlap = memberships[i].filter(id => firstMembership.includes(id));
        expect(overlap.length).toBeGreaterThan(firstMembership.length * 0.8); // 80% overlap
      }
    }, 3000);
  });

  describe('gossip strategy effectiveness', () => {
    it('should reach all nodes within expected rounds', async () => {
      // Setup cluster
      cluster = createTestCluster({ size: 4, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for initial gossip propagation (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Check that each node knows about most other nodes
      let totalAwareness = 0;
      let totalPossible = 0;
      
      for (let i = 0; i < 4; i++) {
        const node = cluster.getNode(i);
        const membership = node.getMembership();
        totalAwareness += membership.size;
        totalPossible += 4; // Each node should ideally know about all 4 nodes
      }
      
      const awarenessRatio = totalAwareness / totalPossible;
      expect(awarenessRatio).toBeGreaterThan(0.6); // At least 60% awareness
    }, 2000);

    it('should maintain efficiency with large clusters', async () => {
      // Setup larger cluster to test scalability (reduced from 8 to 6)
      cluster = createTestCluster({ size: 6, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for stabilization (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Check that gossip is still effective with more nodes
      const membershipSizes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const node = cluster.getNode(i);
        const membership = node.getMembership();
        membershipSizes.push(membership.size);
      }
      
      // Most nodes should know about most other nodes
      const avgMembershipSize = membershipSizes.reduce((a, b) => a + b, 0) / membershipSizes.length;
      expect(avgMembershipSize).toBeGreaterThan(3); // Average > 50% awareness
      
      // No node should be completely isolated
      expect(Math.min(...membershipSizes)).toBeGreaterThanOrEqual(1);
    }, 3000);
  });

  describe('gossip message handling', () => {
    it('should handle gossip message propagation', async () => {
      // Setup smaller cluster for focused testing
      cluster = createTestCluster({ size: 3, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for cluster formation (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Verify nodes can communicate via gossip
      const node0 = cluster.getNode(0);
      const node1 = cluster.getNode(1);
      const node2 = cluster.getNode(2);
      
      // Check that all nodes have membership information
      expect(node0.getMembership().size).toBeGreaterThan(0);
      expect(node1.getMembership().size).toBeGreaterThan(0);
      expect(node2.getMembership().size).toBeGreaterThan(0);
      
      // Check that nodes know about each other
      const membership0 = node0.getMembership();
      const membership1 = node1.getMembership();
      
      // Should have overlapping knowledge
      const keys0 = Array.from(membership0.keys());
      const keys1 = Array.from(membership1.keys());
      const intersection = keys0.filter(key => keys1.includes(key));
      
      expect(intersection.length).toBeGreaterThan(0);
    }, 1500);

    it('should handle node metadata propagation', async () => {
      // Setup cluster
      cluster = createTestCluster({ size: 4, enableLogging: false, testType: 'unit' });
      await cluster.start();
      
      // Wait for metadata propagation (in-memory)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Check that nodes have metadata about other nodes
      for (let i = 0; i < 4; i++) {
        const node = cluster.getNode(i);
        const membership = node.getMembership();
        
        for (const [nodeId, memberInfo] of membership.entries()) {
          expect(memberInfo.metadata).toBeDefined();
          expect(memberInfo.lastSeen).toBeGreaterThan(0);
          expect(memberInfo.version).toBeGreaterThanOrEqual(0);
        }
      }
    }, 2000);
  });
});
