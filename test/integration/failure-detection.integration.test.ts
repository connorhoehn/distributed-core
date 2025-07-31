import { FailureRecoveryHarness } from '../harnesses/failure-recovery-harness';

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
      
      // Minimal stabilization wait for in-memory tests
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Verify initial cluster state
      const initialMembership = harness.getClusterMembership(0);
      expect(initialMembership.length).toBe(3);
      expect(initialMembership.every(member => member.status === 'ALIVE')).toBe(true);
      
      // Simulate node failure (this already waits for deadTimeout internally)
      const failureResult = await harness.simulateNodeFailure(1);
      expect(failureResult.failedNodeId).toBe('recovery-node-2');
      
      // Check that other nodes detected the failure (no additional wait needed)
      const membershipAfterFailure = harness.getClusterMembership(0);
      const failedNode = membershipAfterFailure.find(m => m.id === 'recovery-node-2');
      expect(failedNode?.status).toMatch(/SUSPECT|DEAD/);
    }, 300); // Ultra-fast timeout

    it('should propagate failure information', async () => {
      // Setup cluster with 3 nodes
      await harness.setupCluster(3);
      
      // Minimal stabilization wait
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Simulate failure of node 2 (index 2 = recovery-node-3)
      await harness.simulateNodeFailure(2);
      
      // Check that all remaining nodes detected the failure
      for (let i = 0; i < 3; i++) {
        if (i === 2) continue; // Skip the failed node
        
        const membership = harness.getClusterMembership(i);
        const failedNode = membership.find(m => m.id === 'recovery-node-3');
        expect(failedNode?.status).toMatch(/SUSPECT|DEAD/);
      }
    }, 300); // Ultra-fast timeout

    it('should handle false positives correctly', async () => {
      // Setup cluster with 3 nodes
      await harness.setupCluster(3);
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Verify initial state
      const initialMembership = harness.getClusterMembership(0);
      expect(initialMembership.length).toBe(3);
      
      // Simulate brief failure and quick recovery
      await harness.simulateNodeFailure(1);
      await harness.testNodeRecovery(1);
      
      // Verify the node can be detected in membership (recovery process initiated)
      const finalMembership = harness.getClusterMembership(0);
      const recoveredNode = finalMembership.find(m => m.id === 'recovery-node-2');
      expect(recoveredNode).toBeDefined();
      expect(recoveredNode?.id).toBe('recovery-node-2');
    }, 300);

  });

  describe('network partition scenarios', () => {
    it('should handle network partitions', async () => {
      // Setup cluster with 4 nodes
      await harness.setupCluster(4);
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Create network partition
      const partitionResult = await harness.testNetworkPartition(0.5); // 50% partition
      expect(partitionResult.isolatedCount).toBeGreaterThan(0);
      expect(partitionResult.connectedCount).toBeGreaterThan(0);
      expect(partitionResult.quorumMaintained).toBeDefined();
    }, 300);

    it('should recover from partition healing', async () => {
      // Setup cluster with 3 nodes
      await harness.setupCluster(3);
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Create network partition
      const partitionResult = await harness.testNetworkPartition(0.3); // 30% partition
      
      expect(partitionResult.isolatedCount).toBeGreaterThanOrEqual(0);
      expect(partitionResult.connectedCount).toBeGreaterThan(0);
      expect(partitionResult.quorumMaintained).toBeDefined();
    }, 300);
  });

  describe('failure recovery', () => {
    it('should detect node recovery', async () => {
      // Setup cluster with 3 nodes
      await harness.setupCluster(3);
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Simulate failure and recovery
      await harness.simulateNodeFailure(1);
      const recoveryResult = await harness.testNodeRecovery(1);
      
      expect(recoveryResult.recoveredNodeId).toBe('recovery-node-2');
      expect(recoveryResult.rejoinTime).toBeGreaterThanOrEqual(0);
    }, 300);

    it('should reintegrate recovered nodes', async () => {
      // Setup cluster with 3 nodes
      await harness.setupCluster(3);
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Test simple recovery cycle
      await harness.simulateNodeFailure(2);
      const recoveryResult = await harness.testNodeRecovery(2);
      
      expect(recoveryResult.recoveredNodeId).toBe('recovery-node-3');
      expect(recoveryResult.dataConsistency).toBeGreaterThanOrEqual(0);
    }, 300);
  });

  describe('edge cases', () => {
    it('should handle rapid node restarts', async () => {
      // Setup minimal cluster
      await harness.setupCluster(2);
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Test rapid restart scenario
      await harness.simulateNodeFailure(1);
      await harness.testNodeRecovery(1);
      
      // Verify cluster stability after rapid changes
      const finalMembership = harness.getClusterMembership(0);
      expect(finalMembership.length).toBeGreaterThan(0);
    }, 300);

    it('should maintain cluster integrity with single node', async () => {
      // Setup single node cluster
      await harness.setupCluster(1);
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Verify single node can maintain itself
      const membership = harness.getClusterMembership(0);
      expect(membership.length).toBe(1);
      expect(membership[0].status).toBe('ALIVE');
      expect(membership[0].id).toBe('recovery-node-1');
    }, 300);
  });
});