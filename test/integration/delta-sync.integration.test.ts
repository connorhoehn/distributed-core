/**
 * Delta Synchronization Integration Tests
 * Tests delta sync in real multi-node cluster scenarios
 */

import { createTestCluster, TestClusterOptions } from '../harnesses/create-test-cluster';
import { DeltaSyncEngine } from '../../src/cluster/delta-sync/DeltaSync';
import { StateFingerprintGenerator } from '../../src/cluster/delta-sync/StateFingerprint';
import { LogicalService } from '../../src/cluster/introspection/ClusterIntrospection';

describe('Delta Sync Integration', () => {
  let cluster: any;
  let deltaEngine: DeltaSyncEngine;
  let fingerprintGenerator: StateFingerprintGenerator;

  beforeEach(async () => {
    cluster = createTestCluster({ 
      nodeCount: 3, 
      enableTestEvents: false,
      enableDebugConsole: false 
    });
    deltaEngine = new DeltaSyncEngine();
    fingerprintGenerator = new StateFingerprintGenerator();
  });

  afterEach(async () => {
    if (cluster) {
      await cluster.stop();
    }
  });

  describe('Multi-Node Synchronization', () => {
    it('should synchronize state across 3 nodes', async () => {
      await cluster.start();
      
      // Add services to node 0
      const services: LogicalService[] = [{
        id: 'sync-test-service',
        type: 'test-service',
        nodeId: cluster.getNode(0).getNodeInfo().id,
        metadata: { name: 'Sync Test Service' },
        stats: { requests: 100 },
        lastUpdated: Date.now(),
        vectorClock: { node1: 1 },
        version: 1,
        checksum: 'test-checksum',
        conflictPolicy: 'last-writer-wins'
      }];

      // Generate fingerprint for node 0
      const fingerprint = fingerprintGenerator.generateServiceFingerprint(
        services, 
        cluster.getNode(0).getNodeInfo().id
      );

      // Sync from node 0 to node 1
      const syncConfig = {
        nodeId: cluster.getNode(0).getNodeInfo().id,
        targetNodeId: cluster.getNode(1).getNodeInfo().id,
        enableCompression: true,
        enableEncryption: false,
        compressionThreshold: 100,
        maxDeltasPerBatch: 10,
        batchTimeoutMs: 1000,
        retryAttempts: 3,
        bandwidth: { maxBytesPerSecond: 10000 }
      };

      const session = await deltaEngine.startSyncSession([], fingerprint, syncConfig);
      
      expect(session.status).toBe('complete');
      expect(session.metrics.totalDeltas).toBeGreaterThan(0);
    });

    it('should handle encryption in multi-node sync', async () => {
      await cluster.start();
      
      const services: LogicalService[] = [{
        id: 'encrypted-service',
        type: 'encrypted-service',
        nodeId: cluster.getNode(0).getNodeInfo().id,
        metadata: { sensitive: 'data' },
        stats: { requests: 500 },
        lastUpdated: Date.now(),
        vectorClock: { node1: 1 },
        version: 1,
        checksum: 'encrypted-checksum',
        conflictPolicy: 'last-writer-wins'
      }];

      const fingerprint = fingerprintGenerator.generateServiceFingerprint(
        services, 
        cluster.getNode(0).getNodeInfo().id
      );

      const syncConfig = {
        nodeId: cluster.getNode(0).getNodeInfo().id,
        targetNodeId: cluster.getNode(1).getNodeInfo().id,
        enableCompression: true,
        enableEncryption: true,
        compressionThreshold: 50,
        maxDeltasPerBatch: 5,
        batchTimeoutMs: 1000,
        retryAttempts: 3,
        bandwidth: {}
      };

      const session = await deltaEngine.startSyncSession([], fingerprint, syncConfig);
      
      expect(session.status).toBe('complete');
      expect(session.generatedDeltas.length).toBeGreaterThan(0);
    });
  });

  describe('Network Partition Scenarios', () => {
    it('should handle delta sync during network partitions', async () => {
      await cluster.start();
      
      // Create divergent state during partition
      const servicesNode0: LogicalService[] = [{
        id: 'partition-service',
        type: 'test-service',
        nodeId: cluster.getNode(0).getNodeInfo().id,
        metadata: { version: 'v1' },
        stats: { requests: 100 },
        lastUpdated: Date.now(),
        vectorClock: { node0: 2 },
        version: 2,
        checksum: 'partition-checksum-v1',
        conflictPolicy: 'last-writer-wins'
      }];

      const servicesNode1: LogicalService[] = [{
        id: 'partition-service',
        type: 'test-service',
        nodeId: cluster.getNode(1).getNodeInfo().id,
        metadata: { version: 'v2' },
        stats: { requests: 200 },
        lastUpdated: Date.now() + 1000,
        vectorClock: { node1: 2 },
        version: 2,
        checksum: 'partition-checksum-v2',
        conflictPolicy: 'last-writer-wins'
      }];

      // Generate fingerprints
      const fingerprint0 = fingerprintGenerator.generateServiceFingerprint(servicesNode0, cluster.getNode(0).getNodeInfo().id);
      const fingerprint1 = fingerprintGenerator.generateServiceFingerprint(servicesNode1, cluster.getNode(1).getNodeInfo().id);

      // Compare and sync
      const comparison = fingerprintGenerator.compareFingerprints(fingerprint0, fingerprint1);
      expect(comparison.identical).toBe(false);

      const syncConfig = {
        nodeId: cluster.getNode(0).getNodeInfo().id,
        targetNodeId: cluster.getNode(1).getNodeInfo().id,
        enableCompression: false,
        enableEncryption: false,
        compressionThreshold: 1024,
        maxDeltasPerBatch: 10,
        batchTimeoutMs: 1000,
        retryAttempts: 3,
        bandwidth: {}
      };

      const session = await deltaEngine.startSyncSession(servicesNode0, fingerprint1, syncConfig);
      expect(session.status).toBe('complete');
    });
  });

  describe('Performance Under Load', () => {
    it('should maintain performance with large service catalogs', async () => {
      await cluster.start();
      
      // Create large service catalog
      const largeServiceCatalog: LogicalService[] = Array.from({ length: 500 }, (_, i) => ({
        id: `large-service-${i}`,
        type: 'load-test-service',
        nodeId: cluster.getNode(0).getNodeInfo().id,
        metadata: { index: i, data: 'x'.repeat(100) },
        stats: { requests: i * 10 },
        lastUpdated: Date.now() - (i * 100),
        vectorClock: { node0: i + 1 },
        version: i + 1,
        checksum: `large-checksum-${i}`,
        conflictPolicy: 'last-writer-wins'
      }));

      const startTime = Date.now();
      const fingerprint = fingerprintGenerator.generateServiceFingerprint(
        largeServiceCatalog, 
        cluster.getNode(0).getNodeInfo().id
      );
      const fingerprintTime = Date.now() - startTime;

      expect(fingerprintTime).toBeLessThan(2000); // Should complete in under 2 seconds
      expect(fingerprint.serviceCount).toBe(500);

      const syncConfig = {
        nodeId: cluster.getNode(0).getNodeInfo().id,
        targetNodeId: cluster.getNode(1).getNodeInfo().id,
        enableCompression: true,
        enableEncryption: false,
        compressionThreshold: 1024,
        maxDeltasPerBatch: 50,
        batchTimeoutMs: 5000,
        retryAttempts: 3,
        bandwidth: { maxBytesPerSecond: 50000 }
      };

      const syncStartTime = Date.now();
      const session = await deltaEngine.startSyncSession([], fingerprint, syncConfig);
      const syncTime = Date.now() - syncStartTime;

      expect(session.status).toBe('complete');
      expect(syncTime).toBeLessThan(5000); // Should complete sync in under 5 seconds
    });
  });

  describe('Error Recovery', () => {
    it('should handle corrupted deltas gracefully', async () => {
      await cluster.start();
      
      const services: LogicalService[] = [{
        id: 'error-test-service',
        type: 'test-service',
        nodeId: cluster.getNode(0).getNodeInfo().id,
        metadata: { name: 'Error Test' },
        stats: { requests: 1 },
        lastUpdated: Date.now(),
        vectorClock: { node0: 1 },
        version: 1,
        checksum: 'error-checksum',
        conflictPolicy: 'last-writer-wins'
      }];

      // Create invalid delta
      const invalidDelta = {
        id: 'invalid-delta',
        sourceNodeId: '', // Invalid - empty source
        sourceFingerprint: 'test',
        services: [],
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 1,
        vectorClockUpdates: {},
        causality: [],
        compressed: false,
        encrypted: false
      };

      // Should handle invalid delta gracefully
      const result = await deltaEngine.applyIncomingDeltas(services, [invalidDelta]);
      expect(result.success).toBe(false);
    });
  });
});
