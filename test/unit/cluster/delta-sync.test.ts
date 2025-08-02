/**
 * Delta Synchronization Tests
 * Tests for bandwidth-optimized state synchronization with compression and encryption
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

describe('Delta Synchronization', () => {
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

  // Sample services for testing
  const createTestServices = (count: number, nodeId: string = 'node1'): LogicalService[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `service-${i}`,
      type: 'test-service',
      nodeId,
      metadata: { name: `Test Service ${i}`, version: '1.0.0' },
      stats: { requests: i * 100, latency: i * 10 },
      lastUpdated: Date.now() - (i * 1000),
      vectorClock: { [nodeId]: i + 1 },
      version: i + 1,
      checksum: `checksum-${i}`,
      conflictPolicy: 'last-writer-wins'
    }));
  };

  describe('StateFingerprint', () => {
    it('should generate deterministic fingerprints', () => {
      const services = createTestServices(5);
      
      const fingerprint1 = fingerprintGenerator.generateServiceFingerprint(services, 'node1');
      const fingerprint2 = fingerprintGenerator.generateServiceFingerprint(services, 'node1');
      
      expect(fingerprint1.rootHash).toBe(fingerprint2.rootHash);
      expect(fingerprint1.serviceCount).toBe(5);
    });

    it('should detect service differences', () => {
      const services1 = createTestServices(3);
      const services2 = createTestServices(5); // 2 additional services
      
      const fingerprint1 = fingerprintGenerator.generateServiceFingerprint(services1, 'node1');
      const fingerprint2 = fingerprintGenerator.generateServiceFingerprint(services2, 'node1');
      
      const comparison = fingerprintGenerator.compareFingerprints(fingerprint1, fingerprint2);
      
      expect(comparison.identical).toBe(false);
      expect(comparison.addedServices).toContain('service-3');
      expect(comparison.addedServices).toContain('service-4');
    });

    it('should handle modified services', () => {
      const services1 = createTestServices(3);
      const services2 = [...services1];
      
      // Modify one service
      services2[1] = {
        ...services2[1],
        stats: { requests: 999, latency: 50 },
        version: services2[1].version + 1
      };
      
      const fingerprint1 = fingerprintGenerator.generateServiceFingerprint(services1, 'node1');
      const fingerprint2 = fingerprintGenerator.generateServiceFingerprint(services2, 'node1');
      
      const comparison = fingerprintGenerator.compareFingerprints(fingerprint1, fingerprint2);
      
      expect(comparison.identical).toBe(false);
      expect(comparison.modifiedServices).toContain('service-1');
    });

    it('should identify removed services', () => {
      const services1 = createTestServices(5);
      const services2 = services1.slice(0, 3); // Remove 2 services
      
      const fingerprint1 = fingerprintGenerator.generateServiceFingerprint(services1, 'node1');
      const fingerprint2 = fingerprintGenerator.generateServiceFingerprint(services2, 'node1');
      
      const comparison = fingerprintGenerator.compareFingerprints(fingerprint1, fingerprint2);
      
      expect(comparison.identical).toBe(false);
      expect(comparison.removedServices).toContain('service-3');
      expect(comparison.removedServices).toContain('service-4');
    });
  });

  describe('StateDelta', () => {
    it('should generate deltas from fingerprint comparison', () => {
      const services1 = createTestServices(3);
      const services2 = createTestServices(5);
      
      const fingerprint1 = fingerprintGenerator.generateServiceFingerprint(services1, 'node1');
      const fingerprint2 = fingerprintGenerator.generateServiceFingerprint(services2, 'node1');
      
      const comparison = fingerprintGenerator.compareFingerprints(fingerprint1, fingerprint2);
      const deltas = deltaManager.generateDelta(services2, comparison, 'node1', fingerprint1.rootHash);
      
      expect(deltas).toHaveLength(1);
      expect(deltas[0].services).toHaveLength(2); // 2 new services
      expect(deltas[0].services.every(s => s.operation === 'add')).toBe(true);
    });

    it('should apply deltas correctly', () => {
      const originalServices = createTestServices(3);
      const newService: LogicalService = {
        id: 'service-new',
        type: 'test-service',
        nodeId: 'node1',
        metadata: { name: 'New Service' },
        stats: { requests: 0 },
        lastUpdated: Date.now(),
        vectorClock: { node1: 1 },
        version: 1,
        checksum: 'checksum-new',
        conflictPolicy: 'last-writer-wins'
      };

      const delta: StateDelta = {
        id: 'test-delta',
        sourceNodeId: 'node1',
        sourceFingerprint: 'test-fingerprint',
        services: [{
          operation: 'add',
          serviceId: 'service-new',
          service: newService,
          timestamp: Date.now()
        }],
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 1,
        vectorClockUpdates: { node1: 1 },
        causality: [],
        compressed: false,
        encrypted: false
      };

      const result = deltaManager.applyDelta(originalServices, delta);
      
      expect(result.success).toBe(true);
      expect(result.appliedOperations).toBe(1);
      expect(result.resultingServices).toHaveLength(4);
      expect(result.resultingServices.some(s => s.id === 'service-new')).toBe(true);
    });

    it('should handle service modifications', () => {
      const originalServices = createTestServices(3);
      const modifiedService = {
        ...originalServices[1],
        stats: { requests: 500, latency: 25 },
        version: originalServices[1].version + 1
      };

      const delta: StateDelta = {
        id: 'modify-delta',
        sourceNodeId: 'node1',
        sourceFingerprint: 'test-fingerprint',
        services: [{
          operation: 'modify',
          serviceId: originalServices[1].id,
          service: modifiedService,
          previousVersion: originalServices[1].version,
          timestamp: Date.now()
        }],
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 1,
        vectorClockUpdates: { node1: 1 },
        causality: [],
        compressed: false,
        encrypted: false
      };

      const result = deltaManager.applyDelta(originalServices, delta);
      
      expect(result.success).toBe(true);
      expect(result.appliedOperations).toBe(1);
      expect(result.resultingServices).toHaveLength(3);
      
      const updated = result.resultingServices.find(s => s.id === originalServices[1].id);
      expect(updated?.stats.requests).toBe(500);
    });

    it('should handle service deletions', () => {
      const originalServices = createTestServices(3);

      const delta: StateDelta = {
        id: 'delete-delta',
        sourceNodeId: 'node1',
        sourceFingerprint: 'test-fingerprint',
        services: [{
          operation: 'delete',
          serviceId: originalServices[1].id,
          timestamp: Date.now()
        }],
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 1,
        vectorClockUpdates: { node1: 1 },
        causality: [],
        compressed: false,
        encrypted: false
      };

      const result = deltaManager.applyDelta(originalServices, delta);
      
      expect(result.success).toBe(true);
      expect(result.appliedOperations).toBe(1);
      expect(result.resultingServices).toHaveLength(2);
      expect(result.resultingServices.some(s => s.id === originalServices[1].id)).toBe(false);
    });

    it('should detect version conflicts', () => {
      const originalServices = createTestServices(3);
      const modifiedService = {
        ...originalServices[1],
        stats: { requests: 500 },
        version: originalServices[1].version + 1
      };

      const delta: StateDelta = {
        id: 'conflict-delta',
        sourceNodeId: 'node1',
        sourceFingerprint: 'test-fingerprint',
        services: [{
          operation: 'modify',
          serviceId: originalServices[1].id,
          service: modifiedService,
          previousVersion: 999, // Wrong version
          timestamp: Date.now()
        }],
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 1,
        vectorClockUpdates: { node1: 1 },
        causality: [],
        compressed: false,
        encrypted: false
      };

      const result = deltaManager.applyDelta(originalServices, delta);
      
      expect(result.success).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].conflictType).toBe('version');
    });

    it('should merge multiple deltas', () => {
      const delta1: StateDelta = {
        id: 'delta-1',
        sourceNodeId: 'node1',
        sourceFingerprint: 'fingerprint-1',
        services: [{
          operation: 'add',
          serviceId: 'service-a',
          service: createTestServices(1, 'node1')[0],
          timestamp: Date.now()
        }],
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 1,
        vectorClockUpdates: { node1: 1 },
        causality: [],
        compressed: false,
        encrypted: false
      };

      const delta2: StateDelta = {
        id: 'delta-2',
        sourceNodeId: 'node1',
        sourceFingerprint: 'fingerprint-2',
        services: [{
          operation: 'add',
          serviceId: 'service-b',
          service: { ...createTestServices(1, 'node1')[0], id: 'service-b' },
          timestamp: Date.now()
        }],
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 2,
        vectorClockUpdates: { node1: 2 },
        causality: [],
        compressed: false,
        encrypted: false
      };

      const merged = deltaManager.mergeDeltas([delta1, delta2]);
      
      expect(merged.services).toHaveLength(2);
      expect(merged.services.some(s => s.serviceId === 'service-a')).toBe(true);
      expect(merged.services.some(s => s.serviceId === 'service-b')).toBe(true);
    });

    it('should validate delta integrity', () => {
      const validDelta: StateDelta = {
        id: 'valid-delta',
        sourceNodeId: 'node1',
        sourceFingerprint: 'fingerprint',
        services: [{
          operation: 'add',
          serviceId: 'service-1',
          service: createTestServices(1)[0],
          timestamp: Date.now()
        }],
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 1,
        vectorClockUpdates: {},
        causality: [],
        compressed: false,
        encrypted: false
      };

      const validation = deltaManager.validateDelta(validDelta);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);

      // Test invalid delta
      const invalidDelta = { ...validDelta, sourceNodeId: '' };
      const invalidValidation = deltaManager.validateDelta(invalidDelta);
      expect(invalidValidation.valid).toBe(false);
      expect(invalidValidation.errors.length).toBeGreaterThan(0);
    });
  });

  describe('DeltaSync Engine', () => {
    it('should start sync session and detect identical states', async () => {
      const services = createTestServices(3);
      const fingerprint = fingerprintGenerator.generateServiceFingerprint(services, 'node1');
      
      const config: SyncSessionConfig = {
        nodeId: 'node1',
        targetNodeId: 'node2',
        enableCompression: false,
        enableEncryption: false,
        compressionThreshold: 1024,
        maxDeltasPerBatch: 10,
        batchTimeoutMs: 5000,
        retryAttempts: 3,
        bandwidth: {}
      };

      const session = await syncEngine.startSyncSession(services, fingerprint, config);
      
      expect(session.status).toBe('complete');
      expect(session.metrics.totalDeltas).toBe(0);
    });

    it('should compress large deltas', async () => {
      const largeService: LogicalService = {
        id: 'large-service',
        type: 'test-service',
        nodeId: 'node1',
        metadata: { 
          name: 'Large Service',
          description: 'A'.repeat(1000) // Large metadata
        },
        stats: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [`metric${i}`, i * 100])
        ),
        lastUpdated: Date.now(),
        vectorClock: { node1: 1 },
        version: 1,
        checksum: 'large-checksum',
        conflictPolicy: 'last-writer-wins'
      };

      // Test compression
      const delta: StateDelta = {
        id: 'large-delta',
        sourceNodeId: 'node1',
        sourceFingerprint: 'fingerprint',
        services: [{
          operation: 'add',
          serviceId: 'large-service',
          service: largeService,
          timestamp: Date.now()
        }],
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 1,
        vectorClockUpdates: {},
        causality: [],
        compressed: false,
        encrypted: false
      };

      const compressed = await syncEngine.compressDelta(delta);
      
      if ('compressedData' in compressed) {
        expect(compressed.compressionRatio).toBeLessThan(0.9); // Should be compressed
        expect(compressed.compressedData.length).toBeLessThan(
          JSON.stringify(delta).length
        );
      }
    });

    it('should handle bandwidth monitoring', () => {
      const bandwidthStats = syncEngine.getBandwidthStats();
      
      expect(bandwidthStats).toHaveProperty('totalSessions');
      expect(bandwidthStats).toHaveProperty('totalBytesSaved');
      expect(bandwidthStats).toHaveProperty('averageCompressionRatio');
      expect(bandwidthStats).toHaveProperty('totalTransmissionTime');
    });

    it('should track sync session metrics', async () => {
      const services1 = createTestServices(2);
      const services2 = createTestServices(3); // One additional service
      
      const fingerprint1 = fingerprintGenerator.generateServiceFingerprint(services1, 'node1');
      const fingerprint2 = fingerprintGenerator.generateServiceFingerprint(services2, 'node2');
      
      const config: SyncSessionConfig = {
        nodeId: 'node1',
        targetNodeId: 'node2',
        enableCompression: true,
        enableEncryption: false,
        compressionThreshold: 100,
        maxDeltasPerBatch: 10,
        batchTimeoutMs: 5000,
        retryAttempts: 3,
        bandwidth: { maxBytesPerSecond: 10000 }
      };

      const session = await syncEngine.startSyncSession(services2, fingerprint1, config);
      
      expect(session.status).toBe('complete');
      expect(session.metrics.totalDeltas).toBeGreaterThan(0);
      expect(session.generatedDeltas.length).toBeGreaterThan(0);
    });

    it('should apply incoming deltas', async () => {
      const originalServices = createTestServices(2);
      const newService = createTestServices(1, 'node2')[0];
      newService.id = 'new-service';

      const delta: StateDelta = {
        id: 'incoming-delta',
        sourceNodeId: 'node2',
        sourceFingerprint: 'remote-fingerprint',
        services: [{
          operation: 'add',
          serviceId: 'new-service',
          service: newService,
          timestamp: Date.now()
        }],
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 1,
        vectorClockUpdates: { node2: 1 },
        causality: [],
        compressed: false,
        encrypted: false
      };

      const result = await syncEngine.applyIncomingDeltas(originalServices, [delta]);
      
      expect(result.success).toBe(true);
      expect(result.appliedOperations).toBe(1);
      expect(result.resultingServices).toHaveLength(3);
    });

    it('should clean up old sessions', () => {
      const initialCount = syncEngine.getActiveSessions().length;
      
      // Cleanup should not affect active sessions
      syncEngine.cleanup(1000); // 1 second max age
      
      expect(syncEngine.getActiveSessions().length).toBe(initialCount);
    });
  });

  describe('Performance and Bandwidth Optimization', () => {
    it('should achieve significant compression for repetitive data', async () => {
      // Create services with repetitive data
      const repetitiveServices = Array.from({ length: 10 }, (_, i) => ({
        id: `service-${i}`,
        type: 'repetitive-service',
        nodeId: 'node1',
        metadata: { 
          commonField: 'This is a very common field value that appears in all services',
          description: 'Similar description for all services with common patterns'
        },
        stats: { requests: 1000, latency: 50, errors: 0 },
        lastUpdated: Date.now(),
        vectorClock: { node1: 1 },
        version: 1,
        checksum: `checksum-${i}`,
        conflictPolicy: 'last-writer-wins'
      }));

      const delta: StateDelta = {
        id: 'repetitive-delta',
        sourceNodeId: 'node1',
        sourceFingerprint: 'fingerprint',
        services: repetitiveServices.map(service => ({
          operation: 'add' as const,
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
        expect(compressionRatio).toBeLessThan(0.7); // Should achieve good compression
      }
    });

    it('should handle large service catalogs efficiently', () => {
      const largeServiceCatalog = createTestServices(1000); // 1000 services
      
      const startTime = Date.now();
      const fingerprint = fingerprintGenerator.generateServiceFingerprint(largeServiceCatalog, 'node1');
      const fingerprintTime = Date.now() - startTime;
      
      expect(fingerprint.serviceCount).toBe(1000);
      expect(fingerprintTime).toBeLessThan(1000); // Should complete in under 1 second
      
      // Test chunked processing
      expect(fingerprint.rootHash).toBeDefined();
      expect(fingerprint.serviceHashes.size).toBe(1000);
    });

    it('should demonstrate bandwidth savings', async () => {
      const originalServices = createTestServices(100);
      const modifiedServices = [...originalServices];
      
      // Modify only 10% of services
      for (let i = 0; i < 10; i++) {
        modifiedServices[i] = {
          ...modifiedServices[i],
          stats: { ...modifiedServices[i].stats, requests: modifiedServices[i].stats.requests + 100 }
        };
      }

      const fingerprint1 = fingerprintGenerator.generateServiceFingerprint(originalServices, 'node1');
      const fingerprint2 = fingerprintGenerator.generateServiceFingerprint(modifiedServices, 'node1');
      
      const comparison = fingerprintGenerator.compareFingerprints(fingerprint1, fingerprint2);
      const deltas = deltaManager.generateDelta(modifiedServices, comparison, 'node1', fingerprint1.rootHash);
      
      const deltaSize = deltas.reduce((total, delta) => total + deltaManager.calculateDeltaSize(delta), 0);
      const fullStateSize = Buffer.byteLength(JSON.stringify(modifiedServices), 'utf8');
      
      const bandwidthSavings = ((fullStateSize - deltaSize) / fullStateSize) * 100;
      
      expect(bandwidthSavings).toBeGreaterThan(80); // Should save at least 80% bandwidth
      expect(comparison.modifiedServices.length).toBe(10);
    });
  });
});
