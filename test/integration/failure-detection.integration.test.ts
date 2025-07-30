import { ClusterManager } from '../../src/cluster/ClusterManager';
import { FailureDetector } from '../../src/cluster/FailureDetector';
import { createTestCluster } from '../harness/create-test-cluster';
import { FailureRecoveryHarness } from '../harness/failure-recovery-harness';

describe('Failure Detection Integration', () => {
  let harness: FailureRecoveryHarness;

  beforeEach(async () => {
    harness = new FailureRecoveryHarness();
  });

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  describe('node failure detection', () => {
    it('should detect unresponsive nodes', async () => {
      // Setup cluster with 3 nodes
      await harness.setupCluster(3);
      
      // Wait for cluster formation
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Verify all nodes are alive initially
      const initialMembership = harness.getClusterMembership(0);
      expect(initialMembership.length).toBe(3);
      expect(initialMembership.every(member => member.status === 'ALIVE')).toBe(true);
      
      // Simulate node failure
      const failureResult = await harness.simulateNodeFailure(1);
      expect(failureResult.failedNodeId).toBe('recovery-node-2');
      
      // Wait for failure detection
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check that other nodes detected the failure
      const membershipAfterFailure = harness.getClusterMembership(0);
      const failedNode = membershipAfterFailure.find(m => m.id === 'recovery-node-2');
      expect(failedNode?.status).toMatch(/SUSPECT|DEAD/);
    }, 10000);

    it('should propagate failure information', async () => {
      // Setup cluster with 5 nodes for better propagation testing
      await harness.setupCluster(5);
      
      // Wait for cluster formation
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Simulate failure of node 2
      await harness.simulateNodeFailure(2);
      
      // Wait for failure propagation
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Check that all remaining nodes detected the failure
      for (let i = 0; i < 5; i++) {
        if (i === 2) continue; // Skip the failed node
        
        const membership = harness.getClusterMembership(i);
        const failedNode = membership.find(m => m.id === 'recovery-node-3');
        expect(failedNode?.status).toMatch(/SUSPECT|DEAD/);
      }
    }, 15000);

    it('should handle false positives', async () => {
      // Setup cluster
      await harness.setupCluster(3);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Test with gradual network degradation instead of complete failure
      const beforeMembership = harness.getClusterMembership(0);
      expect(beforeMembership.length).toBe(3);
      
      // Simulate a brief failure and recovery
      await harness.simulateNodeFailure(1);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Recover the node quickly (simulating false positive scenario)
      await harness.testNodeRecovery(1);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check that nodes eventually converge to all ALIVE
      const finalMembership = harness.getClusterMembership(0);
      const recoveredNode = finalMembership.find(m => m.id === 'recovery-node-2');
      expect(recoveredNode?.status).toBe('ALIVE');
    }, 15000);
  });

  describe('network partition', () => {
    it('should handle network partitions', async () => {
      // Setup cluster with 5 nodes
      await harness.setupCluster(5);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Create network partition using existing method
      const partitionResult = await harness.testNetworkPartition(0.4); // 40% partition
      expect(partitionResult.isolatedCount).toBeGreaterThan(0);
      expect(partitionResult.connectedCount).toBeGreaterThan(0);
      
      // Check that nodes detect the partition
      expect(partitionResult.quorumMaintained).toBeDefined();
    }, 20000);

    it('should recover from partition healing', async () => {
      // Setup cluster
      await harness.setupCluster(4);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Create partition
      const partitionResult = await harness.testNetworkPartition(0.5);
      expect(partitionResult.beforePartition.activeNodeCount).toBe(4);
      
      // Check healing process
      expect(partitionResult.afterHealing.activeNodeCount).toBeGreaterThanOrEqual(
        partitionResult.duringPartition.activeNodeCount
      );
      expect(partitionResult.healingTime).toBeGreaterThan(0);
    }, 25000);
  });

  describe('failure recovery', () => {
    it('should detect node recovery', async () => {
      // Setup cluster
      await harness.setupCluster(3);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Simulate node failure
      await harness.simulateNodeFailure(1);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Simulate node recovery
      const recoveryResult = await harness.testNodeRecovery(1);
      expect(recoveryResult.recoveredNodeId).toBe('recovery-node-2');
      expect(recoveryResult.rejoinTime).toBeGreaterThan(0);
      
      // Check that recovery was detected
      expect(recoveryResult.afterRecovery.activeNodeCount).toBeGreaterThan(
        recoveryResult.beforeRecovery.activeNodeCount
      );
    }, 15000);

    it('should reintegrate recovered nodes', async () => {
      // Setup cluster
      await harness.setupCluster(4);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Fail node 2
      await harness.simulateNodeFailure(2);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Recover node 2
      const recoveryResult = await harness.testNodeRecovery(2);
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Check reintegration - all nodes should see full membership
      expect(recoveryResult.dataConsistency).toBeGreaterThan(0.9);
      expect(recoveryResult.rebalancing).toBe(true);
      
      // Check health improvement
      expect(recoveryResult.afterRecovery.healthScore).toBeGreaterThan(
        recoveryResult.beforeRecovery.healthScore
      );
    }, 20000);
  });
});
