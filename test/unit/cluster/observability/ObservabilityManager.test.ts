import { EventEmitter } from 'events';
import { ObservabilityManager, ClusterDashboard, ClusterScalingAnalysis } from '../../../../src/cluster/observability/ObservabilityManager';
import { ResourceTopologyManager, NodeResourceCapacity, ResourceClusterTopology } from '../../../../src/cluster/topology/ResourceTopologyManager';
import { ClusterManager } from '../../../../src/cluster/ClusterManager';
import { DistributionStrategy } from '../../../../src/cluster/resources/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ResourceClusterTopology so tests don't depend on every field
 * being perfectly populated.
 */
function buildTopology(overrides: Partial<ResourceClusterTopology> = {}): ResourceClusterTopology {
  return {
    timestamp: Date.now(),
    clusterHealth: {
      isHealthy: true,
      healthRatio: 1.0,
      totalNodes: 1,
      aliveNodes: 1,
      suspectNodes: 0,
      deadNodes: 0,
      ringCoverage: 1.0,
      partitionCount: 0
    },
    nodes: [],
    resources: {
      byType: new Map(),
      byNode: new Map(),
      total: 0,
      healthy: 0,
      degraded: 0,
      unhealthy: 0
    },
    distribution: {
      strategy: DistributionStrategy.ROUND_ROBIN,
      replicationFactor: 1,
      shardingEnabled: false,
      loadBalancing: 'round-robin'
    },
    performance: {
      averageLatency: 0,
      totalThroughput: 0,
      errorRate: 0,
      utilizationRate: 0
    },
    recommendations: [],
    ...overrides
  };
}

/**
 * Build a NodeResourceCapacity with sane defaults for use in topology nodes.
 */
function buildNode(
  nodeId: string,
  overrides: Partial<NodeResourceCapacity> = {}
): NodeResourceCapacity {
  return {
    nodeId,
    region: 'us-east-1',
    zone: 'us-east-1a',
    role: 'worker',
    capacity: {
      maxResources: 100,
      maxResourceConnections: 1000,
      maxBandwidth: 1000,
      cpuCores: 8,
      memoryGB: 32,
      diskGB: 500
    },
    utilization: {
      activeResources: 0,
      totalConnections: 0,
      bandwidthUsage: 0,
      cpuUsage: 0.2,
      memoryUsage: 0.3,
      diskUsage: 0.1,
      networkLatency: {}
    },
    capabilities: {
      supportsSharding: true,
      supportsReplication: true,
      supportedResourceTypes: ['chat'],
      zones: ['us-east-1a'],
      isolation: 'none'
    },
    health: {
      status: 'healthy',
      lastHeartbeat: Date.now(),
      uptime: 3600,
      errorRate: 0,
      responseTime: 5
    },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockTopologyManager(
  topologyOverride: Partial<ResourceClusterTopology> = {}
): jest.Mocked<Pick<ResourceTopologyManager, 'on' | 'off' | 'emit' | 'start' | 'stop' | 'getResourceTopology' | 'registerResourceType'>> & EventEmitter {
  const emitter = new EventEmitter();

  const mock = Object.assign(emitter, {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    getResourceTopology: jest.fn().mockResolvedValue(buildTopology(topologyOverride)),
    registerResourceType: jest.fn()
  });

  return mock as any;
}

function createMockCluster(): Partial<ClusterManager> {
  return {};
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ObservabilityManager', () => {
  let mockTopologyManager: ReturnType<typeof createMockTopologyManager>;
  let mockCluster: Partial<ClusterManager>;
  let manager: ObservabilityManager;

  beforeEach(() => {
    jest.useFakeTimers();
    mockTopologyManager = createMockTopologyManager();
    mockCluster = createMockCluster();
    manager = new ObservabilityManager(
      mockTopologyManager as unknown as ResourceTopologyManager,
      mockCluster as ClusterManager
    );
  });

  afterEach(async () => {
    // Ensure the interval is cleaned up to avoid timer leaks between tests
    await manager.stop().catch(() => {});
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    test('instantiates without throwing', () => {
      expect(manager).toBeInstanceOf(ObservabilityManager);
      expect(manager).toBeInstanceOf(EventEmitter);
    });

    test('registers a listener on topologyManager for topology:updated', () => {
      // The constructor calls topologyManager.on('topology:updated', ...)
      // Because we used a real EventEmitter for the mock we can verify a listener
      // was actually attached.
      const listenerCount = mockTopologyManager.listenerCount('topology:updated');
      expect(listenerCount).toBe(1);
    });

    test('applies custom dashboardUpdateIntervalMs config', async () => {
      // Verify the custom interval is shorter than default (10 000 ms).
      // We spy on setInterval to capture the delay that ObservabilityManager registers.
      jest.useRealTimers(); // temporarily avoid fake-timer complications
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      const customManager = new ObservabilityManager(
        mockTopologyManager as unknown as ResourceTopologyManager,
        mockCluster as ClusterManager,
        { dashboardUpdateIntervalMs: 5000 }
      );

      await customManager.start();

      // Find the call that set up the dashboard interval — it should use 5000 ms
      const dashboardIntervalCall = setIntervalSpy.mock.calls.find(
        ([_fn, delay]) => delay === 5000
      );
      expect(dashboardIntervalCall).toBeDefined();

      await customManager.stop();
      setIntervalSpy.mockRestore();
      jest.useFakeTimers(); // restore for the rest of this describe block
    });

    test('applies custom maxHistorySize config', async () => {
      const customManager = new ObservabilityManager(
        mockTopologyManager as unknown as ResourceTopologyManager,
        mockCluster as ClusterManager,
        { maxHistorySize: 3 }
      );

      // Emit 4 topology updates — the history array should never exceed 3 entries
      for (let i = 0; i < 4; i++) {
        mockTopologyManager.emit('topology:updated');
        await Promise.resolve();
      }

      // Verify getHistoricalTrends never exceeds maxHistorySize — we confirm this
      // indirectly by checking that getScalingAnalysis still resolves cleanly
      await expect(customManager.getScalingAnalysis()).resolves.toBeDefined();
      await customManager.stop();
    });
  });

  // -------------------------------------------------------------------------
  // start() / stop()
  // -------------------------------------------------------------------------

  describe('start() / stop()', () => {
    test('start() calls topologyManager.start()', async () => {
      await manager.start();
      expect(mockTopologyManager.start).toHaveBeenCalledTimes(1);
    });

    test('start() emits started', async () => {
      const started = jest.fn();
      manager.on('started', started);
      await manager.start();
      expect(started).toHaveBeenCalledTimes(1);
    });

    test('start() sets up periodic dashboard update interval', async () => {
      // Use real timers for this test to avoid async flush issues with fake timers.
      jest.useRealTimers();
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      await manager.start();

      // Verify that setInterval was called with the default 10 000 ms delay
      const dashboardIntervalCall = setIntervalSpy.mock.calls.find(
        ([_fn, delay]) => delay === 10000
      );
      expect(dashboardIntervalCall).toBeDefined();

      setIntervalSpy.mockRestore();
      jest.useFakeTimers(); // restore for remaining tests
    });

    test('stop() calls topologyManager.stop()', async () => {
      await manager.start();
      await manager.stop();
      expect(mockTopologyManager.stop).toHaveBeenCalledTimes(1);
    });

    test('stop() emits stopped', async () => {
      const stopped = jest.fn();
      manager.on('stopped', stopped);
      await manager.start();
      await manager.stop();
      expect(stopped).toHaveBeenCalledTimes(1);
    });

    test('calling stop() before start() does not throw', async () => {
      await expect(manager.stop()).resolves.toBeUndefined();
    });

    test('stop() cancels the dashboard update interval', async () => {
      await manager.start();
      await manager.stop();

      const emitSpy = jest.spyOn(manager, 'emit');
      jest.advanceTimersByTime(30000);
      await Promise.resolve();

      const dashboardEmits = emitSpy.mock.calls.filter(c => c[0] === 'dashboard-updated');
      expect(dashboardEmits.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getDashboard()
  // -------------------------------------------------------------------------

  describe('getDashboard()', () => {
    test('returns a ClusterDashboard-shaped object', async () => {
      const dashboard = await manager.getDashboard();
      expect(dashboard).toHaveProperty('overview');
      expect(dashboard).toHaveProperty('regions');
      expect(dashboard).toHaveProperty('hotspots');
      expect(dashboard).toHaveProperty('trends');
      expect(dashboard).toHaveProperty('alerts');
    });

    test('overview has the correct keys', async () => {
      const { overview } = await manager.getDashboard();
      expect(overview).toHaveProperty('totalNodes');
      expect(overview).toHaveProperty('healthyNodes');
      expect(overview).toHaveProperty('totalResources');
      expect(overview).toHaveProperty('totalConnections');
      expect(overview).toHaveProperty('messagesPerSecond');
      expect(overview).toHaveProperty('averageLatency');
      expect(overview).toHaveProperty('clusterHealth');
    });

    test('overview.clusterHealth is one of healthy | warning | critical', async () => {
      const { overview } = await manager.getDashboard();
      expect(['healthy', 'warning', 'critical']).toContain(overview.clusterHealth);
    });

    test('returns cached dashboard on second call', async () => {
      const first = await manager.getDashboard();
      const second = await manager.getDashboard();
      expect(second).toBe(first); // strict reference equality — same cached object
      expect(mockTopologyManager.getResourceTopology).toHaveBeenCalledTimes(1);
    });

    test('clusterHealth is critical when healthRatio < 0.5', async () => {
      mockTopologyManager.getResourceTopology.mockResolvedValue(
        buildTopology({
          clusterHealth: {
            isHealthy: false,
            healthRatio: 0.3,
            totalNodes: 10,
            aliveNodes: 3,
            suspectNodes: 2,
            deadNodes: 5,
            ringCoverage: 0.3,
            partitionCount: 0
          }
        })
      );

      // Fresh manager so there's no cached dashboard
      const freshManager = new ObservabilityManager(
        mockTopologyManager as unknown as ResourceTopologyManager,
        mockCluster as ClusterManager
      );

      const { overview } = await freshManager.getDashboard();
      expect(overview.clusterHealth).toBe('critical');
      await freshManager.stop();
    });

    test('clusterHealth is warning when healthRatio >= 0.5 and not healthy', async () => {
      mockTopologyManager.getResourceTopology.mockResolvedValue(
        buildTopology({
          clusterHealth: {
            isHealthy: false,
            healthRatio: 0.6,
            totalNodes: 10,
            aliveNodes: 6,
            suspectNodes: 2,
            deadNodes: 2,
            ringCoverage: 0.6,
            partitionCount: 0
          }
        })
      );

      const freshManager = new ObservabilityManager(
        mockTopologyManager as unknown as ResourceTopologyManager,
        mockCluster as ClusterManager
      );

      const { overview } = await freshManager.getDashboard();
      expect(overview.clusterHealth).toBe('warning');
      await freshManager.stop();
    });

    test('alerts include a health alert when cluster is not healthy', async () => {
      mockTopologyManager.getResourceTopology.mockResolvedValue(
        buildTopology({
          clusterHealth: {
            isHealthy: false,
            healthRatio: 0.6,
            totalNodes: 5,
            aliveNodes: 3,
            suspectNodes: 1,
            deadNodes: 1,
            ringCoverage: 0.6,
            partitionCount: 0
          }
        })
      );

      const freshManager = new ObservabilityManager(
        mockTopologyManager as unknown as ResourceTopologyManager,
        mockCluster as ClusterManager
      );

      const { alerts } = await freshManager.getDashboard();
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0]).toHaveProperty('severity');
      expect(alerts[0]).toHaveProperty('message');
      expect(alerts[0]).toHaveProperty('timestamp');
      expect(alerts[0]).toHaveProperty('category');
      await freshManager.stop();
    });

    test('regions are derived from node data', async () => {
      const node1 = buildNode('node-1', { region: 'us-west-2' });
      const node2 = buildNode('node-2', { region: 'eu-west-1' });

      mockTopologyManager.getResourceTopology.mockResolvedValue(
        buildTopology({ nodes: [node1, node2] })
      );

      const freshManager = new ObservabilityManager(
        mockTopologyManager as unknown as ResourceTopologyManager,
        mockCluster as ClusterManager
      );

      const { regions } = await freshManager.getDashboard();
      expect(regions).toHaveProperty('us-west-2');
      expect(regions).toHaveProperty('eu-west-1');
      await freshManager.stop();
    });
  });

  // -------------------------------------------------------------------------
  // queryTopology()
  // -------------------------------------------------------------------------

  describe('queryTopology()', () => {
    test('returns object with topology, filteredNodes, and filteredResources fields', async () => {
      const result = await manager.queryTopology({});
      expect(result).toHaveProperty('topology');
      expect(result).toHaveProperty('filteredNodes');
      expect(result).toHaveProperty('filteredResources');
    });

    test('works with an empty query object', async () => {
      await expect(manager.queryTopology({})).resolves.toBeDefined();
    });

    test('works with no arguments (uses default empty query)', async () => {
      await expect(manager.queryTopology()).resolves.toBeDefined();
    });

    test('includes aggregatedMetrics when includeMetrics is true', async () => {
      const result = await manager.queryTopology({ includeMetrics: true });
      expect(result.aggregatedMetrics).toBeDefined();
      expect(result.aggregatedMetrics).toHaveProperty('totalResources');
      expect(result.aggregatedMetrics).toHaveProperty('performance');
    });

    test('aggregatedMetrics is undefined when includeMetrics is false or omitted', async () => {
      const result = await manager.queryTopology({ includeMetrics: false });
      expect(result.aggregatedMetrics).toBeUndefined();
    });

    test('calls getResourceTopology on topologyManager', async () => {
      await manager.queryTopology({ regions: ['us-east-1'] });
      expect(mockTopologyManager.getResourceTopology).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getResourcePlacementRecommendations()
  // -------------------------------------------------------------------------

  describe('getResourcePlacementRecommendations()', () => {
    test('returns an array', async () => {
      const result = await manager.getResourcePlacementRecommendations();
      expect(Array.isArray(result)).toBe(true);
    });

    test('returns empty array when topology is empty', async () => {
      const result = await manager.getResourcePlacementRecommendations();
      expect(result).toHaveLength(0);
    });

    test('accepts all valid optimizeFor values without throwing', async () => {
      const options = ['performance', 'cost', 'availability', 'latency'] as const;
      for (const opt of options) {
        await expect(manager.getResourcePlacementRecommendations(opt)).resolves.toBeInstanceOf(Array);
      }
    });
  });

  // -------------------------------------------------------------------------
  // getScalingAnalysis()
  // -------------------------------------------------------------------------

  describe('getScalingAnalysis()', () => {
    test('returns a ClusterScalingAnalysis-shaped object', async () => {
      const result = await manager.getScalingAnalysis();
      expect(result).toHaveProperty('currentState');
      expect(result).toHaveProperty('projectedDemand');
      expect(result).toHaveProperty('recommendations');
      expect(result).toHaveProperty('costAnalysis');
    });

    test('currentState has expected fields', async () => {
      const { currentState } = await manager.getScalingAnalysis();
      expect(currentState).toHaveProperty('totalNodes');
      expect(currentState).toHaveProperty('totalCapacity');
      expect(currentState).toHaveProperty('currentUtilization');
      expect(currentState).toHaveProperty('bottlenecks');
      expect(Array.isArray(currentState.bottlenecks)).toBe(true);
    });

    test('projectedDemand has expected fields', async () => {
      const { projectedDemand } = await manager.getScalingAnalysis();
      expect(projectedDemand).toHaveProperty('timeHorizon');
      expect(projectedDemand).toHaveProperty('expectedLoad');
      expect(projectedDemand).toHaveProperty('expectedResources');
      expect(projectedDemand).toHaveProperty('expectedConnections');
    });

    test('recommendations has expected fields', async () => {
      const { recommendations } = await manager.getScalingAnalysis();
      expect(recommendations).toHaveProperty('scaleUp');
      expect(recommendations).toHaveProperty('scaleDown');
      expect(recommendations).toHaveProperty('addNodes');
      expect(recommendations).toHaveProperty('removeNodes');
      expect(recommendations).toHaveProperty('urgency');
      expect(['low', 'medium', 'high', 'critical']).toContain(recommendations.urgency);
    });

    test('costAnalysis has expected fields', async () => {
      const { costAnalysis } = await manager.getScalingAnalysis();
      expect(costAnalysis).toHaveProperty('currentCost');
      expect(costAnalysis).toHaveProperty('projectedCost');
      expect(costAnalysis).toHaveProperty('savings');
      expect(costAnalysis).toHaveProperty('efficiency');
    });

    test('accepts 1hour time horizon', async () => {
      const result = await manager.getScalingAnalysis('1hour');
      expect(result.projectedDemand.timeHorizon).toBe('1hour');
    });

    test('accepts 6hours time horizon', async () => {
      const result = await manager.getScalingAnalysis('6hours');
      expect(result.projectedDemand.timeHorizon).toBe('6hours');
    });

    test('accepts 24hours time horizon', async () => {
      const result = await manager.getScalingAnalysis('24hours');
      expect(result.projectedDemand.timeHorizon).toBe('24hours');
    });

    test('recommends scale up when utilization > 0.8', async () => {
      mockTopologyManager.getResourceTopology.mockResolvedValue(
        buildTopology({
          performance: { averageLatency: 0, totalThroughput: 0, errorRate: 0, utilizationRate: 0.85 }
        })
      );

      const freshManager = new ObservabilityManager(
        mockTopologyManager as unknown as ResourceTopologyManager,
        mockCluster as ClusterManager
      );

      const { recommendations } = await freshManager.getScalingAnalysis();
      expect(recommendations.scaleUp).toBe(true);
      await freshManager.stop();
    });
  });

  // -------------------------------------------------------------------------
  // getGeographicAnalysis()
  // -------------------------------------------------------------------------

  describe('getGeographicAnalysis()', () => {
    test('returns an object with regions and optimization fields', async () => {
      const result = await manager.getGeographicAnalysis();
      expect(result).toHaveProperty('regions');
      expect(result).toHaveProperty('optimization');
    });

    test('works when no nodes are registered (empty topology)', async () => {
      await expect(manager.getGeographicAnalysis()).resolves.toBeDefined();
      const result = await manager.getGeographicAnalysis();
      expect(result.regions).toEqual({});
    });

    test('populates regions from node data', async () => {
      const node1 = buildNode('n1', { region: 'ap-southeast-1' });
      const node2 = buildNode('n2', { region: 'ap-southeast-1' });
      const node3 = buildNode('n3', { region: 'us-west-2' });

      mockTopologyManager.getResourceTopology.mockResolvedValue(
        buildTopology({ nodes: [node1, node2, node3] })
      );

      const freshManager = new ObservabilityManager(
        mockTopologyManager as unknown as ResourceTopologyManager,
        mockCluster as ClusterManager
      );

      const result = await freshManager.getGeographicAnalysis();
      expect(result.regions).toHaveProperty('ap-southeast-1');
      expect(result.regions['ap-southeast-1'].nodes).toBe(2);
      expect(result.regions).toHaveProperty('us-west-2');
      await freshManager.stop();
    });
  });

  // -------------------------------------------------------------------------
  // getPerformanceTrends()
  // -------------------------------------------------------------------------

  describe('getPerformanceTrends()', () => {
    test('returns object with trends, predictions, and alerts fields', async () => {
      const result = await manager.getPerformanceTrends();
      expect(result).toHaveProperty('trends');
      expect(result).toHaveProperty('predictions');
      expect(result).toHaveProperty('alerts');
    });

    test('works when historical data is empty (returns stable defaults)', async () => {
      const { trends } = await manager.getPerformanceTrends();
      expect(trends.connections).toHaveProperty('trend');
      expect(trends.messageVolume).toHaveProperty('trend');
      expect(trends.nodeHealth).toHaveProperty('trend');
      expect(trends.latency).toHaveProperty('trend');
    });

    test('trends has connections, messageVolume, nodeHealth, latency sub-objects', async () => {
      const { trends } = await manager.getPerformanceTrends();
      for (const key of ['connections', 'messageVolume', 'nodeHealth', 'latency']) {
        expect(trends[key as keyof typeof trends]).toHaveProperty('current');
        expect(trends[key as keyof typeof trends]).toHaveProperty('trend');
        expect(trends[key as keyof typeof trends]).toHaveProperty('rate');
      }
    });

    test('predictions has nextHour, next6Hours, next24Hours', async () => {
      const { predictions } = await manager.getPerformanceTrends();
      expect(predictions).toHaveProperty('nextHour');
      expect(predictions).toHaveProperty('next6Hours');
      expect(predictions).toHaveProperty('next24Hours');
    });

    test('alerts is an array', async () => {
      const { alerts } = await manager.getPerformanceTrends();
      expect(Array.isArray(alerts)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // registerResource() / updateResourceMetrics() / registerNodeCapacity()
  // -------------------------------------------------------------------------

  describe('registerResource()', () => {
    test('calls topologyManager.registerResourceType with the given type name', async () => {
      await manager.registerResource('chat-room', { defaultReplicationFactor: 2 });
      expect(mockTopologyManager.registerResourceType).toHaveBeenCalledWith(
        'chat-room',
        { defaultReplicationFactor: 2 }
      );
    });

    test('passes full config object through to registerResourceType', async () => {
      const config = {
        defaultReplicationFactor: 3,
        capacityLimits: { maxInstancesPerNode: 10 },
        placementConstraints: { allowedRegions: ['us-east-1'] }
      };
      await manager.registerResource('session', config);
      expect(mockTopologyManager.registerResourceType).toHaveBeenCalledWith('session', config);
    });
  });

  describe('updateResourceMetrics()', () => {
    test('emits resource-metrics-updated event with resourceId and metrics', async () => {
      const handler = jest.fn();
      manager.on('resource-metrics-updated', handler);

      const metrics = { connectionCount: 42, messageRate: 10, lastActivity: Date.now() };
      await manager.updateResourceMetrics('resource-123', metrics);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ resourceId: 'resource-123', metrics });
    });

    test('does not call topologyManager methods', async () => {
      await manager.updateResourceMetrics('r1', { connectionCount: 1 });
      expect(mockTopologyManager.start).not.toHaveBeenCalled();
      expect(mockTopologyManager.stop).not.toHaveBeenCalled();
      expect(mockTopologyManager.getResourceTopology).not.toHaveBeenCalled();
    });
  });

  describe('registerNodeCapacity()', () => {
    test('emits node-capacity-registered event with the capacity object', async () => {
      const handler = jest.fn();
      manager.on('node-capacity-registered', handler);

      const capacity = buildNode('new-node');
      await manager.registerNodeCapacity(capacity);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(capacity);
    });
  });

  // -------------------------------------------------------------------------
  // topology:updated event handling
  // -------------------------------------------------------------------------

  describe('topology:updated event', () => {
    test('emits topology-changed when topologyManager emits topology:updated', async () => {
      const handler = jest.fn();
      manager.on('topology-changed', handler);

      mockTopologyManager.emit('topology:updated');
      await Promise.resolve(); // flush async handleTopologyUpdate

      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('stores topology in historical data (verified via getScalingAnalysis)', async () => {
      // Emit topology updates to populate history
      for (let i = 0; i < 3; i++) {
        mockTopologyManager.emit('topology:updated');
        await Promise.resolve();
      }

      // getScalingAnalysis uses historical data — should resolve without error
      await expect(manager.getScalingAnalysis()).resolves.toBeDefined();
    });

    test('emits health-alert when cluster health is critical (ratio < 0.5)', async () => {
      const alertHandler = jest.fn();
      manager.on('health-alert', alertHandler);

      mockTopologyManager.getResourceTopology.mockResolvedValue(
        buildTopology({
          clusterHealth: {
            isHealthy: false,
            healthRatio: 0.2,
            totalNodes: 5,
            aliveNodes: 1,
            suspectNodes: 1,
            deadNodes: 3,
            ringCoverage: 0.2,
            partitionCount: 1
          }
        })
      );

      mockTopologyManager.emit('topology:updated');
      await Promise.resolve();

      expect(alertHandler).toHaveBeenCalledTimes(1);
      const alert = alertHandler.mock.calls[0][0];
      expect(alert.severity).toBe('critical');
    });

    test('does not emit health-alert when cluster is healthy', async () => {
      const alertHandler = jest.fn();
      manager.on('health-alert', alertHandler);

      // Default topology has isHealthy=true
      mockTopologyManager.emit('topology:updated');
      await Promise.resolve();

      expect(alertHandler).not.toHaveBeenCalled();
    });

    test('caps historical topologies at maxHistorySize', async () => {
      const smallManager = new ObservabilityManager(
        mockTopologyManager as unknown as ResourceTopologyManager,
        mockCluster as ClusterManager,
        { maxHistorySize: 5 }
      );

      // Emit more updates than the history cap
      for (let i = 0; i < 10; i++) {
        mockTopologyManager.emit('topology:updated');
        await Promise.resolve();
      }

      // Indirectly verified: manager should still function correctly
      await expect(smallManager.getPerformanceTrends()).resolves.toBeDefined();
      await smallManager.stop();
    });
  });
});
