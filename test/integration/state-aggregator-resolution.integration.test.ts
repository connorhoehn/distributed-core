/**
 * Integration tests for StateAggregator with conflict resolution
 */

import { StateAggregator, StateAggregatorConfig } from '../../src/cluster/aggregation/StateAggregator';
import { ClusterManager } from '../../src/cluster/ClusterManager';
import { createTestCluster } from '../harnesses/create-test-cluster';
import { ClusterTestHarness } from '../harnesses/cluster-coordination-harness';

describe('StateAggregator Conflict Resolution Integration', () => {
  let harness: ClusterTestHarness;
  let nodes: ClusterManager[];
  let aggregator: StateAggregator;

  beforeEach(async () => {
    harness = new ClusterTestHarness();
    nodes = await harness.createMultiNodeCluster(3);
    
    // Use the first node's aggregator with resolution enabled
    aggregator = new StateAggregator(nodes[0], {
      enableConflictDetection: true,
      enableResolution: true,
      autoResolve: false, // Manual resolution for testing
      collectionTimeout: 1000
    });
    
    await harness.waitForStabilization();
  });

  afterEach(async () => {
    if (aggregator) {
      aggregator.stop();
    }
    if (harness) {
      await harness.cleanup();
    }
  });

  describe('Conflict Detection and Resolution Integration', () => {
    it('should detect and resolve version conflicts across nodes', async () => {
      // Register services with conflicting versions on different nodes
      const serviceBase = {
        id: 'distributed-game-1',
        type: 'game-session',
        metadata: { gameType: 'poker', maxPlayers: 6 },
        stats: { playerCount: 4, handsPlayed: 25 },
        lastUpdated: Date.now()
      };

      // Register with different versions on each node
      nodes[0].getIntrospection().registerLogicalService({
        ...serviceBase,
        nodeId: nodes[0].getNodeInfo().id,
        version: 5
      });

      nodes[1].getIntrospection().registerLogicalService({
        ...serviceBase,
        nodeId: nodes[1].getNodeInfo().id,
        version: 7
      });

      nodes[2].getIntrospection().registerLogicalService({
        ...serviceBase,
        nodeId: nodes[2].getNodeInfo().id,
        version: 6
      });

      // Collect cluster state to trigger conflict detection
      const aggregatedState = await aggregator.collectClusterState();
      const conflicts = await aggregator.detectConflicts(aggregatedState);

      expect(conflicts.length).toBeGreaterThan(0);
      
      // Find version conflict
      const versionConflict = conflicts.find(c => c.conflictType === 'version');
      expect(versionConflict).toBeDefined();
      expect(versionConflict!.nodes).toHaveLength(3);

      // Preview resolution
      const previews = aggregator.previewConflictResolution([versionConflict!]);
      expect(previews).toHaveLength(1);
      expect(previews[0].strategy).toBe('max-value');
      expect(previews[0].proposedValue).toBe(7); // Highest version

      // Manually resolve the conflict
      const resolutionResult = await aggregator.manualResolveConflict(versionConflict!, 'max-value');
      
      expect(resolutionResult.strategy).toBe('max-value');
      expect(resolutionResult.resolvedValue).toBe(7);
      expect(resolutionResult.confidence).toBeGreaterThan(0.5);
    });

    it('should handle auto-resolution when enabled', async () => {
      // Reconfigure for auto-resolution
      aggregator.configureConflictDetection({
        autoResolve: true,
        enableResolution: true
      });

      let resolvedConflicts: any[] = [];
      aggregator.on('conflicts-resolved', (results) => {
        resolvedConflicts.push(...results);
      });

      // Create conflicting services
      const baseService = {
        id: 'auto-resolve-test',
        type: 'chat-room',
        metadata: { roomName: 'General', isPublic: true },
        stats: { messageCount: 100, activeUsers: 15 },
        lastUpdated: Date.now()
      };

      // Register with different stats on different nodes
      nodes[0].getIntrospection().registerLogicalService({
        ...baseService,
        nodeId: nodes[0].getNodeInfo().id,
        stats: { messageCount: 100, activeUsers: 15 }
      });

      nodes[1].getIntrospection().registerLogicalService({
        ...baseService,
        nodeId: nodes[1].getNodeInfo().id,
        stats: { messageCount: 120, activeUsers: 18 }
      });

      // Trigger conflict detection and auto-resolution
      await aggregator.collectClusterState();

      // Wait for auto-resolution to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(resolvedConflicts.length).toBeGreaterThan(0);
      
      // Verify stats were resolved to max values
      const statsResolution = resolvedConflicts.find(r => r.conflictId.includes('messageCount'));
      if (statsResolution) {
        expect(statsResolution.resolvedValue).toBe(120); // Max message count
      }
    });

    it('should handle resolution errors gracefully', async () => {
      let resolutionErrors: any[] = [];
      aggregator.on('manual-resolution-failed', (error) => {
        resolutionErrors.push(error);
      });

      // Try to resolve with invalid strategy
      const mockConflict = {
        serviceId: 'test-service',
        conflictType: 'version' as any,
        nodes: ['node-1', 'node-2'],
        values: new Map([['node-1', 1], ['node-2', 2]]),
        resolutionStrategy: 'max-value' as any,
        severity: 'medium' as any
      };

      await expect(aggregator.manualResolveConflict(mockConflict, 'invalid-strategy'))
        .rejects.toThrow();

      expect(resolutionErrors.length).toBeGreaterThan(0);
    });

    it('should maintain resolution history for auditing', async () => {
      // Configure for resolution
      aggregator.configureConflictDetection({
        enableResolution: true
      });

      // Create and resolve a conflict
      const mockConflict = {
        serviceId: 'audit-test',
        conflictType: 'version' as any,
        nodes: ['node-1', 'node-2'],
        values: new Map([['node-1', 3], ['node-2', 5]]),
        resolutionStrategy: 'max-value' as any,
        severity: 'low' as any
      };

      await aggregator.manualResolveConflict(mockConflict, 'max-value');

      // Check resolution history
      const history = aggregator.getResolutionHistory();
      expect(history.length).toBeGreaterThan(0);
      
      const lastResolution = history[history.length - 1];
      expect(lastResolution.conflictId).toBe('audit-test-version');
      expect(lastResolution.strategy).toBe('max-value');
      expect(lastResolution.resolvedValue).toBe(5);
      expect(lastResolution.metadata).toBeDefined();
    });

    it('should integrate with reconciler configuration', async () => {
      const reconciler = aggregator.getReconciler();
      
      // Configure field-specific strategies
      reconciler.configureFieldStrategy('stats.*', 'average');
      reconciler.configureFieldStrategy('metadata.priority', 'max-value');

      // Add custom resolver
      reconciler.addCustomResolver('test-custom', (values) => {
        return 'custom-resolved-value';
      });

      // Test field strategy application
      const statsConflict = {
        serviceId: 'config-test.stats.playerCount',
        conflictType: 'stats' as any,
        nodes: ['node-1', 'node-2'],
        values: new Map([['node-1', 10], ['node-2', 20]]),
        resolutionStrategy: 'max-value' as any,
        severity: 'low' as any
      };

      const preview = aggregator.previewConflictResolution([statsConflict]);
      expect(preview[0].strategy).toBe('average');
      expect(preview[0].proposedValue).toBe(15); // Average of 10 and 20
    });
  });

  describe('Event-Driven Resolution Workflow', () => {
    it('should emit proper events during resolution lifecycle', async () => {
      const events: string[] = [];
      
      aggregator.on('conflicts-detected', () => events.push('conflicts-detected'));
      aggregator.on('conflicts-resolved', () => events.push('conflicts-resolved'));
      aggregator.on('manual-resolution', () => events.push('manual-resolution'));

      // Configure for resolution
      aggregator.configureConflictDetection({
        enableResolution: true
      });

      // Create conflicting services that will trigger detection
      const service1 = {
        id: 'event-test',
        type: 'test-service',
        nodeId: nodes[0].getNodeInfo().id,
        metadata: { version: 'v1' },
        stats: { count: 5 },
        lastUpdated: Date.now()
      };

      const service2 = {
        ...service1,
        nodeId: nodes[1].getNodeInfo().id,
        stats: { count: 8 }
      };

      nodes[0].getIntrospection().registerLogicalService(service1);
      nodes[1].getIntrospection().registerLogicalService(service2);

      // Trigger conflict detection
      const state = await aggregator.collectClusterState();
      const conflicts = await aggregator.detectConflicts(state);

      expect(events).toContain('conflicts-detected');

      // Manually resolve a conflict
      if (conflicts.length > 0) {
        await aggregator.manualResolveConflict(conflicts[0], 'max-value');
        expect(events).toContain('manual-resolution');
      }
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle large number of conflicts efficiently', async () => {
      // Configure for high-throughput resolution
      aggregator.configureConflictDetection({
        enableResolution: true,
        resolutionTimeout: 5000
      });

      // Create multiple conflicting services
      const conflictCount = 20;
      for (let i = 0; i < conflictCount; i++) {
        const baseService = {
          id: `perf-test-${i}`,
          type: 'performance-test',
          metadata: { testIndex: i },
          stats: { value: i * 10 },
          lastUpdated: Date.now()
        };

        // Register on multiple nodes with different values
        nodes[0].getIntrospection().registerLogicalService({
          ...baseService,
          nodeId: nodes[0].getNodeInfo().id,
          stats: { value: i * 10 }
        });

        nodes[1].getIntrospection().registerLogicalService({
          ...baseService,
          nodeId: nodes[1].getNodeInfo().id,
          stats: { value: i * 15 } // Different value to create conflict
        });
      }

      const startTime = Date.now();
      
      // Detect and resolve all conflicts
      const state = await aggregator.collectClusterState();
      const conflicts = await aggregator.detectConflicts(state);
      const results = await aggregator.resolveConflicts(conflicts, state);
      
      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(conflicts.length).toBeGreaterThan(0);
      expect(results.length).toBeGreaterThan(0);
      expect(duration).toBeLessThan(3000); // Should complete within 3 seconds
    });
  });
});
