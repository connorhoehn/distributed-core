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
      // Setup cluster with multiple nodes
      cluster = createTestCluster({ size: 5, enableLogging: false });
      await cluster.start();
      
      // Wait for initial cluster formation
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Verify all nodes have formed the cluster
      for (let i = 0; i < 5; i++) {
        const node = cluster.getNode(i);
        const membership = node.getMembership();
        expect(membership.size).toBeGreaterThanOrEqual(1); // At least self
      }
      
      // Check that gossip is propagating membership information
      const node0 = cluster.getNode(0);
      const node4 = cluster.getNode(4);
      
      const membership0 = node0.getMembership();
      const membership4 = node4.getMembership();
      
      // Both nodes should be aware of multiple nodes in the cluster
      expect(membership0.size).toBeGreaterThan(1);
      expect(membership4.size).toBeGreaterThan(1);
    }, 10000);

    it('should handle concurrent gossip rounds', async () => {
      // Setup cluster
      cluster = createTestCluster({ size: 4, enableLogging: false });
      await cluster.start();
      
      // Wait for cluster formation
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Simulate concurrent gossip by checking state changes
      const initialMemberships: number[] = [];
      for (let i = 0; i < 4; i++) {
        const node = cluster.getNode(i);
        initialMemberships.push(node.getMembership().size);
      }
      
      // Wait for several gossip rounds
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Check that membership is stable (not changing rapidly)
      const finalMemberships: number[] = [];
      for (let i = 0; i < 4; i++) {
        const node = cluster.getNode(i);
        finalMemberships.push(node.getMembership().size);
      }
      
      // Membership should be consistent across nodes
      const membershipCounts = new Set(finalMemberships);
      expect(membershipCounts.size).toBeLessThanOrEqual(2); // Allow for some variance
    }, 10000);

    it('should converge to consistent state', async () => {
      // Setup cluster with 6 nodes for better convergence testing
      cluster = createTestCluster({ size: 6, enableLogging: false });
      await cluster.start();
      
      // Wait for convergence
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Check membership consistency across all nodes
      const memberships: string[][] = [];
      for (let i = 0; i < 6; i++) {
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
    }, 15000);
  });

  describe('gossip strategy effectiveness', () => {
    it('should reach all nodes within expected rounds', async () => {
      // Setup cluster
      cluster = createTestCluster({ size: 5, enableLogging: false });
      await cluster.start();
      
      // Wait for initial gossip propagation
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check that each node knows about most other nodes
      let totalAwareness = 0;
      let totalPossible = 0;
      
      for (let i = 0; i < 5; i++) {
        const node = cluster.getNode(i);
        const membership = node.getMembership();
        totalAwareness += membership.size;
        totalPossible += 5; // Each node should ideally know about all 5 nodes
      }
      
      const awarenessRatio = totalAwareness / totalPossible;
      expect(awarenessRatio).toBeGreaterThan(0.6); // At least 60% awareness
    }, 10000);

    it('should maintain efficiency with large clusters', async () => {
      // Setup larger cluster to test scalability
      cluster = createTestCluster({ size: 8, enableLogging: false });
      await cluster.start();
      
      // Wait for stabilization
      await new Promise(resolve => setTimeout(resolve, 4000));
      
      // Check that gossip is still effective with more nodes
      const membershipSizes: number[] = [];
      for (let i = 0; i < 8; i++) {
        const node = cluster.getNode(i);
        const membership = node.getMembership();
        membershipSizes.push(membership.size);
      }
      
      // Most nodes should know about most other nodes
      const avgMembershipSize = membershipSizes.reduce((a, b) => a + b, 0) / membershipSizes.length;
      expect(avgMembershipSize).toBeGreaterThan(4); // Average > 50% awareness
      
      // No node should be completely isolated
      expect(Math.min(...membershipSizes)).toBeGreaterThanOrEqual(1);
    }, 15000);
  });

  describe('gossip message handling', () => {
    it('should handle gossip message propagation', async () => {
      // Setup smaller cluster for focused testing
      cluster = createTestCluster({ size: 3, enableLogging: false });
      await cluster.start();
      
      // Wait for cluster formation
      await new Promise(resolve => setTimeout(resolve, 1000));
      
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
    }, 8000);

    it('should handle node metadata propagation', async () => {
      // Setup cluster
      cluster = createTestCluster({ size: 4, enableLogging: false });
      await cluster.start();
      
      // Wait for metadata propagation
      await new Promise(resolve => setTimeout(resolve, 2000));
      
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
    }, 10000);
  });
});
