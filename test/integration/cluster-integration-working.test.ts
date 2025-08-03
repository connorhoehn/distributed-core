/**
 * Working Comprehensive Cluster Integration Test
 * Based on the successful simplified test but with additional features
 * 
 * Features:
 * - Multi-node scenarios (3-5 nodes)
 * - Scale testing (100+ services)
 * - Performance benchmarking
 * - Real Node.ts integration
 * - Proper Jest configuration without manual timeouts
 */

import { 
  StateDeltaManager, 
  StateDelta, 
  ServiceDelta,
  DeltaApplicationResult 
} from '../../src/cluster/delta-sync/StateDelta';
import { 
  StateFingerprintGenerator, 
  StateFingerprint,
  FingerprintComparison 
} from '../../src/cluster/delta-sync/StateFingerprint';
import { 
  DeltaSyncEngine,
  SyncSessionConfig,
  SyncSession 
} from '../../src/cluster/delta-sync/DeltaSync';
import { LogicalService } from '../../src/cluster/introspection/ClusterIntrospection';
import { Node, NodeConfig } from '../../src/common/Node';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';

interface TestClusterNode {
  node: Node;
  services: LogicalService[];
  deltaManager: StateDeltaManager;
  fingerprintGenerator: StateFingerprintGenerator;
  syncEngine: DeltaSyncEngine;
}

interface PerformanceMetrics {
  fingerprintGenerationTime: number;
  deltaGenerationTime: number;
  deltaApplicationTime: number;
  bandwidthSavings: number;
  compressionRatio: number;
}

describe('Working Comprehensive Cluster Integration', () => {
  let testCluster: TestClusterNode[] = [];
  const basePort = 19000;

  beforeEach(() => {
    testCluster = [];
  });

  afterEach(async () => {
    // Clean shutdown - let Jest handle timeouts through configuration
    const shutdownPromises = testCluster.map(async (clusterNode) => {
      try {
        if (clusterNode.node.isRunning()) {
          await clusterNode.node.stop();
        }
      } catch (error) {
        // Ignore cleanup errors in tests
      }
    });

    await Promise.allSettled(shutdownPromises);
    testCluster = [];
  });

  // Helper to create test services
  const createServices = (count: number, nodeId: string, serviceType: string): LogicalService[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `${serviceType}-${nodeId}-${i}`,
      type: serviceType,
      nodeId,
      metadata: { 
        name: `${serviceType} Service ${i}`, 
        version: '1.0.0',
        role: serviceType === 'web-server' ? 'frontend' : 'backend'
      },
      stats: { 
        requests: i * 100, 
        latency: i * 10,
        errors: 0
      },
      lastUpdated: Date.now() - (i * 1000),
      vectorClock: { [nodeId]: i + 1 },
      version: i + 1,
      checksum: `checksum-${nodeId}-${i}`,
      conflictPolicy: 'last-writer-wins'
    }));
  };

  // Helper to create a test cluster node
  const createTestClusterNode = async (
    nodeId: string, 
    port: number,
    enableRealNetworking: boolean = false
  ): Promise<TestClusterNode> => {
    const nodeConfig: NodeConfig = {
      id: nodeId,
      clusterId: 'test-cluster',
      service: 'distributed-core-test',
      region: 'test-region',
      zone: 'test-zone-a',
      role: 'test-node',
      tags: { environment: 'test', version: '1.0.0' },
      transport: new InMemoryAdapter({
        id: nodeId,
        address: '127.0.0.1',
        port
      }),
      enableMetrics: false, // Disable for cleaner tests
      enableChaos: false, // Disable for cleaner tests
      enableLogging: false, // Keep quiet during tests
      // Configure for faster test execution
      lifecycle: {
        shutdownTimeout: 100,
        drainTimeout: 50,
        enableAutoRebalance: false,
        rebalanceThreshold: 0.1,
        enableGracefulShutdown: false, // Disable for faster tests
        maxShutdownWait: 10 // Very short wait
      }
    };

    const node = new Node(nodeConfig);
    
    const deltaManager = new StateDeltaManager({
      maxDeltaSize: 50,
      includeFullServices: true,
      enableCausality: true,
      compressionThreshold: 512,
      enableEncryption: false
    });

    const fingerprintGenerator = new StateFingerprintGenerator({
      hashAlgorithm: 'sha256',
      includeTimestamps: false,
      includeMetadata: true,
      includeStats: true,
      chunkSize: 10
    });

    const syncEngine = new DeltaSyncEngine();

    // Only start if requested
    if (enableRealNetworking) {
      await node.start();
    }

    return {
      node,
      services: [],
      deltaManager,
      fingerprintGenerator,
      syncEngine
    };
  };

  describe('Regression Tests (Preserve Working Functionality)', () => {
    it('should synchronize services between two nodes using delta sync', async () => {
      const nodeA = await createTestClusterNode('node-a', basePort);
      const nodeB = await createTestClusterNode('node-b', basePort + 1);
      testCluster.push(nodeA, nodeB);

      nodeA.services = createServices(3, 'node-a', 'web-server');
      nodeB.services = createServices(2, 'node-b', 'database');

      const fingerprintA = nodeA.fingerprintGenerator.generateServiceFingerprint(nodeA.services, 'node-a');
      const fingerprintB = nodeB.fingerprintGenerator.generateServiceFingerprint(nodeB.services, 'node-b');

      expect(fingerprintA.serviceCount).toBe(3);
      expect(fingerprintB.serviceCount).toBe(2);

      const comparison = nodeA.fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
      expect(comparison.identical).toBe(false);
      expect(comparison.addedServices.length).toBe(2); // Node B's 2 services are new to Node A

      const deltasFromB = nodeB.deltaManager.generateDelta(nodeB.services, comparison, 'node-b', fingerprintA.rootHash);
      const syncResult = nodeA.deltaManager.applyDelta(nodeA.services, deltasFromB[0]);

      expect(syncResult.success).toBe(true);
      expect(syncResult.resultingServices).toHaveLength(2); // Only the 2 new services from B

      // Test completed successfully - no logging needed
    });
  });

  describe('Scale and Performance Tests', () => {
    it('should handle large service catalogs efficiently', async () => {
      const nodeA = await createTestClusterNode('scale-node-a', basePort + 10);
      const nodeB = await createTestClusterNode('scale-node-b', basePort + 11);
      testCluster.push(nodeA, nodeB);

      // Create larger service catalogs
      nodeA.services = createServices(80, 'scale-node-a', 'web-server');
      nodeB.services = createServices(60, 'scale-node-b', 'database');

      // Silent operation - no logging in tests

      const start = performance.now();

      // Run the sync process
      const fingerprintA = nodeA.fingerprintGenerator.generateServiceFingerprint(nodeA.services, 'scale-node-a');
      const fingerprintB = nodeB.fingerprintGenerator.generateServiceFingerprint(nodeB.services, 'scale-node-b');
      const comparison = nodeA.fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
      const deltas = nodeB.deltaManager.generateDelta(nodeB.services, comparison, 'scale-node-b', fingerprintA.rootHash);
      const syncResult = nodeA.deltaManager.applyDelta(nodeA.services, deltas[0]);

      const duration = performance.now() - start;

      // Calculate bandwidth efficiency
      const deltaSize = deltas.reduce((total: number, delta: StateDelta) => total + nodeB.deltaManager.calculateDeltaSize(delta), 0);
      const fullStateSize = Buffer.byteLength(JSON.stringify([...nodeA.services, ...nodeB.services]), 'utf8');
      const bandwidthSavings = ((fullStateSize - deltaSize) / fullStateSize) * 100;

      // Performance assertions
      expect(duration).toBeLessThan(200); // Should complete in under 200ms
      expect(syncResult.success).toBe(true);
      expect(bandwidthSavings).toBeGreaterThan(0);

      // Test completed successfully - no logging needed
    });

    it('should handle multi-node cluster synchronization', async () => {
      // Create a 4-node cluster for testing
      const nodeCount = 4;
      const nodes: TestClusterNode[] = [];

      for (let i = 0; i < nodeCount; i++) {
        const node = await createTestClusterNode(`cluster-node-${i}`, basePort + 20 + i);
        const serviceTypes = ['web-server', 'database', 'cache', 'queue'];
        node.services = createServices(12, `cluster-node-${i}`, serviceTypes[i]);
        nodes.push(node);
        testCluster.push(node);
      }

      // Silent operation - no logging in tests

      // Test synchronization between all pairs
      let totalSyncOperations = 0;
      let totalBandwidthSavings = 0;
      let successfulSyncs = 0;

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const nodeA = nodes[i];
          const nodeB = nodes[j];

          const fingerprintA = nodeA.fingerprintGenerator.generateServiceFingerprint(nodeA.services, nodeA.node.id);
          const fingerprintB = nodeB.fingerprintGenerator.generateServiceFingerprint(nodeB.services, nodeB.node.id);
          const comparison = nodeA.fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);

          if (!comparison.identical) {
            const deltas = nodeB.deltaManager.generateDelta(nodeB.services, comparison, nodeB.node.id, fingerprintA.rootHash);
            const syncResult = nodeA.deltaManager.applyDelta(nodeA.services, deltas[0]);

            if (syncResult.success) {
              totalSyncOperations += syncResult.appliedOperations;
              successfulSyncs++;

              // Calculate bandwidth savings
              const deltaSize = deltas.reduce((total: number, delta: StateDelta) => total + nodeB.deltaManager.calculateDeltaSize(delta), 0);
              const fullStateSize = Buffer.byteLength(JSON.stringify([...nodeA.services, ...nodeB.services]), 'utf8');
              const pairSavings = ((fullStateSize - deltaSize) / fullStateSize) * 100;
              totalBandwidthSavings += pairSavings;
            }
          }
        }
      }

      const avgBandwidthSavings = successfulSyncs > 0 ? totalBandwidthSavings / successfulSyncs : 0;

      expect(totalSyncOperations).toBeGreaterThan(0);
      expect(avgBandwidthSavings).toBeGreaterThan(0);
      expect(successfulSyncs).toBeGreaterThan(0);

      // Test completed successfully - no logging needed
    });
  });

  describe('Node.ts Integration Tests', () => {
    it('should integrate with real Node instances', async () => {
      const nodeA = await createTestClusterNode('integration-node-a', basePort + 50, true);
      const nodeB = await createTestClusterNode('integration-node-b', basePort + 51, true);
      testCluster.push(nodeA, nodeB);

      // Verify nodes are running
      expect(nodeA.node.isRunning()).toBe(true);
      expect(nodeB.node.isRunning()).toBe(true);

      // Test basic node functionality
      expect(nodeA.node.metadata.nodeId).toBe('integration-node-a');
      expect(nodeA.node.metadata.clusterId).toBe('test-cluster');

      // Test delta sync with real nodes
      nodeA.services = createServices(5, 'integration-node-a', 'web-server');
      nodeB.services = createServices(3, 'integration-node-b', 'database');

      const fingerprintA = nodeA.fingerprintGenerator.generateServiceFingerprint(nodeA.services, 'integration-node-a');
      const fingerprintB = nodeB.fingerprintGenerator.generateServiceFingerprint(nodeB.services, 'integration-node-b');
      const comparison = nodeA.fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
      const deltas = nodeB.deltaManager.generateDelta(nodeB.services, comparison, 'integration-node-b', fingerprintA.rootHash);
      const syncResult = nodeA.deltaManager.applyDelta(nodeA.services, deltas[0]);

      expect(syncResult.success).toBe(true);

      // Test completed successfully - no logging needed
    });

    it('should test cluster health and membership', async () => {
      const nodeA = await createTestClusterNode('health-node-a', basePort + 60, true);
      testCluster.push(nodeA);

      // Test cluster health
      const healthA = nodeA.node.getClusterHealth();
      expect(healthA.isHealthy).toBeDefined();

      // Test cluster metadata
      const metadataA = nodeA.node.getClusterMetadata();
      expect(metadataA.clusterId).toBeDefined();

      // Test membership
      const membershipA = nodeA.node.getMembership();
      expect(membershipA).toBeDefined();

      // Test member count
      const memberCountA = nodeA.node.getMemberCount();
      expect(memberCountA).toBeGreaterThanOrEqual(1);

      // Test completed successfully - no logging needed
    });
  });

  describe('Performance Benchmarks', () => {
    it('should benchmark delta sync performance across different scales', async () => {
      const scales = [20, 50, 100];
      const results: Array<{ scale: number; metrics: PerformanceMetrics }> = [];

      for (const scale of scales) {
        const nodeA = await createTestClusterNode(`bench-node-a-${scale}`, basePort + 70 + scale);
        const nodeB = await createTestClusterNode(`bench-node-b-${scale}`, basePort + 80 + scale);
        testCluster.push(nodeA, nodeB);

        nodeA.services = createServices(scale, `bench-node-a-${scale}`, 'web-server');
        nodeB.services = createServices(Math.floor(scale * 0.8), `bench-node-b-${scale}`, 'database');

        // Benchmark the full process
        const start = performance.now();
        
        const fingerprintA = nodeA.fingerprintGenerator.generateServiceFingerprint(nodeA.services, `bench-node-a-${scale}`);
        const fingerprintB = nodeB.fingerprintGenerator.generateServiceFingerprint(nodeB.services, `bench-node-b-${scale}`);
        const fingerprintTime = performance.now() - start;

        const deltaStart = performance.now();
        const comparison = nodeA.fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
        const deltas = nodeB.deltaManager.generateDelta(nodeB.services, comparison, `bench-node-b-${scale}`, fingerprintA.rootHash);
        const deltaTime = performance.now() - deltaStart;

        const applyStart = performance.now();
        const syncResult = nodeA.deltaManager.applyDelta(nodeA.services, deltas[0]);
        const applyTime = performance.now() - applyStart;

        // Calculate metrics
        const deltaSize = deltas.reduce((total: number, delta: StateDelta) => total + nodeB.deltaManager.calculateDeltaSize(delta), 0);
        const fullStateSize = Buffer.byteLength(JSON.stringify([...nodeA.services, ...nodeB.services]), 'utf8');
        const bandwidthSavings = ((fullStateSize - deltaSize) / fullStateSize) * 100;
        const compressionRatio = deltaSize / fullStateSize;

        const metrics: PerformanceMetrics = {
          fingerprintGenerationTime: fingerprintTime,
          deltaGenerationTime: deltaTime,
          deltaApplicationTime: applyTime,
          bandwidthSavings,
          compressionRatio
        };

        results.push({ scale, metrics });

        expect(syncResult.success).toBe(true);
      }

      // Analyze performance trends - silent operation for tests
      // Performance results collected and validated without logging
      results.forEach(({ scale, metrics }) => {
        // Performance metrics tracked: fingerprint, delta, apply times and bandwidth savings
      });

      // Performance assertions - reasonable expectations based on actual results
      results.forEach(({ scale, metrics }) => {
        expect(metrics.fingerprintGenerationTime).toBeLessThan(scale * 3); // Should scale reasonably
        expect(metrics.deltaGenerationTime).toBeLessThan(scale * 2);
        expect(metrics.deltaApplicationTime).toBeLessThan(scale * 2);
        expect(metrics.bandwidthSavings).toBeGreaterThan(0);
      });

      // Test completed successfully - silent operation for tests
    });
  });
});
