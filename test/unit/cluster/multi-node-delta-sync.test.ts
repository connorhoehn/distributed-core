/**
 * Multi-Node Delta Synchronization Integration Test
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

describe('Multi-Node Delta Synchronization', () => {
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

  it('should synchronize services between two nodes using delta sync', async () => {
    // Setup: Create two nodes with different service types
    const nodeAServices = createServices(3, 'node-a', 'web-server');
    const nodeBServices = createServices(2, 'node-b', 'database');

    // Silent operation - no logging in tests

    // Step 1: Generate fingerprints for both nodes
    const fingerprintA = fingerprintGenerator.generateServiceFingerprint(nodeAServices, 'node-a');
    const fingerprintB = fingerprintGenerator.generateServiceFingerprint(nodeBServices, 'node-b');

    expect(fingerprintA.serviceCount).toBe(3);
    expect(fingerprintB.serviceCount).toBe(2);

    // Step 2: Detect differences between nodes
    const comparison = fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
    
    expect(comparison.identical).toBe(false);
    expect(comparison.addedServices.length).toBe(2); // Node B's 2 services are new to Node A

    // Step 3: Generate delta from Node B to Node A
    const deltasFromB = deltaManager.generateDelta(nodeBServices, comparison, 'node-b', fingerprintA.rootHash);
    
    expect(deltasFromB.length).toBeGreaterThan(0);
    expect(deltasFromB[0].services.length).toBe(5); // All services are included in the delta

    // Step 4: Apply delta to Node A (simulating network sync)
    const syncResult = deltaManager.applyDelta(nodeAServices, deltasFromB[0]);
    
    expect(syncResult.success).toBe(true);
    expect(syncResult.appliedOperations).toBe(5); // All services in the delta
    expect(syncResult.resultingServices).toHaveLength(2); // Only the 2 new services from B

    // Step 5: Verify the new services were added correctly
    const mergedServices = [...nodeAServices, ...syncResult.resultingServices];
    const webServers = mergedServices.filter(s => s.type === 'web-server');
    const databases = mergedServices.filter(s => s.type === 'database');
    
    expect(webServers).toHaveLength(3);
    expect(databases).toHaveLength(2);

    // Step 6: Calculate bandwidth efficiency
    const deltaSize = deltasFromB.reduce((total, delta) => total + deltaManager.calculateDeltaSize(delta), 0);
    const fullStateSize = Buffer.byteLength(JSON.stringify([...nodeAServices, ...nodeBServices]), 'utf8');
    const bandwidthSavings = ((fullStateSize - deltaSize) / fullStateSize) * 100;

    // Silent operation - no logging in tests
    
    // Delta should be more efficient than sending full state
    expect(deltaSize).toBeLessThan(fullStateSize);

    // Test completed successfully - no logging needed
  });

  it('should handle service updates between synchronized nodes', async () => {
    // Setup: Both nodes start with same services
    const sharedServices = createServices(2, 'shared', 'api-server');
    const nodeAServices = [...sharedServices, ...createServices(1, 'node-a', 'web-server')];
    const nodeBServices = [...sharedServices];

    // Node B updates one of the shared services
    const updatedService = {
      ...nodeBServices[0],
      metadata: { ...nodeBServices[0].metadata, version: '1.1.0' },
      version: nodeBServices[0].version + 1,
      lastUpdated: Date.now(),
      vectorClock: { ...nodeBServices[0].vectorClock, 'shared': 2 }
    };
    nodeBServices[0] = updatedService;

    // Detect and sync the update
    const fingerprintA = fingerprintGenerator.generateServiceFingerprint(nodeAServices, 'node-a');
    const fingerprintB = fingerprintGenerator.generateServiceFingerprint(nodeBServices, 'node-b');
    
    const comparison = fingerprintGenerator.compareFingerprints(fingerprintA, fingerprintB);
    expect(comparison.modifiedServices.length).toBe(1);

    const deltasFromB = deltaManager.generateDelta(nodeBServices, comparison, 'node-b', fingerprintA.rootHash);
    const syncResult = deltaManager.applyDelta(nodeAServices, deltasFromB[0]);

    expect(syncResult.success).toBe(true);
    expect(syncResult.appliedOperations).toBe(2); // 1 modify + 1 missing service from node B

    // Verify the service was updated
    const updatedServiceInA = syncResult.resultingServices.find(s => s.id === updatedService.id);
    expect(updatedServiceInA?.metadata.version).toBe('1.1.0');

    // Test completed successfully - no logging needed
  });
});
