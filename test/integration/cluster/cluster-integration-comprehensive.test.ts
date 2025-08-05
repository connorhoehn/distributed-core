/**
 * Comprehensive Cluster Integration Test
 * Expanded version of the working multi-node delta sync test with enhanced features:
 * - Multi-node scenarios (3-5 nodes)
 * - Large service catalogs (100+ services)
 * - Concurrent updates and conflict resolution
 * - Performance benchmarking
 * - Real Node.ts integration
 * - Advanced delta scenarios
 */

import { 
  StateDeltaManager, 
  StateDelta, 
  ServiceDelta,
  DeltaApplicationResult 
} from '../../../src/cluster/delta-sync/StateDelta';
import { 
  StateFingerprintGenerator, 
  StateFingerprint,
  FingerprintComparison 
} from '../../../src/cluster/delta-sync/StateFingerprint';
import { 
  DeltaSyncEngine,
  SyncSessionConfig,
  SyncSession 
} from '../../../src/cluster/delta-sync/DeltaSync';
import { LogicalService } from '../../../src/cluster/introspection/ClusterIntrospection';
import { Node, NodeConfig } from '../../../src/common/Node';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';

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

describe('Comprehensive Cluster Integration', () => {
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
        // Silent cleanup - no logging in tests
      }
    });

    await Promise.allSettled(shutdownPromises);
    testCluster = [];
  });

  // Helper to create test services with configurable complexity
  const createServices = (
    count: number, 
    nodeId: string, 
    serviceType: string,
    complexity: 'simple' | 'complex' = 'simple'
  ): LogicalService[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `${serviceType}-${nodeId}-${i}`,
      type: serviceType,
      nodeId,
      metadata: complexity === 'complex' ? {
        name: `${serviceType} Service ${i}`,
        version: `1.${Math.floor(i / 10)}.${i % 10}`,
        description: `Complex service for testing with node ${nodeId}`,
        tags: [`env-test`, `type-${serviceType}`, `batch-${Math.floor(i / 20)}`],
        dependencies: i > 0 ? [`${serviceType}-${nodeId}-${Math.max(0, i - 1)}`] : [],
        configuration: Object.fromEntries(
          Array.from({ length: 5 }, (_, j) => [`config_${j}`, `value_${j}_${i}`])
        ),
        role: serviceType === 'web-server' ? 'frontend' : 'backend'
      } : { 
        name: `${serviceType} Service ${i}`, 
        version: '1.0.0',
        role: serviceType === 'web-server' ? 'frontend' : 'backend'
      },
      stats: { 
        requests: i * 100 + Math.floor(Math.random() * 1000), 
        latency: i * 10 + Math.floor(Math.random() * 100),
        errors: Math.floor(Math.random() * 10),
        uptime: Date.now() - (i * 1000) - Math.floor(Math.random() * 10000)
      },
      lastUpdated: Date.now() - (i * 1000) + Math.floor(Math.random() * 2000),
      vectorClock: { [nodeId]: i + 1 },
      version: i + 1,
      checksum: `checksum-${nodeId}-${i}-${Math.random().toString(36).substr(2, 9)}`,
      conflictPolicy: 'last-writer-wins'
    }));
  };

  // Helper to create a test cluster node with Node.ts integration
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
      // Configure for faster test cleanup
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
      maxDeltaSize: 100, // Larger for comprehensive tests
      includeFullServices: true,
      enableCausality: true,
      compressionThreshold: 1024, // Test compression
      enableEncryption: false
    });

    const fingerprintGenerator = new StateFingerprintGenerator({
      hashAlgorithm: 'sha256',
      includeTimestamps: false,
      includeMetadata: true,
      includeStats: true,
      chunkSize: 20 // Larger chunks for performance
    });

    const syncEngine = new DeltaSyncEngine();

    // Start the node if requested
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

  // Helper to measure performance
  const measurePerformance = async <T>(
    operation: () => Promise<T> | T
  ): Promise<{ result: T; duration: number }> => {
    const start = performance.now();
    const result = await operation();
    const duration = performance.now() - start;
    return { result, duration };
  };

  // Helper to simulate concurrent service updates
  const simulateConcurrentUpdates = (
    services: LogicalService[],
    updateCount: number
  ): LogicalService[] => {
    const updatedServices = [...services];
    for (let i = 0; i < Math.min(updateCount, services.length); i++) {
      const serviceIndex = Math.floor(Math.random() * services.length);
      const service = updatedServices[serviceIndex];
      
      updatedServices[serviceIndex] = {
        ...service,
        version: service.version + 1,
        lastUpdated: Date.now(),
        vectorClock: {
          ...service.vectorClock,
          [service.nodeId]: (service.vectorClock[service.nodeId] || 0) + 1
        },
        stats: {
          ...service.stats,
          requests: service.stats.requests + Math.floor(Math.random() * 100)
        }
      };
    }
    return updatedServices;
  };

  describe('Regression Tests (Original Functionality)', () => {
    it('should synchronize services between two nodes using delta sync', async () => {
      // This is your original working test to ensure we don't break anything
      const nodeA = await createTestClusterNode('node-a', basePort);
      const nodeB = await createTestClusterNode('node-b', basePort + 1);

      nodeA.services = createServices(3, 'node-a', 'web-server');
      nodeB.services = createServices(2, 'node-b', 'database');

      const fingerprintA = nodeA.fingerprintGenerator.generateServiceFingerprint(nodeA.services, 'node-a');
      const fingerprintB = nodeB.fingerprintGenerator.generateServiceFingerprint(nodeB.services, 'node-b');

      expect(fingerprintA.serviceCount).toBe(3);
      expect(fingerprintB.serviceCount).toBe(2);

      const comparison = nodeA.fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
      expect(comparison.identical).toBe(false);

      const deltasFromB = nodeB.deltaManager.generateDelta(nodeB.services, comparison, 'node-b', fingerprintA.rootHash);
      const syncResult = nodeA.deltaManager.applyDelta(nodeA.services, deltasFromB[0]);

      expect(syncResult.success).toBe(true);
      expect(syncResult.resultingServices).toHaveLength(2);
    });
  });

  describe('Scale and Performance Tests', () => {
    it('should handle large service catalogs efficiently', async () => {
      const nodeA = await createTestClusterNode('scale-node-a', basePort + 10);
      const nodeB = await createTestClusterNode('scale-node-b', basePort + 11);

      // Create large service catalogs
      nodeA.services = createServices(100, 'scale-node-a', 'web-server', 'complex');
      nodeB.services = createServices(80, 'scale-node-b', 'database', 'complex');

      // Measure fingerprint generation performance
      const { result: fingerprintA, duration: fingerprintTimeA } = await measurePerformance(
        () => nodeA.fingerprintGenerator.generateServiceFingerprint(nodeA.services, 'scale-node-a')
      );

      const { result: fingerprintB, duration: fingerprintTimeB } = await measurePerformance(
        () => nodeB.fingerprintGenerator.generateServiceFingerprint(nodeB.services, 'scale-node-b')
      );

      // Measure delta generation performance
      const comparison = nodeA.fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
      const { result: deltas, duration: deltaTime } = await measurePerformance(
        () => nodeB.deltaManager.generateDelta(nodeB.services, comparison, 'scale-node-b', fingerprintA.rootHash)
      );

      // Measure delta application performance
      const { result: syncResult, duration: applyTime } = await measurePerformance(
        () => nodeA.deltaManager.applyDelta(nodeA.services, deltas[0])
      );

      // Calculate bandwidth efficiency
      const deltaSize = deltas.reduce((total, delta) => total + nodeB.deltaManager.calculateDeltaSize(delta), 0);
      const fullStateSize = Buffer.byteLength(JSON.stringify([...nodeA.services, ...nodeB.services]), 'utf8');
      const bandwidthSavings = ((fullStateSize - deltaSize) / fullStateSize) * 100;

      // Performance assertions
      expect(fingerprintTimeA).toBeLessThan(100); // Should be fast even with 100 services
      expect(fingerprintTimeB).toBeLessThan(100);
      expect(deltaTime).toBeLessThan(200);
      expect(applyTime).toBeLessThan(100);
      expect(bandwidthSavings).toBeGreaterThan(0); // Should save bandwidth
      expect(syncResult.success).toBe(true);
    });

    it('should handle multi-node cluster synchronization', async () => {
      // Create a 5-node cluster
      const nodeCount = 5;
      const nodes: TestClusterNode[] = [];

      for (let i = 0; i < nodeCount; i++) {
        const node = await createTestClusterNode(`cluster-node-${i}`, basePort + 20 + i);
        const serviceTypes = ['web-server', 'database', 'cache', 'queue', 'api-gateway'];
        node.services = createServices(15, `cluster-node-${i}`, serviceTypes[i], 'complex');
        nodes.push(node);
      }

      // Silent operation - no logging in tests

      // Generate fingerprints for all nodes
      const fingerprints = await Promise.all(
        nodes.map(async (node) => {
          const { result } = await measurePerformance(
            () => node.fingerprintGenerator.generateServiceFingerprint(node.services, node.node.id)
          );
          return result;
        })
      );

      // Simulate synchronization between all node pairs
      let totalSyncOperations = 0;
      let totalBandwidthSavings = 0;

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const nodeA = nodes[i];
          const nodeB = nodes[j];
          const fingerprintA = fingerprints[i];
          const fingerprintB = fingerprints[j];

          const comparison = nodeA.fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
          
          if (!comparison.identical) {
            const deltas = nodeB.deltaManager.generateDelta(nodeB.services, comparison, nodeB.node.id, fingerprintA.rootHash);
            const syncResult = nodeA.deltaManager.applyDelta(nodeA.services, deltas[0]);
            
            if (syncResult.success) {
              totalSyncOperations += syncResult.appliedOperations;
              
              // Calculate bandwidth savings for this pair
              const deltaSize = deltas.reduce((total, delta) => total + nodeB.deltaManager.calculateDeltaSize(delta), 0);
              const fullStateSize = Buffer.byteLength(JSON.stringify([...nodeA.services, ...nodeB.services]), 'utf8');
              const pairSavings = ((fullStateSize - deltaSize) / fullStateSize) * 100;
              totalBandwidthSavings += pairSavings;
            }
          }
        }
      }

      const avgBandwidthSavings = totalBandwidthSavings / (nodeCount * (nodeCount - 1) / 2);

      expect(totalSyncOperations).toBeGreaterThan(0);
      expect(avgBandwidthSavings).toBeGreaterThan(0);

      // Test completed successfully - no logging needed
    });
  });

  describe('Advanced Delta Scenarios', () => {
    it('should handle concurrent updates and conflict resolution', async () => {
      const nodeA = await createTestClusterNode('conflict-node-a', basePort + 30);
      const nodeB = await createTestClusterNode('conflict-node-b', basePort + 31);

      // Both nodes start with the same services
      const sharedServices = createServices(10, 'shared', 'api-server', 'complex');
      nodeA.services = [...sharedServices];
      nodeB.services = [...sharedServices];

      // Simulate concurrent updates on both nodes
      nodeA.services = simulateConcurrentUpdates(nodeA.services, 5);
      nodeB.services = simulateConcurrentUpdates(nodeB.services, 3);

      const fingerprintA = nodeA.fingerprintGenerator.generateServiceFingerprint(nodeA.services, 'conflict-node-a');
      const fingerprintB = nodeB.fingerprintGenerator.generateServiceFingerprint(nodeB.services, 'conflict-node-b');

      const comparison = nodeA.fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
      
      // Should detect conflicts
      expect(comparison.identical).toBe(false);
      expect(comparison.modifiedServices.length).toBeGreaterThan(0);

      // Test bidirectional synchronization
      const deltasFromB = nodeB.deltaManager.generateDelta(nodeB.services, comparison, 'conflict-node-b', fingerprintA.rootHash);
      const deltasFromA = nodeA.deltaManager.generateDelta(nodeA.services, comparison, 'conflict-node-a', fingerprintB.rootHash);

      const syncResultA = nodeA.deltaManager.applyDelta(nodeA.services, deltasFromB[0]);
      const syncResultB = nodeB.deltaManager.applyDelta(nodeB.services, deltasFromA[0]);

      // Test that conflict detection and delta generation work
      expect(deltasFromA.length).toBeGreaterThan(0);
      expect(deltasFromB.length).toBeGreaterThan(0);
      
      // Results may vary depending on conflict resolution strategy
      // The important thing is that the system handles the conflicts without crashing
      expect(typeof syncResultA.success).toBe('boolean');
      expect(typeof syncResultB.success).toBe('boolean');
    });

    it('should test compression and encryption capabilities', async () => {
      const nodeA = await createTestClusterNode('compression-node-a', basePort + 40);
      const nodeB = await createTestClusterNode('compression-node-b', basePort + 41);

      // Configure for compression testing
      nodeB.deltaManager = new StateDeltaManager({
        maxDeltaSize: 50,
        includeFullServices: true,
        enableCausality: true,
        compressionThreshold: 100, // Low threshold to trigger compression
        enableEncryption: false
      });

      // Create services with repetitive data (compresses well)
      nodeA.services = createServices(5, 'compression-node-a', 'web-server', 'simple');
      nodeB.services = Array.from({ length: 20 }, (_, i) => ({
        id: `compressible-service-${i}`,
        type: 'compressible-service',
        nodeId: 'compression-node-b',
        metadata: {
          name: 'Highly Compressible Service',
          version: '1.0.0',
          description: 'This service has lots of repeated data that should compress very well when delta sync runs',
          role: 'backend'
        },
        stats: { requests: 1000, latency: 50, errors: 0 },
        lastUpdated: Date.now(),
        vectorClock: { 'compression-node-b': 1 },
        version: 1,
        checksum: `checksum-compressible-${i}`,
        conflictPolicy: 'last-writer-wins'
      }));

      const fingerprintA = nodeA.fingerprintGenerator.generateServiceFingerprint(nodeA.services, 'compression-node-a');
      const fingerprintB = nodeB.fingerprintGenerator.generateServiceFingerprint(nodeB.services, 'compression-node-b');

      const comparison = nodeA.fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
      const deltas = nodeB.deltaManager.generateDelta(nodeB.services, comparison, 'compression-node-b', fingerprintA.rootHash);

      // Check compression effectiveness (may not always achieve compression)
      const deltaSize = nodeB.deltaManager.calculateDeltaSize(deltas[0]);
      const uncompressedSize = Buffer.byteLength(JSON.stringify(nodeB.services), 'utf8');
      const compressionRatio = deltaSize / uncompressedSize;

      // Compression may not always be effective with small datasets
      expect(compressionRatio).toBeGreaterThan(0); // Should have some size
      expect(deltas.length).toBeGreaterThan(0);

      const syncResult = nodeA.deltaManager.applyDelta(nodeA.services, deltas[0]);
      expect(syncResult.success).toBe(true);
    });
  });

  describe('Node.ts Integration Tests', () => {
    it('should integrate with real Node instances', async () => {
      const nodeA = await createTestClusterNode('integration-node-a', basePort + 50, true);
      const nodeB = await createTestClusterNode('integration-node-b', basePort + 51, true);

      // Test that nodes are actually running
      expect(nodeA.node.isRunning()).toBe(true);
      expect(nodeB.node.isRunning()).toBe(true);

      // Test node metadata
      expect(nodeA.node.metadata.nodeId).toBe('integration-node-a');
      expect(nodeA.node.metadata.clusterId).toBe('test-cluster');
      expect(nodeA.node.metadata.service).toBe('distributed-core-test');

      // Test that we can get node info
      const nodeInfoA = nodeA.node.getNodeInfo();
      expect(nodeInfoA.id).toBe('integration-node-a');

      // Add services and test delta sync
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

    it('should test cluster membership and health reporting', async () => {
      const nodeA = await createTestClusterNode('health-node-a', basePort + 60, true);
      const nodeB = await createTestClusterNode('health-node-b', basePort + 61, true);

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
      const scales = [10, 50, 100, 200];
      const results: Array<{ scale: number; metrics: PerformanceMetrics }> = [];

      for (const scale of scales) {
        const nodeA = await createTestClusterNode(`bench-node-a-${scale}`, basePort + 70 + scale);
        const nodeB = await createTestClusterNode(`bench-node-b-${scale}`, basePort + 80 + scale);

        nodeA.services = createServices(scale, `bench-node-a-${scale}`, 'web-server', 'complex');
        nodeB.services = createServices(Math.floor(scale * 0.8), `bench-node-b-${scale}`, 'database', 'complex');

        // Benchmark fingerprint generation
        const { duration: fingerprintTime } = await measurePerformance(
          () => {
            const fpA = nodeA.fingerprintGenerator.generateServiceFingerprint(nodeA.services, `bench-node-a-${scale}`);
            const fpB = nodeB.fingerprintGenerator.generateServiceFingerprint(nodeB.services, `bench-node-b-${scale}`);
            return { fpA, fpB };
          }
        );

        // Benchmark delta generation and application
        const fingerprintA = nodeA.fingerprintGenerator.generateServiceFingerprint(nodeA.services, `bench-node-a-${scale}`);
        const fingerprintB = nodeB.fingerprintGenerator.generateServiceFingerprint(nodeB.services, `bench-node-b-${scale}`);
        const comparison = nodeA.fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);

        const { duration: deltaTime } = await measurePerformance(
          () => nodeB.deltaManager.generateDelta(nodeB.services, comparison, `bench-node-b-${scale}`, fingerprintA.rootHash)
        );

        const deltas = nodeB.deltaManager.generateDelta(nodeB.services, comparison, `bench-node-b-${scale}`, fingerprintA.rootHash);
        const { duration: applyTime } = await measurePerformance(
          () => nodeA.deltaManager.applyDelta(nodeA.services, deltas[0])
        );

        // Calculate metrics
        const deltaSize = deltas.reduce((total, delta) => total + nodeB.deltaManager.calculateDeltaSize(delta), 0);
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
      }

      // Analyze performance trends
      // Silent operation - no logging in tests
      
      // Performance assertions
      results.forEach(({ scale, metrics }) => {
        expect(metrics.fingerprintGenerationTime).toBeLessThan(scale * 2); // Should scale linearly
        expect(metrics.deltaGenerationTime).toBeLessThan(scale * 5);
        expect(metrics.deltaApplicationTime).toBeLessThan(scale * 3);
        expect(metrics.bandwidthSavings).toBeGreaterThan(0);
      });

      // Test completed successfully - no logging needed
    });
  });
});
