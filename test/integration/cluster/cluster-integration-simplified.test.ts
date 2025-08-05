/**
 * Simplified Cluster Integration Test
 * Focused on working multi-node delta sync with proper cleanup
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

describe('Simplified Cluster Integration', () => {
  let testCluster: TestClusterNode[] = [];
  const basePort = 19000;

  beforeEach(() => {
    testCluster = [];
  });

  afterEach(async () => {
    // Simple cleanup - let Jest handle the timeouts
    const cleanupPromises = testCluster.map(async (clusterNode) => {
      try {
        if (clusterNode.node.isRunning()) {
          await clusterNode.node.stop();
        }
      } catch (error) {
        // Ignore cleanup errors in tests
      }
    });

    await Promise.allSettled(cleanupPromises);
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
      enableMetrics: true,
      enableChaos: false, // Disable chaos to reduce complexity
      enableLogging: false,
      // Configure for faster test shutdown
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

  it('should synchronize services between two nodes (regression test)', async () => {
    // Create two test nodes
    const nodeA = await createTestClusterNode('node-a', basePort);
    const nodeB = await createTestClusterNode('node-b', basePort + 1);
    testCluster.push(nodeA, nodeB);

    // Setup services
    nodeA.services = createServices(3, 'node-a', 'web-server');
    nodeB.services = createServices(2, 'node-b', 'database');

    // Step 1: Generate fingerprints
    const fingerprintA = nodeA.fingerprintGenerator.generateServiceFingerprint(nodeA.services, 'node-a');
    const fingerprintB = nodeB.fingerprintGenerator.generateServiceFingerprint(nodeB.services, 'node-b');

    expect(fingerprintA.serviceCount).toBe(3);
    expect(fingerprintB.serviceCount).toBe(2);

    // Step 2: Compare and generate delta
    const comparison = nodeA.fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
    expect(comparison.identical).toBe(false);
    expect(comparison.addedServices.length).toBe(2);

    // Step 3: Apply delta
    const deltasFromB = nodeB.deltaManager.generateDelta(nodeB.services, comparison, 'node-b', fingerprintA.rootHash);
    const syncResult = nodeA.deltaManager.applyDelta(nodeA.services, deltasFromB[0]);

    expect(syncResult.success).toBe(true);
    expect(syncResult.resultingServices).toHaveLength(2);
  });

  it('should handle scale with 100+ services efficiently', async () => {
    const nodeA = await createTestClusterNode('scale-node-a', basePort + 10);
    const nodeB = await createTestClusterNode('scale-node-b', basePort + 11);
    testCluster.push(nodeA, nodeB);

    // Create larger service catalogs
    nodeA.services = createServices(60, 'scale-node-a', 'web-server');
    nodeB.services = createServices(40, 'scale-node-b', 'database');

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
    expect(duration).toBeLessThan(100); // Should complete in under 100ms
    expect(syncResult.success).toBe(true);
    expect(bandwidthSavings).toBeGreaterThan(0);
  });

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
  });

  it('should perform multi-node cluster synchronization', async () => {
    // Create a 3-node cluster for testing
    const nodeCount = 3;
    const nodes: TestClusterNode[] = [];

    for (let i = 0; i < nodeCount; i++) {
      const node = await createTestClusterNode(`cluster-node-${i}`, basePort + 60 + i);
      const serviceTypes = ['web-server', 'database', 'cache'];
      node.services = createServices(10, `cluster-node-${i}`, serviceTypes[i]);
      nodes.push(node);
      testCluster.push(node);
    }

    // Test synchronization between all pairs
    let totalSyncOperations = 0;
    let totalBandwidthSavings = 0;

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

            // Calculate bandwidth savings
            const deltaSize = deltas.reduce((total: number, delta: StateDelta) => total + nodeB.deltaManager.calculateDeltaSize(delta), 0);
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
  });
});
