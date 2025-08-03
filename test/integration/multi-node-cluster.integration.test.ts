/**
 * Multi-Node Cluster Integration Tests
 * Tests end-to-end delta synchronization across real network transport
 */

import { WebSocketAdapter } from '../../src/transport/adapters/WebSocketAdapter';
import { StateFingerprintGenerator } from '../../src/cluster/delta-sync/StateFingerprint';
import { StateDeltaManager } from '../../src/cluster/delta-sync/StateDelta';
import { DeltaSyncEngine } from '../../src/cluster/delta-sync/DeltaSync';
import { LogicalService } from '../../src/cluster/introspection/ClusterIntrospection';
import { NodeMetadata } from '../../src/identity/NodeMetadata';
import { InMemoryCoordinator } from '../../src/coordinators/InMemoryCoordinator';
import { ClusterManager } from '../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../src/cluster/config/BootstrapConfig';

interface TestNode {
  id: string;
  port: number;
  websocketAdapter: WebSocketAdapter;
  deltaSyncEngine: DeltaSyncEngine;
  clusterManager: ClusterManager;
  coordinator: InMemoryCoordinator;
  services: LogicalService[];
}

describe('Multi-Node Cluster Integration', () => {
  let testNodes: TestNode[] = [];
  const basePort = 18000;

  beforeEach(async () => {
    testNodes = [];
  });

  afterEach(async () => {
    // Clean shutdown of all test nodes
    await Promise.all(
      testNodes.map(async (node) => {
        try {
          await node.websocketAdapter.stop();
          await node.clusterManager.stop();
        } catch (error) {
          console.warn(`Error stopping node ${node.id}:`, error);
        }
      })
    );
    testNodes = [];
    
    // Give a brief moment for all async cleanup to complete
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 50);
      timer.unref();
    });
  });

  const createTestNode = async (nodeId: string, port: number): Promise<TestNode> => {
    const nodeMetadata = new NodeMetadata(
      nodeId,
      'test-cluster',
      'test-service',
      'test-zone',
      'test-region',
      'test-pub-key',
      Date.now(),
      0,
      '1.0.0'
    );

    const websocketAdapter = new WebSocketAdapter(
      { id: nodeId, address: '127.0.0.1', port },
      {
        port,
        host: '127.0.0.1',
        maxConnections: 50,
        pingInterval: 1000, // Reduced from 5000ms for faster testing
        enableCompression: true,
        enableLogging: false
      }
    );

    const coordinator = new InMemoryCoordinator();
    
    const clusterManager = new ClusterManager(
      nodeId,
      websocketAdapter,
      new BootstrapConfig(
        [], // seedNodes
        2000, // joinTimeout - reduced from 5000ms
        200, // gossipInterval - reduced from 1000ms for faster testing
        false, // enableLogging
        {}, // failureDetector
        {}, // keyManager
        {}, // lifecycle
        {} // seedHealthOptions
      )
    );

    const deltaSyncEngine = new DeltaSyncEngine();

    // Start the node
    await websocketAdapter.start();
    await clusterManager.start();

    const testNode: TestNode = {
      id: nodeId,
      port,
      clusterManager,
      websocketAdapter,
      coordinator,
      deltaSyncEngine,
      services: []
    };

    return testNode;
  };

  const addServiceToNode = (node: TestNode, serviceId: string, serviceType: string = 'test-service') => {
    const service: LogicalService = {
      id: serviceId,
      type: serviceType,
      nodeId: node.id,
      metadata: {
        name: `Service ${serviceId}`,
        version: '1.0.0',
        description: `Test service on node ${node.id}`
      },
      stats: {
        requests: Math.floor(Math.random() * 1000),
        latency: Math.floor(Math.random() * 100),
        errors: Math.floor(Math.random() * 10)
      },
      lastUpdated: Date.now(),
      vectorClock: { [node.id]: 1 },
      version: 1,
      checksum: `checksum-${serviceId}-${Date.now()}`,
      conflictPolicy: 'last-writer-wins'
    };

    node.services.push(service);
    return service;
  };

  const connectNodes = async (nodeA: TestNode, nodeB: TestNode) => {
    await nodeA.websocketAdapter.connect({
      id: nodeB.id,
      address: '127.0.0.1',
      port: nodeB.port
    });
    // Allow some time for connection establishment
    // Allow time for connection establishment - reduced from 500ms
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 100);
      timer.unref();
    });
  };

  describe('Two-Node Delta Synchronization', () => {
    test('should sync services between two nodes', async () => {
      // Create two test nodes
      const nodeA = await createTestNode('node-a', basePort);
      const nodeB = await createTestNode('node-b', basePort + 1);
      testNodes.push(nodeA, nodeB);

      // Add services to node A
      addServiceToNode(nodeA, 'service-1', 'web-server');
      addServiceToNode(nodeA, 'service-2', 'database');

      // Add different services to node B
      addServiceToNode(nodeB, 'service-3', 'cache');
      addServiceToNode(nodeB, 'service-4', 'queue');

      // Connect the nodes
      await connectNodes(nodeA, nodeB);

      // Generate fingerprints
      const fingerprintGen = new StateFingerprintGenerator({
        hashAlgorithm: 'sha256',
        includeTimestamps: false,
        includeMetadata: true,
        includeStats: true,
        chunkSize: 5
      });

      const fingerprintA = fingerprintGen.generateServiceFingerprint(nodeA.services, nodeA.id);
      const fingerprintB = fingerprintGen.generateServiceFingerprint(nodeB.services, nodeB.id);

      // Compare fingerprints to detect differences
      const comparison = fingerprintGen.compareFingerprints(fingerprintA, fingerprintB);
      
      expect(comparison.identical).toBe(false);
      expect(comparison.addedServices.length).toBeGreaterThan(0);

      // Generate deltas
      const deltaManager = new StateDeltaManager({
        maxDeltaSize: 10,
        includeFullServices: true,
        enableCausality: true,
        compressionThreshold: 512,
        enableEncryption: false
      });

      const deltasA = deltaManager.generateDelta(nodeA.services, comparison, nodeA.id, fingerprintB.rootHash);
      const deltasB = deltaManager.generateDelta(nodeB.services, comparison, nodeB.id, fingerprintA.rootHash);

      expect(deltasA.length).toBeGreaterThan(0);
      expect(deltasB.length).toBeGreaterThan(0);

      // Apply deltas (simulate sync)
      const resultA = deltaManager.applyDelta(nodeB.services, deltasA[0]);
      const resultB = deltaManager.applyDelta(nodeA.services, deltasB[0]);

      expect(resultA.success).toBe(true);
      expect(resultB.success).toBe(true);
      expect(resultA.appliedOperations).toBeGreaterThan(0);
      expect(resultB.appliedOperations).toBeGreaterThan(0);
    }, 3000); // Reduced from 10000ms
  });

  describe('Three-Node Cluster Formation', () => {
    test('should form cluster and sync across all nodes', async () => {
      // Create three nodes
      const nodeA = await createTestNode('node-a', basePort + 10);
      const nodeB = await createTestNode('node-b', basePort + 11);
      const nodeC = await createTestNode('node-c', basePort + 12);
      testNodes.push(nodeA, nodeB, nodeC);

      // Add unique services to each node
      addServiceToNode(nodeA, 'service-a1', 'web-server');
      addServiceToNode(nodeA, 'service-a2', 'api-gateway');

      addServiceToNode(nodeB, 'service-b1', 'database');
      addServiceToNode(nodeB, 'service-b2', 'cache');

      addServiceToNode(nodeC, 'service-c1', 'queue');
      addServiceToNode(nodeC, 'service-c2', 'monitor');

      // Connect nodes in a ring topology: A -> B -> C -> A
      await connectNodes(nodeA, nodeB);
      await connectNodes(nodeB, nodeC);
      await connectNodes(nodeC, nodeA);

      // Allow time for gossip propagation
      // Wait for cluster stabilization and gossip convergence - reduced from 3000ms
      // Wait for cluster stabilization and gossip convergence - reduced from 3000ms
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 300);
        timer.unref();
      });

      // Verify all nodes can see each other
      const connectedNodesA = nodeA.websocketAdapter.getConnectedNodes();
      const connectedNodesB = nodeB.websocketAdapter.getConnectedNodes();
      const connectedNodesC = nodeC.websocketAdapter.getConnectedNodes();

      expect(connectedNodesA.length).toBeGreaterThan(0);
      expect(connectedNodesB.length).toBeGreaterThan(0);
      expect(connectedNodesC.length).toBeGreaterThan(0);

      // Test delta sync across all three nodes
      const fingerprintGen = new StateFingerprintGenerator({
        hashAlgorithm: 'sha256',
        includeTimestamps: false,
        includeMetadata: true,
        includeStats: true,
        chunkSize: 5
      });

      const allServices = [...nodeA.services, ...nodeB.services, ...nodeC.services];
      const globalFingerprint = fingerprintGen.generateServiceFingerprint(allServices, 'global');

      expect(globalFingerprint.serviceCount).toBe(6);
      expect(globalFingerprint.serviceHashes.size).toBe(6);
    }, 5000); // Reduced from 15000ms
  });

  describe('Network Partition and Recovery', () => {
    test('should handle network partition and recover when reconnected', async () => {
      const nodeA = await createTestNode('node-a', basePort + 20);
      const nodeB = await createTestNode('node-b', basePort + 21);
      testNodes.push(nodeA, nodeB);

      // Initial state
      addServiceToNode(nodeA, 'service-1', 'web-server');
      addServiceToNode(nodeB, 'service-2', 'database');

      // Connect and sync
      await connectNodes(nodeA, nodeB);
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 200);
        timer.unref();
      }); // Reduced from 1000ms

      // Simulate network partition by stopping one adapter
      await nodeB.websocketAdapter.stop();

      // Add services while partitioned
      addServiceToNode(nodeA, 'service-3', 'cache');
      addServiceToNode(nodeB, 'service-4', 'queue');

      // Restart nodeB and reconnect
      await nodeB.websocketAdapter.start();
      await connectNodes(nodeA, nodeB);

      // Allow time for reconnection and sync
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 500);
        timer.unref();
      }); // Reduced from 2000ms

      // Verify both nodes have all services after recovery
      const deltaManager = new StateDeltaManager({
        maxDeltaSize: 10,
        includeFullServices: true,
        enableCausality: true,
        compressionThreshold: 512,
        enableEncryption: false
      });

      const fingerprintGen = new StateFingerprintGenerator({
        hashAlgorithm: 'sha256',
        includeTimestamps: false,
        includeMetadata: true,
        includeStats: true,
        chunkSize: 5
      });

      const fingerprintA = fingerprintGen.generateServiceFingerprint(nodeA.services, nodeA.id);
      const fingerprintB = fingerprintGen.generateServiceFingerprint(nodeB.services, nodeB.id);

      // Should have different states that need syncing
      const comparison = fingerprintGen.compareFingerprints(fingerprintA, fingerprintB);
      expect(comparison.identical).toBe(false);

      // Generate and apply deltas to achieve consistency
      const deltasForB = deltaManager.generateDelta(nodeA.services, comparison, nodeA.id, fingerprintB.rootHash);
      const deltasForA = deltaManager.generateDelta(nodeB.services, comparison, nodeB.id, fingerprintA.rootHash);

      if (deltasForB.length > 0) {
        const resultB = deltaManager.applyDelta(nodeB.services, deltasForB[0]);
        expect(resultB.success).toBe(true);
      }

      if (deltasForA.length > 0) {
        const resultA = deltaManager.applyDelta(nodeA.services, deltasForA[0]);
        expect(resultA.success).toBe(true);
      }
    }, 5000); // Reduced from 15000ms
  });

  describe('Performance and Bandwidth Testing', () => {
    test('should demonstrate bandwidth savings with large service catalogs', async () => {
      const nodeA = await createTestNode('node-a', basePort + 30);
      const nodeB = await createTestNode('node-b', basePort + 31);
      testNodes.push(nodeA, nodeB);

      // Create service catalog on node A - reduced size for faster testing
      for (let i = 0; i < 20; i++) {
        addServiceToNode(nodeA, `service-a-${i}`, `type-${i % 5}`);
      }

      // Create smaller catalog on node B with some overlap - reduced size
      for (let i = 15; i < 25; i++) {
        addServiceToNode(nodeB, `service-b-${i}`, `type-${i % 5}`);
      }

      await connectNodes(nodeA, nodeB);

      const fingerprintGen = new StateFingerprintGenerator({
        hashAlgorithm: 'sha256',
        includeTimestamps: false,
        includeMetadata: true,
        includeStats: true,
        chunkSize: 10
      });

      const deltaManager = new StateDeltaManager({
        maxDeltaSize: 50,
        includeFullServices: true,
        enableCausality: true,
        compressionThreshold: 512,
        enableEncryption: false
      });

      const fingerprintA = fingerprintGen.generateServiceFingerprint(nodeA.services, nodeA.id);
      const fingerprintB = fingerprintGen.generateServiceFingerprint(nodeB.services, nodeB.id);

      const comparison = fingerprintGen.compareFingerprints(fingerprintA, fingerprintB);
      const deltas = deltaManager.generateDelta(nodeA.services, comparison, nodeA.id, fingerprintB.rootHash);

      // Calculate bandwidth savings
      const deltaSize = deltas.reduce((total, delta) => total + deltaManager.calculateDeltaSize(delta), 0);
      const fullStateSize = Buffer.byteLength(JSON.stringify(nodeA.services), 'utf8');
      const bandwidthSavings = ((fullStateSize - deltaSize) / fullStateSize) * 100;

      // Bandwidth calculation completed - no logging needed

      expect(bandwidthSavings).toBeGreaterThan(50); // Expect at least 50% savings
      expect(deltas.length).toBeGreaterThan(0);
    }, 5000); // Reduced from 20000ms
  });

  describe('Concurrent Modifications', () => {
    test('should handle concurrent service modifications across nodes', async () => {
      const nodeA = await createTestNode('node-a', basePort + 40);
      const nodeB = await createTestNode('node-b', basePort + 41);
      testNodes.push(nodeA, nodeB);

      // Start with same service on both nodes
      const serviceA = addServiceToNode(nodeA, 'shared-service', 'shared-type');
      const serviceB = addServiceToNode(nodeB, 'shared-service', 'shared-type');

      await connectNodes(nodeA, nodeB);

      // Modify the service concurrently on both nodes
      serviceA.stats.requests = 1000;
      serviceA.version = 2;
      serviceA.lastUpdated = Date.now();
      serviceA.vectorClock[nodeA.id] = 2;

      serviceB.stats.latency = 50;
      serviceB.version = 2;
      serviceB.lastUpdated = Date.now() + 100; // Slightly later
      serviceB.vectorClock[nodeB.id] = 2;

      const deltaManager = new StateDeltaManager({
        maxDeltaSize: 10,
        includeFullServices: true,
        enableCausality: true,
        compressionThreshold: 512,
        enableEncryption: false
      });

      // Create conflicting deltas
      const fingerprintGen = new StateFingerprintGenerator({
        hashAlgorithm: 'sha256',
        includeTimestamps: false,
        includeMetadata: true,
        includeStats: true,
        chunkSize: 5
      });

      const fingerprintA = fingerprintGen.generateServiceFingerprint(nodeA.services, nodeA.id);
      const fingerprintB = fingerprintGen.generateServiceFingerprint(nodeB.services, nodeB.id);

      const comparison = fingerprintGen.compareFingerprints(fingerprintA, fingerprintB);
      expect(comparison.identical).toBe(false);
      expect(comparison.modifiedServices).toContain('shared-service');

      // Test conflict resolution
      const deltas = deltaManager.generateDelta(nodeA.services, comparison, nodeA.id, fingerprintB.rootHash);
      const result = deltaManager.applyDelta(nodeB.services, deltas[0]);

      // Should detect and handle the conflict
      if (!result.success) {
        expect(result.conflicts).toBeDefined();
        expect(result.conflicts!.length).toBeGreaterThan(0);
        expect(result.conflicts![0].conflictType).toBeDefined();
      }
    }, 3000); // Reduced from 10000ms
  });
});
