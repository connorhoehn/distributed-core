import { ClusterManager } from '../../src/cluster/ClusterManager';
import { StateAggregator } from '../../src/cluster/aggregation/StateAggregator';
import { StateConflict } from '../../src/cluster/introspection/ClusterIntrospection';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';
import { BootstrapConfig } from '../../src/cluster/config/BootstrapConfig';

/**
 * Test anti-entropy conflict detection functionality
 */
describe('Anti-Entropy Conflict Detection', () => {
  let cluster1: ClusterManager;
  let cluster2: ClusterManager;
  let stateAggregator: StateAggregator;
  let transport1: InMemoryAdapter;
  let transport2: InMemoryAdapter;

  beforeEach(async () => {
    // Setup two cluster nodes for conflict testing
    const nodeId1 = 'test-node-1';
    const nodeId2 = 'test-node-2';
    
    transport1 = new InMemoryAdapter({ 
      id: nodeId1, 
      address: '127.0.0.1', 
      port: 8080 
    });
    
    transport2 = new InMemoryAdapter({ 
      id: nodeId2, 
      address: '127.0.0.1', 
      port: 8081 
    });
    
    const config1 = new BootstrapConfig([], 1000, 200, false);
    const config2 = new BootstrapConfig([], 1000, 200, false);
    
    cluster1 = new ClusterManager(nodeId1, transport1, config1);
    cluster2 = new ClusterManager(nodeId2, transport2, config2);
    
    // Setup state aggregator with conflict detection enabled
    stateAggregator = new StateAggregator(cluster1, {
      collectionTimeout: 2000,
      minQuorumSize: 1,
      aggregationInterval: 5000,
      enableConflictDetection: true,
      autoResolve: false,
      conflictDetectionInterval: 1000
    });
    
    await cluster1.start();
    await cluster2.start();
  });

  afterEach(async () => {
    try {
      // Clean up
      if (cluster1) {
        const introspection1 = cluster1.getIntrospection();
        if (introspection1 && typeof introspection1.destroy === 'function') {
          introspection1.destroy();
        }
      }
      
      if (cluster2) {
        const introspection2 = cluster2.getIntrospection();
        if (introspection2 && typeof introspection2.destroy === 'function') {
          introspection2.destroy();
        }
      }
      
      if (stateAggregator) {
        stateAggregator.stop();
      }
      
      if (cluster1) await cluster1.stop();
      if (cluster2) await cluster2.stop();
      if (transport1) await transport1.stop();
      if (transport2) await transport2.stop();
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Basic Conflict Detection', () => {
    it('should detect no conflicts when services are consistent', async () => {
      const introspection1 = cluster1.getIntrospection();
      
      // Register identical service on node 1
      introspection1.registerLogicalService({
        id: 'service-1',
        type: 'test-service',
        nodeId: cluster1.getNodeInfo().id,
        metadata: { name: 'Test Service' },
        stats: { count: 10 },
        lastUpdated: Date.now()
      });

      // Collect state and check for conflicts
      const aggregatedState = await stateAggregator.collectClusterState();
      const conflicts = await stateAggregator.detectConflicts(aggregatedState);
      
      expect(conflicts).toHaveLength(0);
    });

    it('should detect version conflicts between nodes', async () => {
      const introspection1 = cluster1.getIntrospection();
      
      // Register service on node 1
      introspection1.registerLogicalService({
        id: 'service-1',
        type: 'test-service',
        nodeId: cluster1.getNodeInfo().id,
        metadata: { name: 'Test Service' },
        stats: { count: 10 },
        lastUpdated: Date.now()
      });

      // Update the service to increment version
      introspection1.updateLogicalService('service-1', { count: 15 });
      
      // Manually create a conflicting service state (simulating what would come from another node)
      const conflictingState = {
        health: cluster2.getClusterHealth(),
        topology: cluster2.getTopology(),
        metadata: cluster2.getIntrospection().getMetadata(),
        performance: cluster2.getIntrospection().getPerformanceMetrics(),
        logicalServices: [{
          id: 'service-1',
          type: 'test-service',
          nodeId: cluster2.getNodeInfo().id,
          metadata: { name: 'Test Service' },
          stats: { count: 12 },
          lastUpdated: Date.now(),
          vectorClock: { [cluster2.getNodeInfo().id]: 1 },
          version: 1, // Different version
          checksum: 'different-checksum',
          conflictPolicy: 'last-writer-wins'
        }],
        lastUpdated: Date.now()
      };

      // Create aggregated state with both versions
      const nodeStates = new Map();
      nodeStates.set(cluster1.getNodeInfo().id, cluster1.getIntrospection().getCurrentState());
      nodeStates.set(cluster2.getNodeInfo().id, conflictingState);
      
      const aggregatedState = {
        clusterHealth: cluster1.getClusterHealth(),
        nodeStates,
        aggregatedServices: [],
        aggregatedMetrics: cluster1.getIntrospection().getPerformanceMetrics(),
        consistencyScore: 0.5,
        partitionInfo: {
          isPartitioned: false,
          partitionCount: 1,
          largestPartitionSize: 2,
          unreachableNodes: []
        },
        timestamp: Date.now()
      };

      const conflicts = await stateAggregator.detectConflicts(aggregatedState);
      
      expect(conflicts.length).toBeGreaterThan(0);
      const versionConflict = conflicts.find(c => c.conflictType === 'version');
      expect(versionConflict).toBeDefined();
      expect(versionConflict?.serviceId).toBe('service-1');
      expect(versionConflict?.nodes).toContain(cluster1.getNodeInfo().id);
      expect(versionConflict?.nodes).toContain(cluster2.getNodeInfo().id);
    });

    it('should detect stats conflicts when values differ significantly', async () => {
      const introspection1 = cluster1.getIntrospection();
      
      // Register service with initial stats
      introspection1.registerLogicalService({
        id: 'stats-service',
        type: 'counter-service',
        nodeId: cluster1.getNodeInfo().id,
        metadata: { name: 'Counter Service' },
        stats: { userCount: 100 },
        lastUpdated: Date.now()
      });

      // Create a conflicting state with significantly different stats
      const conflictingState = {
        health: cluster2.getClusterHealth(),
        topology: cluster2.getTopology(),
        metadata: cluster2.getIntrospection().getMetadata(),
        performance: cluster2.getIntrospection().getPerformanceMetrics(),
        logicalServices: [{
          id: 'stats-service',
          type: 'counter-service',
          nodeId: cluster2.getNodeInfo().id,
          metadata: { name: 'Counter Service' },
          stats: { userCount: 150 }, // 50% difference - should trigger conflict
          lastUpdated: Date.now(),
          vectorClock: { [cluster2.getNodeInfo().id]: 1 },
          version: 1,
          checksum: 'different-checksum',
          conflictPolicy: 'max-value'
        }],
        lastUpdated: Date.now()
      };

      const nodeStates = new Map();
      nodeStates.set(cluster1.getNodeInfo().id, cluster1.getIntrospection().getCurrentState());
      nodeStates.set(cluster2.getNodeInfo().id, conflictingState);
      
      const aggregatedState = {
        clusterHealth: cluster1.getClusterHealth(),
        nodeStates,
        aggregatedServices: [],
        aggregatedMetrics: cluster1.getIntrospection().getPerformanceMetrics(),
        consistencyScore: 0.5,
        partitionInfo: {
          isPartitioned: false,
          partitionCount: 1,
          largestPartitionSize: 2,
          unreachableNodes: []
        },
        timestamp: Date.now()
      };

      const conflicts = await stateAggregator.detectConflicts(aggregatedState);
      
      const statsConflict = conflicts.find(c => c.conflictType === 'stats' && c.serviceId.includes('userCount'));
      expect(statsConflict).toBeDefined();
      expect(statsConflict?.resolutionStrategy).toBe('max-value');
      expect(statsConflict?.severity).toBe('low');
    });

    it('should emit conflicts-detected event when conflicts are found', async () => {
      let detectedConflicts: StateConflict[] = [];
      
      stateAggregator.on('conflicts-detected', (conflicts: StateConflict[]) => {
        detectedConflicts = conflicts;
      });

      const introspection1 = cluster1.getIntrospection();
      
      // Register service
      introspection1.registerLogicalService({
        id: 'event-service',
        type: 'test-service',
        nodeId: cluster1.getNodeInfo().id,
        metadata: { name: 'Event Service' },
        stats: { count: 10 },
        lastUpdated: Date.now()
      });

      // Create conflicting state
      const conflictingState = {
        health: cluster2.getClusterHealth(),
        topology: cluster2.getTopology(),
        metadata: cluster2.getIntrospection().getMetadata(),
        performance: cluster2.getIntrospection().getPerformanceMetrics(),
        logicalServices: [{
          id: 'event-service',
          type: 'test-service',
          nodeId: cluster2.getNodeInfo().id,
          metadata: { name: 'Different Name' }, // Metadata conflict
          stats: { count: 10 },
          lastUpdated: Date.now(),
          vectorClock: { [cluster2.getNodeInfo().id]: 1 },
          version: 1,
          checksum: 'different-checksum'
        }],
        lastUpdated: Date.now()
      };

      const nodeStates = new Map();
      nodeStates.set(cluster1.getNodeInfo().id, cluster1.getIntrospection().getCurrentState());
      nodeStates.set(cluster2.getNodeInfo().id, conflictingState);
      
      const aggregatedState = {
        clusterHealth: cluster1.getClusterHealth(),
        nodeStates,
        aggregatedServices: [],
        aggregatedMetrics: cluster1.getIntrospection().getPerformanceMetrics(),
        consistencyScore: 0.5,
        partitionInfo: {
          isPartitioned: false,
          partitionCount: 1,
          largestPartitionSize: 2,
          unreachableNodes: []
        },
        timestamp: Date.now()
      };

      await stateAggregator.detectConflicts(aggregatedState);
      
      // Give a moment for event emission
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(detectedConflicts.length).toBeGreaterThan(0);
      const metadataConflict = detectedConflicts.find(c => c.conflictType === 'metadata');
      expect(metadataConflict).toBeDefined();
    });
  });

  describe('Configuration', () => {
    it('should not detect conflicts when conflict detection is disabled', async () => {
      // Disable conflict detection
      stateAggregator.configureConflictDetection({ enableConflictDetection: false });
      
      const introspection1 = cluster1.getIntrospection();
      
      introspection1.registerLogicalService({
        id: 'no-conflict-service',
        type: 'test-service',
        nodeId: cluster1.getNodeInfo().id,
        metadata: { name: 'Test Service' },
        stats: { count: 10 },
        lastUpdated: Date.now()
      });

      const conflicts = await stateAggregator.detectConflicts();
      expect(conflicts).toHaveLength(0);
    });

    it('should allow configuring conflict detection settings', () => {
      stateAggregator.configureConflictDetection({
        enableConflictDetection: true,
        autoResolve: true,
        conflictDetectionInterval: 30000
      });
      
      // Access private config for testing
      const config = (stateAggregator as any).config;
      expect(config.enableConflictDetection).toBe(true);
      expect(config.autoResolve).toBe(true);
      expect(config.conflictDetectionInterval).toBe(30000);
    });
  });
});
