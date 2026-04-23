/**
 * Integration tests for StateAggregator with conflict resolution
 */

import { StateAggregator, AggregatedClusterState } from '../../../src/cluster/aggregation/StateAggregator';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { createTestCluster } from '../../harnesses/create-test-cluster';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { TestConfig } from '../../support/test-config';

jest.setTimeout(15000);

/**
 * Poll until a synchronous condition becomes true or the deadline is reached.
 */
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 50));
  }
}

/**
 * Poll collectClusterState() until it returns a result with at least `minNodes`
 * node states, or throw when the deadline is exceeded.
 */
async function waitForAggregatedState(
  agg: StateAggregator,
  minNodes: number,
  ms = 8000
): Promise<AggregatedClusterState> {
  const deadline = Date.now() + ms;
  let last: AggregatedClusterState | undefined;
  while (true) {
    last = await agg.collectClusterState();
    if (last.nodeStates.size >= minNodes) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForAggregatedState timed out: got ${last.nodeStates.size} nodes, wanted ${minNodes}`
      );
    }
    await new Promise(r => setTimeout(r, 50));
  }
}

describe('StateAggregator Conflict Resolution Integration', () => {
  let cluster: any;
  let nodes: ClusterManager[];
  // One aggregator per node — every node must be able to respond to CLUSTER_STATE_REQUEST.
  // Without this, only nodes[0] has a message handler registered and remote collections
  // silently time out, making nodeStates.size stay at 1.
  let aggregators: StateAggregator[];
  // The aggregator on nodes[0] is used to drive all test assertions
  let aggregator: StateAggregator;
  const config = TestConfig.integration;

  beforeEach(async () => {
    // Clear the in-memory adapter registry to avoid stale connections
    InMemoryAdapter.clearRegistry();

    cluster = createTestCluster({ size: 3, enableLogging: false, testType: 'integration' });
    await cluster.start();
    nodes = cluster.nodes;

    aggregators = nodes.map(node =>
      new StateAggregator(node, {
        enableConflictDetection: true,
        enableResolution: true,
        autoResolve: false,
        collectionTimeout: config.cluster.joinTimeout
      })
    );
    aggregator = aggregators[0];

    // Wait until at least two nodes see each other in their membership tables
    await waitFor(
      () => nodes[0].getMemberCount() >= 2 && nodes[1].getMemberCount() >= 2,
      8000
    );
  });

  afterEach(async () => {
    for (const agg of aggregators) {
      agg.stop();
    }
    if (cluster) {
      await cluster.stop();
    }
  });

  describe('Conflict Detection and Resolution Integration', () => {
    it('should detect and resolve version conflicts across nodes', async () => {
      // Register the same logical service ID on each node, then apply different numbers
      // of updates so the version field genuinely diverges across nodes:
      //   nodes[0]: register (v1) + 1 update  → version 2
      //   nodes[1]: register (v1) + 3 updates → version 4
      //   nodes[2]: register (v1) + 6 updates → version 7  ← max, used in resolution assertions
      nodes[0].getIntrospection().registerLogicalService({
        id: 'distributed-game-1',
        type: 'game-session',
        nodeId: nodes[0].getNodeInfo().id,
        metadata: { gameType: 'poker', maxPlayers: 6 },
        stats: { playerCount: 10, handsPlayed: 100, wins: 50 },
        lastUpdated: Date.now() - 3000,
        conflictPolicy: 'last-writer-wins'
      });
      // 1 update → version 2
      nodes[0].getIntrospection().updateLogicalService('distributed-game-1', { playerCount: 10 });

      nodes[1].getIntrospection().registerLogicalService({
        id: 'distributed-game-1',
        type: 'game-session',
        nodeId: nodes[1].getNodeInfo().id,
        metadata: { gameType: 'poker', maxPlayers: 6 },
        stats: { playerCount: 50, handsPlayed: 500, wins: 250 },
        lastUpdated: Date.now() - 2000,
        conflictPolicy: 'last-writer-wins'
      });
      // 3 updates → version 4
      for (let u = 0; u < 3; u++) {
        nodes[1].getIntrospection().updateLogicalService('distributed-game-1', { playerCount: 50 + u });
      }

      nodes[2].getIntrospection().registerLogicalService({
        id: 'distributed-game-1',
        type: 'game-session',
        nodeId: nodes[2].getNodeInfo().id,
        metadata: { gameType: 'poker', maxPlayers: 6 },
        stats: { playerCount: 100, handsPlayed: 1000, wins: 500 },
        lastUpdated: Date.now() - 1000,
        conflictPolicy: 'last-writer-wins'
      });
      // 6 updates → version 7 (max; used in resolution assertions below)
      for (let u = 0; u < 6; u++) {
        nodes[2].getIntrospection().updateLogicalService('distributed-game-1', { playerCount: 100 + u });
      }

      // Poll until aggregated state contains data from at least 2 nodes
      const aggregatedState = await waitForAggregatedState(aggregator, 2);

      // Hard assertion — the multi-node path must actually execute
      expect(aggregatedState.nodeStates.size).toBeGreaterThanOrEqual(2);

      // Each collected node must have the service registered on it
      for (const [, nodeState] of aggregatedState.nodeStates) {
        const service = nodeState.logicalServices.find(s => s.id === 'distributed-game-1');
        expect(service).toBeDefined();
      }

      const conflicts = await aggregator.detectConflicts(aggregatedState);
      expect(conflicts.length).toBeGreaterThan(0);

      // Find version conflict
      const versionConflict = conflicts.find(c => c.conflictType === 'version');
      expect(versionConflict).toBeDefined();
      expect(versionConflict!.nodes.length).toBeGreaterThanOrEqual(2);

      // Preview resolution
      const previews = aggregator.previewConflictResolution([versionConflict!]);
      expect(previews).toHaveLength(1);
      expect(previews[0].strategy).toBe('max-value');
      expect(previews[0].proposedValue).toBe(7); // Highest version

      // Manually resolve the conflict
      const resolutionResult = await aggregator.manualResolveConflict(versionConflict!, 'max-value');

      expect(resolutionResult.strategy).toBe('max-value');
      expect(resolutionResult.resolvedValue).toBe(7);
      // Confidence is bounded to [0.1, 1.0] by the reconciler; when all node versions are
      // unique the similarity term is 0 and the floor of 0.1 applies.
      expect(resolutionResult.confidence).toBeGreaterThanOrEqual(0.1);
    });

    it('should handle auto-resolution when enabled', async () => {
      // Reconfigure nodes[0]'s aggregator for auto-resolution
      aggregator.configureConflictDetection({
        autoResolve: true,
        enableResolution: true
      });

      let resolvedConflicts: any[] = [];
      aggregator.on('conflicts-resolved', (results) => {
        resolvedConflicts.push(...results);
      });

      // Register services with different stats on two nodes to create detectable conflicts
      const baseService = {
        id: 'auto-resolve-test',
        type: 'chat-room',
        metadata: { roomName: 'General', isPublic: true },
        stats: { messageCount: 100, activeUsers: 15 },
        lastUpdated: Date.now()
      };

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

      // Poll until we have at least 2 node states; collectClusterState() triggers auto-resolve
      const state = await waitForAggregatedState(aggregator, 2);

      // Hard assertion — the multi-node path must actually execute
      expect(state.nodeStates.size).toBeGreaterThanOrEqual(2);

      // Wait for auto-resolution to fire (driven by the collectClusterState() call above)
      await waitFor(() => resolvedConflicts.length > 0, 5000);

      expect(resolvedConflicts.length).toBeGreaterThan(0);

      // Verify stats were resolved to max values
      const statsResolution = resolvedConflicts.find((r: any) => r.conflictId.includes('messageCount'));
      if (statsResolution) {
        expect(statsResolution.resolvedValue).toBe(120); // Max message count
      }
    });

    it('should handle resolution errors gracefully', async () => {
      let resolutionErrors: any[] = [];
      aggregator.on('manual-resolution-failed', (error) => {
        resolutionErrors.push(error);
      });

      // Try to resolve with an invalid strategy
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

      // Create and resolve a conflict using two real values
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
      reconciler.addCustomResolver('test-custom', (_values: any) => {
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

      // Register conflicting services on two live nodes
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

      // Poll until aggregated state has at least 2 node states
      const state = await waitForAggregatedState(aggregator, 2);

      // Hard assertion — the multi-node path must actually execute
      expect(state.nodeStates.size).toBeGreaterThanOrEqual(2);

      const conflicts = await aggregator.detectConflicts(state);
      expect(events).toContain('conflicts-detected');

      // Manually resolve a conflict if one exists
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
        resolutionTimeout: config.cluster.joinTimeout
      });

      // Register 20 conflicting services across two nodes
      const conflictCount = 20;
      for (let i = 0; i < conflictCount; i++) {
        const baseService = {
          id: `perf-test-${i}`,
          type: 'performance-test',
          metadata: { testIndex: i },
          stats: { value: i * 10 },
          lastUpdated: Date.now()
        };

        nodes[0].getIntrospection().registerLogicalService({
          ...baseService,
          nodeId: nodes[0].getNodeInfo().id,
          stats: { value: i * 10 }
        });

        nodes[1].getIntrospection().registerLogicalService({
          ...baseService,
          nodeId: nodes[1].getNodeInfo().id,
          stats: { value: i * 15 } // Different value to create a conflict
        });
      }

      // Poll until aggregated state has at least 2 node states
      const state = await waitForAggregatedState(aggregator, 2);

      // Hard assertion — the multi-node path must actually execute
      expect(state.nodeStates.size).toBeGreaterThanOrEqual(2);

      const startTime = Date.now();

      // Detect and resolve all conflicts
      const conflicts = await aggregator.detectConflicts(state);
      const results = await aggregator.resolveConflicts(conflicts, state);

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(conflicts.length).toBeGreaterThan(0);
      expect(results.length).toBeGreaterThan(0);
      expect(duration).toBeLessThan(config.timeouts.test / 2);
    });
  });
});
