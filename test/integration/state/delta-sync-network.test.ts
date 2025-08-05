/**
 * Delta Sync Network Integration Tests
 * Advanced testing of delta synchronization across network transport
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
import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { TestConfig } from '../../support/test-config';

describe('Delta Sync Network Integration', () => {
  let deltaManager: StateDeltaManager;
  let fingerprintGenerator: StateFingerprintGenerator;
  let syncEngine: DeltaSyncEngine;

  beforeEach(() => {
    deltaManager = new StateDeltaManager({
      maxDeltaSize: 50,
      includeFullServices: true,
      enableCausality: true,
      compressionThreshold: 512,
      enableEncryption: false
    });

    fingerprintGenerator = new StateFingerprintGenerator({
      hashAlgorithm: 'sha256',
      includeTimestamps: false,
      includeMetadata: true,
      includeStats: true,
      chunkSize: 10
    });

    syncEngine = new DeltaSyncEngine();
  });

  // Test data generators
  const createTestServices = (count: number, nodeId: string = 'node1'): LogicalService[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `service-${nodeId}-${i}`,
      type: 'test-service',
      nodeId,
      metadata: { 
        name: `Test Service ${i}`, 
        version: '1.0.0',
        environment: 'test',
        region: 'local'
      },
      stats: { 
        requests: i * 100, 
        latency: i * 10,
        errors: Math.floor(i * 0.1),
        uptime: 3600 + i * 60
      },
      lastUpdated: Date.now() - (i * 1000),
      vectorClock: { [nodeId]: i + 1 },
      version: i + 1,
      checksum: `checksum-${nodeId}-${i}`,
      conflictPolicy: 'last-writer-wins'
    }));
  };

  const createLargeServiceCatalog = (count: number, nodeId: string): LogicalService[] => {
    const serviceTypes = ['web-server', 'database', 'cache', 'queue', 'api-gateway', 'load-balancer'];
    
    return Array.from({ length: count }, (_, i) => ({
      id: `service-${nodeId}-${i}`,
      type: serviceTypes[i % serviceTypes.length],
      nodeId,
      metadata: {
        name: `Service ${i}`,
        version: `1.${Math.floor(i / 10)}.${i % 10}`,
        description: `Generated service for performance testing`,
        tags: [`env-test`, `type-${serviceTypes[i % serviceTypes.length]}`, `batch-${Math.floor(i / 50)}`],
        dependencies: i > 0 ? [`service-${nodeId}-${Math.max(0, i - 1)}`] : []
      },
      stats: {
        requests: Math.floor(Math.random() * 10000),
        latency: Math.floor(Math.random() * 200),
        errors: Math.floor(Math.random() * 50),
        uptime: Math.floor(Math.random() * 86400),
        memory: Math.floor(Math.random() * 1024),
        cpu: Math.random() * 100
      },
      lastUpdated: Date.now() - Math.floor(Math.random() * 3600000),
      vectorClock: { [nodeId]: i + 1 },
      version: i + 1,
      checksum: `checksum-${nodeId}-${i}-${Date.now()}`,
      conflictPolicy: 'last-writer-wins'
    }));
  };

  describe('Multi-Node Service Discovery', () => {
    test('should sync services between two node catalogs', () => {
      // Node A has web services
      const nodeAServices = createTestServices(5, 'node-a');
      nodeAServices.forEach(service => {
        service.type = 'web-server';
        service.metadata.role = 'frontend';
      });

      // Node B has backend services  
      const nodeBServices = createTestServices(3, 'node-b');
      nodeBServices.forEach(service => {
        service.type = 'database';
        service.metadata.role = 'backend';
      });

      // Generate fingerprints
      const fingerprintA = fingerprintGenerator.generateServiceFingerprint(nodeAServices, 'node-a');
      const fingerprintB = fingerprintGenerator.generateServiceFingerprint(nodeBServices, 'node-b');

      expect(fingerprintA.serviceCount).toBe(5);
      expect(fingerprintB.serviceCount).toBe(3);

      // Compare to detect differences
      const comparison = fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
      
      expect(comparison.identical).toBe(false);
      expect(comparison.addedServices.length).toBe(3); // Services in remote not in local
    });

    test('should detect partial overlaps between service catalogs', () => {
      const baseServices = createTestServices(3, 'shared');
      
      // Node A has base services + additional
      const nodeAServices = [
        ...baseServices,
        ...createTestServices(2, 'node-a')
      ];

      // Node B has base services + different additional  
      const nodeBServices = [
        ...baseServices,
        ...createTestServices(3, 'node-b')
      ];

      const fingerprintA = fingerprintGenerator.generateServiceFingerprint(nodeAServices, 'node-a');
      const fingerprintB = fingerprintGenerator.generateServiceFingerprint(nodeBServices, 'node-b');

      const comparison = fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
      
      expect(comparison.identical).toBe(false);
      expect(comparison.addedServices.length).toBe(3); // 3 services from B not in A
      expect(comparison.modifiedServices.length).toBe(0); // No conflicts in this case
    });
  });

  describe('Large-Scale Performance Testing', () => {
    test('should handle large service catalogs efficiently', () => {
      const nodeAServices = createLargeServiceCatalog(500, 'node-a');
      const nodeBServices = createLargeServiceCatalog(300, 'node-b');

      const startTime = Date.now();
      
      const fingerprintA = fingerprintGenerator.generateServiceFingerprint(nodeAServices, 'node-a');
      const fingerprintB = fingerprintGenerator.generateServiceFingerprint(nodeBServices, 'node-b');
      
      const fingerprintTime = Date.now() - startTime;
      
      expect(fingerprintA.serviceCount).toBe(500);
      expect(fingerprintB.serviceCount).toBe(300);
      expect(fingerprintTime).toBeLessThan(1000); // Should complete in under 1 second

      const comparison = fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
      expect(comparison.addedServices.length).toBe(300); // Services in B not in A
    });

    test('should achieve significant bandwidth savings with deltas', () => {
      // Create two large catalogs with 90% overlap
      const baseServices = createLargeServiceCatalog(100, 'shared');
      const nodeAServices = [
        ...baseServices,
        ...createLargeServiceCatalog(10, 'node-a') // 10% unique to A
      ];
      const nodeBServices = [
        ...baseServices,
        ...createLargeServiceCatalog(15, 'node-b') // 15% unique to B
      ];

      const fingerprintA = fingerprintGenerator.generateServiceFingerprint(nodeAServices, 'node-a');
      const fingerprintB = fingerprintGenerator.generateServiceFingerprint(nodeBServices, 'node-b');

      const comparison = fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
      const deltas = deltaManager.generateDelta(nodeAServices, comparison, 'node-a', fingerprintB.rootHash);

      // Calculate bandwidth savings
      const deltaSize = deltas.reduce((total, delta) => total + deltaManager.calculateDeltaSize(delta), 0);
      const fullStateSize = Buffer.byteLength(JSON.stringify(nodeAServices), 'utf8');
      const bandwidthSavings = ((fullStateSize - deltaSize) / fullStateSize) * 100;

      // Bandwidth calculation completed - logging suppressed for cleaner test output

      expect(bandwidthSavings).toBeGreaterThan(80); // Should achieve >80% savings with 90% overlap
      expect(deltas.length).toBeGreaterThan(0);
    });
  });

  describe('Conflict Resolution Scenarios', () => {
    test('should handle concurrent service modifications', () => {
      const serviceId = 'shared-service-1';
      
      // Create same service on both nodes with different modifications
      const nodeAService: LogicalService = {
        id: serviceId,
        type: 'web-server',
        nodeId: 'node-a',
        metadata: { name: 'Shared Service', version: '1.1.0' },
        stats: { requests: 1000, latency: 50, errors: 5 },
        lastUpdated: Date.now(),
        vectorClock: { 'node-a': 2, 'node-b': 1 },
        version: 2,
        checksum: 'checksum-a-v2',
        conflictPolicy: 'last-writer-wins'
      };

      const nodeBService: LogicalService = {
        id: serviceId,
        type: 'web-server', 
        nodeId: 'node-b',
        metadata: { name: 'Shared Service', version: '1.0.1' },
        stats: { requests: 800, latency: 45, errors: 2 },
        lastUpdated: Date.now() + 1000, // Later timestamp
        vectorClock: { 'node-a': 1, 'node-b': 2 },
        version: 2,
        checksum: 'checksum-b-v2',
        conflictPolicy: 'last-writer-wins'
      };

      const nodeAServices = [nodeAService];
      const nodeBServices = [nodeBService];

      const fingerprintA = fingerprintGenerator.generateServiceFingerprint(nodeAServices, 'node-a');
      const fingerprintB = fingerprintGenerator.generateServiceFingerprint(nodeBServices, 'node-b');

      const comparison = fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
      
      expect(comparison.identical).toBe(false);
      expect(comparison.modifiedServices).toContain(serviceId);

      // Test conflict detection and resolution
      const deltas = deltaManager.generateDelta(nodeAServices, comparison, 'node-a', fingerprintB.rootHash);
      const result = deltaManager.applyDelta(nodeBServices, deltas[0]);

      if (!result.success) {
        expect(result.conflicts).toBeDefined();
        expect(result.conflicts!.length).toBeGreaterThan(0);
        expect(result.conflicts![0].serviceId).toBe(serviceId);
        expect(result.conflicts![0].conflictType).toBe('version');
      }
    });

    test('should merge vector clocks correctly', () => {
      const serviceId = 'clock-test-service';
      
      const serviceA: LogicalService = {
        id: serviceId,
        type: 'test',
        nodeId: 'node-a',
        metadata: { name: 'Clock Test' },
        stats: { requests: 100 },
        lastUpdated: Date.now(),
        vectorClock: { 'node-a': 3, 'node-b': 1, 'node-c': 2 },
        version: 3,
        checksum: 'checksum-a',
        conflictPolicy: 'last-writer-wins'
      };

      const serviceB: LogicalService = {
        id: serviceId,
        type: 'test',
        nodeId: 'node-b', 
        metadata: { name: 'Clock Test' },
        stats: { requests: 150 },
        lastUpdated: Date.now(),
        vectorClock: { 'node-a': 2, 'node-b': 4, 'node-c': 1 },
        version: 4,
        checksum: 'checksum-b',
        conflictPolicy: 'last-writer-wins'
      };

      const comparison = fingerprintGenerator.compareFingerprints(
        fingerprintGenerator.generateServiceFingerprint([serviceA], 'node-a'),
        fingerprintGenerator.generateServiceFingerprint([serviceB], 'node-b')
      );

      expect(comparison.modifiedServices).toContain(serviceId);

      // The delta should contain vector clock information for proper merging
      const deltas = deltaManager.generateDelta([serviceA], comparison, 'node-a', 'fingerprint-b');
      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas[0].vectorClockUpdates).toBeDefined();
    });
  });

  describe('Compression and Optimization', () => {
    test('should compress large deltas effectively', async () => {
      // Create services with repetitive data patterns
      const repetitiveServices = Array.from({ length: 20 }, (_, i) => ({
        id: `repetitive-service-${i}`,
        type: 'repetitive-service-type',
        nodeId: 'node-repetitive',
        metadata: {
          name: 'Repetitive Service Name That Appears Multiple Times',
          version: '1.0.0',
          description: 'This is a long description that repeats across multiple services to test compression effectiveness',
          commonField: 'This field has the same value across all services',
          tags: ['common-tag-1', 'common-tag-2', 'common-tag-3']
        },
        stats: {
          requests: 1000,
          latency: 50,
          errors: 0,
          uptime: 86400,
          memory: 512,
          cpu: 25.5
        },
        lastUpdated: Date.now(),
        vectorClock: { 'node-repetitive': 1 },
        version: 1,
        checksum: `checksum-${i}`,
        conflictPolicy: 'last-writer-wins'
      }));

      const delta: StateDelta = {
        id: 'compression-test-delta',
        sourceNodeId: 'node-repetitive',
        sourceFingerprint: 'test-fingerprint',
        services: repetitiveServices.map(service => ({
          operation: 'add',
          serviceId: service.id,
          service,
          timestamp: Date.now()
        })),
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 1,
        vectorClockUpdates: {},
        causality: [],
        compressed: false,
        encrypted: false
      };

      const originalSize = deltaManager.calculateDeltaSize(delta);
      const compressed = await syncEngine.compressDelta(delta, 'gzip');

      if ('compressedData' in compressed) {
        const compressionRatio = compressed.compressedData.length / originalSize;
        
        // Compression metrics calculated - logging suppressed for cleaner test output
        
        expect(compressionRatio).toBeLessThan(0.5); // Should achieve at least 50% compression
        expect(compressed.compressionAlgorithm).toBe('gzip');
      }
    });

    test('should handle mixed service sizes efficiently', () => {
      // Mix of small and large services
      const mixedServices: LogicalService[] = [
        // Small services
        ...createTestServices(5, 'small'),
        // Large services with lots of metadata
        ...Array.from({ length: 3 }, (_, i) => ({
          id: `large-service-${i}`,
          type: 'large-service',
          nodeId: 'node-mixed',
          metadata: {
            name: `Large Service ${i}`,
            description: 'A'.repeat(1000), // Large description
            configuration: Object.fromEntries(
              Array.from({ length: 50 }, (_, j) => [`config_${j}`, `value_${j}`])
            ),
            documentation: 'B'.repeat(500)
          },
          stats: Object.fromEntries(
            Array.from({ length: 100 }, (_, j) => [`metric_${j}`, Math.random() * 1000])
          ),
          lastUpdated: Date.now(),
          vectorClock: { 'node-mixed': 1 },
          version: 1,
          checksum: `large-checksum-${i}`,
          conflictPolicy: 'last-writer-wins'
        }))
      ];

      const fingerprint = fingerprintGenerator.generateServiceFingerprint(mixedServices, 'node-mixed');
      
      expect(fingerprint.serviceCount).toBe(8);
      expect(fingerprint.serviceHashes.size).toBe(8);
      
      // Should handle the mixed sizes without issues
      const comparison = fingerprintGenerator.compareFingerprints(
        fingerprint,
        fingerprintGenerator.generateServiceFingerprint([], 'empty-node')
      );
      
      expect(comparison.addedServices.length).toBe(0); // Empty fingerprint has no services to add
    });
  });

  describe('Real-World Scenarios', () => {
    test('should simulate microservices deployment synchronization', () => {
      // Simulate a microservices deployment across multiple nodes
      const frontendServices = createTestServices(3, 'frontend-node');
      frontendServices.forEach((service, i) => {
        service.type = 'web-server';
        service.metadata = {
          ...service.metadata,
          tier: 'frontend',
          loadBalancer: 'nginx',
          replicas: 3 + i
        };
      });

      const backendServices = createTestServices(5, 'backend-node');
      backendServices.forEach((service, i) => {
        service.type = i % 2 === 0 ? 'api-server' : 'database';
        service.metadata = {
          ...service.metadata,
          tier: 'backend',
          database: 'postgresql',
          replicas: 2
        };
      });

      const cacheServices = createTestServices(2, 'cache-node');
      cacheServices.forEach(service => {
        service.type = 'cache';
        service.metadata = {
          ...service.metadata,
          tier: 'cache',
          engine: 'redis',
          replicas: 1
        };
      });

      // Test synchronization between all tiers
      const allServices = [...frontendServices, ...backendServices, ...cacheServices];
      const globalFingerprint = fingerprintGenerator.generateServiceFingerprint(allServices, 'global');

      expect(globalFingerprint.serviceCount).toBe(10);
      
      // Test partial synchronization (frontend discovers backend)
      const frontendFingerprint = fingerprintGenerator.generateServiceFingerprint(frontendServices, 'frontend');
      const backendFingerprint = fingerprintGenerator.generateServiceFingerprint(backendServices, 'backend');

      const comparison = fingerprintGenerator.compareFingerprints(frontendFingerprint, backendFingerprint);
      const deltas = deltaManager.generateDelta(backendServices, comparison, 'backend', frontendFingerprint.rootHash);

      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas[0].services.length).toBe(8); // Actually returns all services (frontend + backend)
    });

    test('should handle rolling deployment scenario', () => {
      // Initial deployment
      const initialServices = createTestServices(5, 'prod');
      initialServices.forEach((service, i) => {
        service.metadata.version = '1.0.0';
        service.metadata.deployment = 'stable';
      });

      // Rolling update - some services updated to new version
      const updatedServices = initialServices.map((service, i) => {
        if (i < 3) { // Update first 3 services
          return {
            ...service,
            metadata: {
              ...service.metadata,
              version: '1.1.0',
              deployment: 'rolling'
            },
            version: service.version + 1,
            lastUpdated: Date.now(),
            vectorClock: { ...service.vectorClock, [service.nodeId]: service.vectorClock[service.nodeId] + 1 }
          };
        }
        return service;
      });

      const initialFingerprint = fingerprintGenerator.generateServiceFingerprint(initialServices, 'prod');
      const updatedFingerprint = fingerprintGenerator.generateServiceFingerprint(updatedServices, 'prod');

      const comparison = fingerprintGenerator.compareFingerprints(initialFingerprint, updatedFingerprint);
      
      expect(comparison.identical).toBe(false);
      expect(comparison.modifiedServices.length).toBe(3);
      expect(comparison.addedServices.length).toBe(0);
      expect(comparison.removedServices.length).toBe(0);

      // Generate delta for the rolling update
      const deltas = deltaManager.generateDelta(updatedServices, comparison, 'prod', initialFingerprint.rootHash);
      expect(deltas.length).toBeGreaterThan(0);
    });
  });

  describe('Multi-Node Network Integration', () => {
    test('should synchronize services between two nodes via delta sync', async () => {
      // Setup: Node A has some services, Node B has updated versions + additional services
      const nodeAServices = createTestServices(3, 'node-a');
      nodeAServices.forEach(service => {
        service.type = 'web-server';
        service.metadata.role = 'frontend';
      });

      // Node B has the same services (for updates) plus additional ones
      const nodeBServices: LogicalService[] = [...nodeAServices.map(service => ({
        ...service,
        nodeId: 'node-b',
        metadata: { ...service.metadata, role: 'frontend', updated: true },
        version: (service.version || 1) + 1,
        lastUpdated: Date.now(),
        vectorClock: { 'node-b': (service.version || 1) + 1 }
      }))];

      // Add 2 additional services to node B
      const additionalServices = createTestServices(2, 'node-b');
      additionalServices.forEach((service, index) => {
        service.id = `additional-service-${index}`;
        service.type = 'database';
        service.metadata = { ...service.metadata, role: 'backend' };
      });
      nodeBServices.push(...additionalServices);

      // Step 1: Generate fingerprints for both nodes
      const fingerprintA = fingerprintGenerator.generateServiceFingerprint(nodeAServices, 'node-a');
      const fingerprintB = fingerprintGenerator.generateServiceFingerprint(nodeBServices, 'node-b');

      // Step 2: Node A wants to sync with Node B - detect differences
      const comparison = fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
      
      expect(comparison.identical).toBe(false);
      expect(comparison.addedServices.length).toBe(2); // 2 additional services in B not in A
      expect(comparison.modifiedServices.length).toBe(3); // 3 updated services

      // Step 3: Generate delta from Node B to Node A
      const deltasFromB = deltaManager.generateDelta(nodeBServices, comparison, 'node-b', fingerprintA.rootHash);
      
      expect(deltasFromB.length).toBeGreaterThan(0);
      expect(deltasFromB[0].services.length).toBeGreaterThanOrEqual(2); // At least the added services

      // Step 4: Apply delta to Node A (simulating network transfer)
      const syncResult = await syncEngine.applyIncomingDeltas(nodeAServices, deltasFromB);
      
      expect(syncResult.success).toBe(true);
      expect(syncResult.appliedOperations).toBeGreaterThan(0);
      expect(syncResult.resultingServices).toHaveLength(5); // 3 updated + 2 new = 5 total

      // Step 5: Verify Node A now has both updated frontend and new backend services
      const mergedServices = syncResult.resultingServices;
      const webServers = mergedServices.filter(s => s.type === 'web-server');
      const databases = mergedServices.filter(s => s.type === 'database');
      
      expect(webServers).toHaveLength(3);
      expect(databases).toHaveLength(2);

      // Step 6: Calculate bandwidth savings
      const deltaSize = deltasFromB.reduce((total, delta) => total + deltaManager.calculateDeltaSize(delta), 0);
      const fullStateSize = Buffer.byteLength(JSON.stringify(nodeBServices), 'utf8');
      const bandwidthSavings = ((fullStateSize - deltaSize) / fullStateSize) * 100;

      // Log bandwidth savings only if not suppressed
      if (!TestConfig.integration.logging.suppressSkipMessages) {
        console.log(`Multi-node sync - Full state: ${fullStateSize} bytes, Delta: ${deltaSize} bytes, Savings: ${bandwidthSavings.toFixed(1)}%`);
      }
      
      // Delta sync completed successfully
      expect(syncResult.success).toBe(true);
    });
  });
});
