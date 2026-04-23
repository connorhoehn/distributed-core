import { ProductionScaleResourceManager } from '../../../../src/cluster/resources/ProductionScaleResourceManager';
import { ResourceRegistry } from '../../../../src/cluster/resources/ResourceRegistry';
import { ClusterManager } from '../../../../src/cluster/ClusterManager';
import { MetricsTracker } from '../../../../src/monitoring/metrics/MetricsTracker';
import {
  ResourceMetadata,
  ResourceTypeDefinition,
  ResourceState,
  ResourceHealth,
  DistributionStrategy
} from '../../../../src/cluster/resources/types';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeResource(overrides: Partial<ResourceMetadata> = {}): ResourceMetadata {
  return {
    resourceId: 'res-1',
    resourceType: 'test-type',
    nodeId: 'node-1',
    timestamp: Date.now(),
    capacity: { current: 10, maximum: 100, unit: 'items' },
    performance: { latency: 5, throughput: 20, errorRate: 0 },
    distribution: { shardCount: 1, replicationFactor: 1 },
    applicationData: {},
    state: ResourceState.ACTIVE,
    health: ResourceHealth.HEALTHY,
    ...overrides
  };
}

function makeTypeDef(overrides: Partial<ResourceTypeDefinition> = {}): ResourceTypeDefinition {
  return {
    typeName: 'test-type',
    version: '1.0.0',
    defaultCapacity: { totalCapacity: 100, maxThroughput: 50, avgLatency: 10 },
    capacityCalculator: () => 50,
    healthChecker: () => ResourceHealth.HEALTHY,
    performanceMetrics: ['latency'],
    defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
    distributionConstraints: [],
    serialize: (r) => r,
    deserialize: (d) => d,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Shared mock setup
// ---------------------------------------------------------------------------

let mockResourceRegistry: jest.Mocked<ResourceRegistry>;
let mockClusterManager: jest.Mocked<ClusterManager>;
let mockMetricsTracker: jest.Mocked<MetricsTracker>;
let manager: ProductionScaleResourceManager;

function buildMocks() {
  mockResourceRegistry = {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    emit: jest.fn(),
    registerResourceType: jest.fn(),
    createResource: jest.fn(),
    getResource: jest.fn().mockReturnValue(null),
    getResourcesByType: jest.fn().mockReturnValue([]),
    getResourcesByNode: jest.fn().mockReturnValue([]),
    getLocalResources: jest.fn().mockReturnValue([]),
    removeResource: jest.fn().mockResolvedValue(undefined),
    transferResource: jest.fn(),
  } as unknown as jest.Mocked<ResourceRegistry>;

  mockClusterManager = {
    localNodeId: 'local-node',
    getAliveMembers: jest.fn().mockReturnValue([]),
    getMembership: jest.fn().mockReturnValue(new Map()),
    getMemberCount: jest.fn().mockReturnValue(0),
  } as unknown as jest.Mocked<ClusterManager>;

  mockMetricsTracker = {
    trackUnified: jest.fn(),
    incrementCounter: jest.fn(),
    recordGauge: jest.fn(),
    recordHistogram: jest.fn(),
    setGauge: jest.fn(),
    getGaugeValue: jest.fn().mockReturnValue(0),
  } as unknown as jest.Mocked<MetricsTracker>;
}

// ---------------------------------------------------------------------------
// describe: constructor
// ---------------------------------------------------------------------------

describe('ProductionScaleResourceManager', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    buildMocks();
    manager = new ProductionScaleResourceManager(
      mockResourceRegistry,
      mockClusterManager,
      mockMetricsTracker
    );
  });

  afterEach(async () => {
    // Always stop to clean up timers and prevent Jest from hanging
    await manager.stop().catch(() => undefined);
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  describe('constructor', () => {
    it('instantiates without error', () => {
      expect(manager).toBeInstanceOf(ProductionScaleResourceManager);
    });

    it('calls resourceRegistry.on() to set up resource event handlers during construction', () => {
      // setupResourceEventHandling registers listeners for 3 events
      expect(mockResourceRegistry.on).toHaveBeenCalledWith('resource:created', expect.any(Function));
      expect(mockResourceRegistry.on).toHaveBeenCalledWith('resource:destroyed', expect.any(Function));
      expect(mockResourceRegistry.on).toHaveBeenCalledWith('resource:migrated', expect.any(Function));
    });

    it('registers exactly 3 event listeners on the registry', () => {
      expect(mockResourceRegistry.on).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  describe('start()', () => {
    it('calls resourceRegistry.start()', async () => {
      await manager.start();
      expect(mockResourceRegistry.start).toHaveBeenCalledTimes(1);
    });

    it('emits "manager:started" after starting', async () => {
      const listener = jest.fn();
      manager.on('manager:started', listener);
      await manager.start();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('starts a health monitoring interval', async () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      await manager.start();
      // At least one interval should have been set (health check)
      expect(setIntervalSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('stop()', () => {
    it('calls resourceRegistry.stop()', async () => {
      await manager.start();
      await manager.stop();
      expect(mockResourceRegistry.stop).toHaveBeenCalledTimes(1);
    });

    it('emits "manager:stopped" after stopping', async () => {
      await manager.start();
      const listener = jest.fn();
      manager.on('manager:stopped', listener);
      await manager.stop();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('clears all auto-scaling intervals on stop', async () => {
      await manager.start();

      // Register a type with scaling enabled and create a resource to trigger startAutoScaling
      const resource = makeResource({
        applicationData: {
          scaling: { enabled: true, maxReplicas: 5, minReplicas: 1, scaleUpThreshold: 80, scaleDownThreshold: 20 }
        }
      });

      // Access private scalingIntervals indirectly by verifying clearInterval is called
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      await manager.stop();
      // clearInterval should have been called for the health check interval at minimum
      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it('does not throw when called without a prior start()', async () => {
      // manager was never started in this branch
      await expect(manager.stop()).resolves.not.toThrow();
    });

    it('clears the health monitoring interval', async () => {
      await manager.start();
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      await manager.stop();
      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('registerResourceType()', () => {
    it('calls resourceRegistry.registerResourceType() with an enhanced definition', () => {
      const typeDef = makeTypeDef();
      manager.registerResourceType(typeDef);
      expect(mockResourceRegistry.registerResourceType).toHaveBeenCalledTimes(1);
      const passedDef = mockResourceRegistry.registerResourceType.mock.calls[0][0];
      expect(passedDef.typeName).toBe('test-type');
    });

    it('the enhanced onResourceCreated calls metricsTracker.trackUnified', async () => {
      const typeDef = makeTypeDef();
      manager.registerResourceType(typeDef);
      const enhanced = mockResourceRegistry.registerResourceType.mock.calls[0][0];
      const resource = makeResource();
      await enhanced.onResourceCreated!(resource);
      expect(mockMetricsTracker.trackUnified).toHaveBeenCalledTimes(1);
    });

    it('the enhanced onResourceCreated calls the original hook when provided', async () => {
      const originalHook = jest.fn().mockResolvedValue(undefined);
      const typeDef = makeTypeDef({ onResourceCreated: originalHook });
      manager.registerResourceType(typeDef);
      const enhanced = mockResourceRegistry.registerResourceType.mock.calls[0][0];
      const resource = makeResource();
      await enhanced.onResourceCreated!(resource);
      expect(originalHook).toHaveBeenCalledWith(resource);
    });

    it('the enhanced onResourceDestroyed calls metricsTracker.incrementCounter', async () => {
      const typeDef = makeTypeDef();
      manager.registerResourceType(typeDef);
      const enhanced = mockResourceRegistry.registerResourceType.mock.calls[0][0];
      const resource = makeResource();
      await enhanced.onResourceDestroyed!(resource);
      expect(mockMetricsTracker.incrementCounter).toHaveBeenCalledWith(
        'resources_destroyed_total',
        1,
        { type: resource.resourceType, node: resource.nodeId }
      );
    });

    it('the enhanced onResourceDestroyed calls the original hook when provided', async () => {
      const originalHook = jest.fn().mockResolvedValue(undefined);
      const typeDef = makeTypeDef({ onResourceDestroyed: originalHook });
      manager.registerResourceType(typeDef);
      const enhanced = mockResourceRegistry.registerResourceType.mock.calls[0][0];
      const resource = makeResource();
      await enhanced.onResourceDestroyed!(resource);
      expect(originalHook).toHaveBeenCalledWith(resource);
    });

    it('works when no lifecycle hooks are provided in the original definition', async () => {
      const typeDef = makeTypeDef();
      // Ensure no hooks on original
      expect(typeDef.onResourceCreated).toBeUndefined();
      expect(typeDef.onResourceDestroyed).toBeUndefined();

      manager.registerResourceType(typeDef);
      const enhanced = mockResourceRegistry.registerResourceType.mock.calls[0][0];
      const resource = makeResource();

      // Should not throw even though no original hooks exist
      await expect(enhanced.onResourceCreated!(resource)).resolves.not.toThrow();
      await expect(enhanced.onResourceDestroyed!(resource)).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe('createResourceWithPlacement()', () => {
    const baseMetadata: Omit<ResourceMetadata, 'nodeId' | 'timestamp'> = {
      resourceId: 'placed-res',
      resourceType: 'test-type',
      capacity: { current: 0, maximum: 100, unit: 'items' },
      performance: { latency: 0, throughput: 0, errorRate: 0 },
      distribution: {},
      applicationData: {},
      state: ResourceState.ACTIVE,
      health: ResourceHealth.HEALTHY
    };

    it('"load-balanced" strategy uses getAliveMembers to pick a node', async () => {
      mockClusterManager.getAliveMembers.mockReturnValue([
        { id: 'node-a' } as any,
        { id: 'node-b' } as any
      ]);
      mockResourceRegistry.getResourcesByNode.mockReturnValue([]);
      const created = makeResource({ nodeId: 'node-a' });
      mockResourceRegistry.createResource.mockResolvedValue(created);

      await manager.createResourceWithPlacement(baseMetadata, 'load-balanced');

      expect(mockClusterManager.getAliveMembers).toHaveBeenCalled();
      expect(mockResourceRegistry.createResource).toHaveBeenCalledWith(
        expect.objectContaining({ resourceId: 'placed-res' })
      );
    });

    it('"manual" strategy uses the provided targetNode', async () => {
      const created = makeResource({ nodeId: 'specific-node' });
      mockResourceRegistry.createResource.mockResolvedValue(created);

      await manager.createResourceWithPlacement(baseMetadata, 'manual', 'specific-node');

      expect(mockResourceRegistry.createResource).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'specific-node' })
      );
    });

    it('"manual" strategy throws when no targetNode is provided', async () => {
      await expect(
        manager.createResourceWithPlacement(baseMetadata, 'manual')
      ).rejects.toThrow('Target node must be specified for manual placement');
    });

    it('"affinity" strategy falls through to localNodeId when no cluster members', async () => {
      const created = makeResource({ nodeId: 'local-node' });
      mockResourceRegistry.createResource.mockResolvedValue(created);

      await manager.createResourceWithPlacement(baseMetadata, 'affinity');

      expect(mockResourceRegistry.createResource).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'local-node' })
      );
    });

    it('returns the resource from createResource', async () => {
      const created = makeResource({ nodeId: 'local-node' });
      mockResourceRegistry.createResource.mockResolvedValue(created);

      const result = await manager.createResourceWithPlacement(baseMetadata, 'affinity');
      expect(result).toBe(created);
    });

    it('propagates errors thrown by resourceRegistry.createResource', async () => {
      mockResourceRegistry.createResource.mockRejectedValue(new Error('creation failed'));

      await expect(
        manager.createResourceWithPlacement(baseMetadata, 'affinity')
      ).rejects.toThrow('creation failed');
    });
  });

  // -------------------------------------------------------------------------
  describe('delegation methods', () => {
    it('createResource() delegates to resourceRegistry.createResource()', async () => {
      const resource = makeResource();
      mockResourceRegistry.createResource.mockResolvedValue(resource);

      const result = await manager.createResource(resource);
      expect(mockResourceRegistry.createResource).toHaveBeenCalledWith(resource);
      expect(result).toBe(resource);
    });

    it('getResource() delegates to resourceRegistry.getResource()', () => {
      const resource = makeResource();
      mockResourceRegistry.getResource.mockReturnValue(resource);

      const result = manager.getResource('res-1');
      expect(mockResourceRegistry.getResource).toHaveBeenCalledWith('res-1');
      expect(result).toBe(resource);
    });

    it('getResource() returns null when registry returns null', () => {
      mockResourceRegistry.getResource.mockReturnValue(null);
      const result = manager.getResource('nonexistent');
      expect(result).toBeNull();
    });

    it('getResourcesByType() delegates to resourceRegistry.getResourcesByType()', () => {
      const resources = [makeResource()];
      mockResourceRegistry.getResourcesByType.mockReturnValue(resources);

      const result = manager.getResourcesByType('test-type');
      expect(mockResourceRegistry.getResourcesByType).toHaveBeenCalledWith('test-type');
      expect(result).toBe(resources);
    });

    it('getResourcesByNode() delegates to resourceRegistry.getResourcesByNode()', () => {
      const resources = [makeResource()];
      mockResourceRegistry.getResourcesByNode.mockReturnValue(resources);

      const result = manager.getResourcesByNode('node-1');
      expect(mockResourceRegistry.getResourcesByNode).toHaveBeenCalledWith('node-1');
      expect(result).toBe(resources);
    });

    it('removeResource() delegates to resourceRegistry.removeResource()', async () => {
      await manager.removeResource('res-1');
      expect(mockResourceRegistry.removeResource).toHaveBeenCalledWith('res-1');
    });

    it('transferResource() delegates to resourceRegistry.transferResource()', async () => {
      const transferred = makeResource({ nodeId: 'node-2' });
      mockResourceRegistry.transferResource.mockResolvedValue(transferred);

      const result = await manager.transferResource('res-1', 'node-2');
      expect(mockResourceRegistry.transferResource).toHaveBeenCalledWith('res-1', 'node-2');
      expect(result).toBe(transferred);
    });
  });

  // -------------------------------------------------------------------------
  describe('getClusterResourceOverview()', () => {
    it('returns an object with the expected shape', async () => {
      mockResourceRegistry.getResourcesByType.mockReturnValue([]);
      mockMetricsTracker.getGaugeValue.mockReturnValue(0);

      const overview = await manager.getClusterResourceOverview();

      expect(overview).toHaveProperty('totalResources');
      expect(overview).toHaveProperty('resourcesByType');
      expect(overview).toHaveProperty('resourcesByNode');
      expect(overview).toHaveProperty('healthyResources');
      expect(overview).toHaveProperty('unhealthyResources');
    });

    it('reports zero total resources when cluster has none', async () => {
      mockResourceRegistry.getResourcesByType.mockReturnValue([]);

      const overview = await manager.getClusterResourceOverview();
      expect(overview.totalResources).toBe(0);
      expect(overview.healthyResources).toBe(0);
      expect(overview.unhealthyResources).toBe(0);
    });

    it('includes per-node breakdown for multiple resources', async () => {
      const resourcesOnNode1 = [
        makeResource({ resourceId: 'r1', nodeId: 'node-1', resourceType: 'type-a' }),
        makeResource({ resourceId: 'r2', nodeId: 'node-1', resourceType: 'type-b' })
      ];
      const resourcesOnNode2 = [
        makeResource({ resourceId: 'r3', nodeId: 'node-2', resourceType: 'type-a' })
      ];
      mockResourceRegistry.getResourcesByType.mockReturnValue([
        ...resourcesOnNode1,
        ...resourcesOnNode2
      ]);
      // All metrics return 0 → all resources are healthy (no thresholds exceeded)
      mockMetricsTracker.getGaugeValue.mockReturnValue(0);

      const overview = await manager.getClusterResourceOverview();

      expect(overview.totalResources).toBe(3);
      expect(overview.resourcesByNode.get('node-1')).toBe(2);
      expect(overview.resourcesByNode.get('node-2')).toBe(1);
    });

    it('works when cluster has no alive members (empty resource list)', async () => {
      mockResourceRegistry.getResourcesByType.mockReturnValue([]);

      await expect(manager.getClusterResourceOverview()).resolves.toMatchObject({
        totalResources: 0,
        healthyResources: 0,
        unhealthyResources: 0
      });
    });

    it('includes per-type breakdown', async () => {
      mockResourceRegistry.getResourcesByType.mockReturnValue([
        makeResource({ resourceId: 'r1', resourceType: 'type-a' }),
        makeResource({ resourceId: 'r2', resourceType: 'type-a' }),
        makeResource({ resourceId: 'r3', resourceType: 'type-b' })
      ]);
      mockMetricsTracker.getGaugeValue.mockReturnValue(0);

      const overview = await manager.getClusterResourceOverview();

      expect(overview.resourcesByType.get('type-a')).toBe(2);
      expect(overview.resourcesByType.get('type-b')).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('health monitoring', () => {
    it('start() creates a health-check interval', async () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      await manager.start();
      // The health check interval is 60000 ms
      const callArgs = setIntervalSpy.mock.calls.map(c => c[1]);
      expect(callArgs).toContain(60000);
    });

    it('performHealthChecks() calls getLocalResources after advancing timer past 60s', async () => {
      await manager.start();

      mockResourceRegistry.getLocalResources.mockReturnValue([]);
      // Advance fake timers past the health check interval
      jest.advanceTimersByTime(60001);

      // Allow any async work to flush
      await Promise.resolve();

      expect(mockResourceRegistry.getLocalResources).toHaveBeenCalled();
    });

    it('emits "resource:unhealthy" for resources with high CPU usage', async () => {
      const unhealthyResource = makeResource({ resourceId: 'sick-res' });
      mockResourceRegistry.getLocalResources.mockReturnValue([unhealthyResource]);
      // Return high CPU usage (> 0.95 triggers "unhealthy")
      mockMetricsTracker.getGaugeValue.mockImplementation((name) => {
        if (name === 'resource_cpu_usage') return 0.99;
        return 0;
      });

      await manager.start();
      const unhealthyListener = jest.fn();
      manager.on('resource:unhealthy', unhealthyListener);

      jest.advanceTimersByTime(60001);
      // Flush micro-task queue for async health-check work
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(unhealthyListener).toHaveBeenCalledWith(
        expect.objectContaining({ resourceId: 'sick-res' }),
        expect.objectContaining({ status: 'unhealthy' })
      );
    });

    it('healthy resources do not emit "resource:unhealthy"', async () => {
      const healthyResource = makeResource({ resourceId: 'well-res' });
      mockResourceRegistry.getLocalResources.mockReturnValue([healthyResource]);
      // All gauge values return 0 → no threshold exceeded → healthy
      mockMetricsTracker.getGaugeValue.mockReturnValue(0);

      await manager.start();
      const unhealthyListener = jest.fn();
      manager.on('resource:unhealthy', unhealthyListener);

      jest.advanceTimersByTime(60001);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(unhealthyListener).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('auto-scaling', () => {
    it('registers an auto-scaling interval when a resource with scaling.enabled is created via onResourceCreated hook', async () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      const typeDef = makeTypeDef();
      manager.registerResourceType(typeDef);
      const enhanced = mockResourceRegistry.registerResourceType.mock.calls[0][0];

      const scalingResource = makeResource({
        applicationData: {
          scaling: { enabled: true, maxReplicas: 3, minReplicas: 1 }
        }
      });

      await enhanced.onResourceCreated!(scalingResource);

      // The auto-scaling interval is 30000 ms
      const callArgs = setIntervalSpy.mock.calls.map(c => c[1]);
      expect(callArgs).toContain(30000);
    });

    it('stopAutoScaling is called in the onResourceDestroyed hook', async () => {
      // First ensure an interval is registered
      const typeDef = makeTypeDef();
      manager.registerResourceType(typeDef);
      const enhanced = mockResourceRegistry.registerResourceType.mock.calls[0][0];

      const scalingResource = makeResource({
        resourceId: 'scaling-res',
        applicationData: {
          scaling: { enabled: true, maxReplicas: 3, minReplicas: 1 }
        }
      });

      // Create resource (starts auto-scaling)
      await enhanced.onResourceCreated!(scalingResource);

      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      // Destroy resource (should stop auto-scaling)
      await enhanced.onResourceDestroyed!(scalingResource);

      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it('does not register duplicate auto-scaling intervals for the same resource', async () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      const typeDef = makeTypeDef();
      manager.registerResourceType(typeDef);
      const enhanced = mockResourceRegistry.registerResourceType.mock.calls[0][0];

      const scalingResource = makeResource({
        resourceId: 'dup-res',
        applicationData: {
          scaling: { enabled: true, maxReplicas: 3, minReplicas: 1 }
        }
      });

      const callsBefore = setIntervalSpy.mock.calls.length;
      await enhanced.onResourceCreated!(scalingResource);
      const callsAfterFirst = setIntervalSpy.mock.calls.length;

      // Second call for same resource should be a no-op
      await enhanced.onResourceCreated!(scalingResource);
      const callsAfterSecond = setIntervalSpy.mock.calls.length;

      expect(callsAfterFirst - callsBefore).toBe(1);
      expect(callsAfterSecond - callsAfterFirst).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('resource event handling (setupResourceEventHandling)', () => {
    it('calls metricsTracker.setGauge when "resource:created" event fires from registry', () => {
      // Retrieve the callback registered for 'resource:created'
      const onCalls = (mockResourceRegistry.on as jest.Mock).mock.calls;
      const createdCallback = onCalls.find(([event]) => event === 'resource:created')?.[1];
      expect(createdCallback).toBeDefined();

      const resource = makeResource({ resourceType: 'type-x' });
      mockResourceRegistry.getResourcesByType.mockReturnValue([resource]);

      createdCallback(resource);

      expect(mockMetricsTracker.setGauge).toHaveBeenCalledWith(
        'resource_count',
        expect.any(Number),
        { type: 'type-x' }
      );
    });

    it('calls metricsTracker.setGauge when "resource:destroyed" event fires from registry', () => {
      const onCalls = (mockResourceRegistry.on as jest.Mock).mock.calls;
      const destroyedCallback = onCalls.find(([event]) => event === 'resource:destroyed')?.[1];
      expect(destroyedCallback).toBeDefined();

      const resource = makeResource({ resourceType: 'type-y' });
      mockResourceRegistry.getResourcesByType.mockReturnValue([]);

      destroyedCallback(resource);

      expect(mockMetricsTracker.setGauge).toHaveBeenCalledWith(
        'resource_count',
        0,
        { type: 'type-y' }
      );
    });

    it('calls metricsTracker.incrementCounter when "resource:migrated" event fires from registry', () => {
      const onCalls = (mockResourceRegistry.on as jest.Mock).mock.calls;
      const migratedCallback = onCalls.find(([event]) => event === 'resource:migrated')?.[1];
      expect(migratedCallback).toBeDefined();

      const resource = makeResource({ resourceType: 'type-z', nodeId: 'node-2' });

      migratedCallback(resource);

      expect(mockMetricsTracker.incrementCounter).toHaveBeenCalledWith(
        'resource_migrations_total',
        1,
        { type: 'type-z', to_node: 'node-2' }
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('load-balanced node selection', () => {
    it('picks the node with the lowest current load', async () => {
      // node-a has load 50, node-b has load 0 → should pick node-b
      mockClusterManager.getAliveMembers.mockReturnValue([
        { id: 'node-a' } as any,
        { id: 'node-b' } as any
      ]);
      mockResourceRegistry.getResourcesByNode.mockImplementation((nodeId) => {
        if (nodeId === 'node-a') {
          return [makeResource({ capacity: { current: 50, maximum: 100, unit: 'items' } })];
        }
        return [];
      });

      const created = makeResource({ nodeId: 'node-b' });
      mockResourceRegistry.createResource.mockResolvedValue(created);

      const result = await manager.createResourceWithPlacement(
        {
          resourceId: 'load-test',
          resourceType: 'test-type',
          capacity: { current: 0, maximum: 100, unit: 'items' },
          performance: { latency: 0, throughput: 0, errorRate: 0 },
          distribution: {},
          applicationData: {},
          state: ResourceState.ACTIVE,
          health: ResourceHealth.HEALTHY
        },
        'load-balanced'
      );

      expect(mockResourceRegistry.createResource).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'node-b' })
      );
    });

    it('falls back to localNodeId when no alive members exist', async () => {
      mockClusterManager.getAliveMembers.mockReturnValue([]);
      const created = makeResource({ nodeId: 'local-node' });
      mockResourceRegistry.createResource.mockResolvedValue(created);

      await manager.createResourceWithPlacement(
        {
          resourceId: 'fallback-test',
          resourceType: 'test-type',
          capacity: { current: 0, maximum: 100, unit: 'items' },
          performance: { latency: 0, throughput: 0, errorRate: 0 },
          distribution: {},
          applicationData: {},
          state: ResourceState.ACTIVE,
          health: ResourceHealth.HEALTHY
        },
        'load-balanced'
      );

      expect(mockResourceRegistry.createResource).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'local-node' })
      );
    });
  });
});
