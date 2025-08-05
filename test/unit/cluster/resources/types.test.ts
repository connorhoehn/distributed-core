import {
  ResourceMetadata,
  ResourceState,
  ResourceHealth,
  DistributionStrategy,
  ResourceTypeDefinition,
  ResourceCapacity
} from '../../../../src/cluster/resources/types';

describe('Resource Types', () => {
  describe('ResourceMetadata', () => {
    test('should create valid ResourceMetadata', () => {
      const resource: ResourceMetadata = {
        resourceId: 'test-resource-1',
        resourceType: 'test-type',
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: {
          current: 50,
          maximum: 100,
          unit: 'requests'
        },
        performance: {
          latency: 25,
          throughput: 1000,
          errorRate: 0.01
        },
        distribution: {
          shardCount: 2,
          replicationFactor: 3
        },
        applicationData: {
          name: 'Test Resource',
          priority: 'high'
        },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      expect(resource.resourceId).toBe('test-resource-1');
      expect(resource.capacity.current).toBe(50);
      expect(resource.performance.latency).toBe(25);
      expect(resource.state).toBe(ResourceState.ACTIVE);
      expect(resource.health).toBe(ResourceHealth.HEALTHY);
    });

    test('should handle different capacity units', () => {
      const memoryResource: ResourceMetadata = {
        resourceId: 'memory-resource',
        resourceType: 'memory-pool',
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 512, maximum: 1024, unit: 'MB' },
        performance: { latency: 1, throughput: 10000, errorRate: 0 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: {},
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      const connectionResource: ResourceMetadata = {
        resourceId: 'connection-pool',
        resourceType: 'connection-pool',
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 25, maximum: 100, unit: 'connections' },
        performance: { latency: 5, throughput: 500, errorRate: 0.001 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: {},
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      expect(memoryResource.capacity.unit).toBe('MB');
      expect(connectionResource.capacity.unit).toBe('connections');
    });
  });

  describe('ResourceState Enum', () => {
    test('should have all required states', () => {
      expect(ResourceState.INITIALIZING).toBe('INITIALIZING');
      expect(ResourceState.ACTIVE).toBe('ACTIVE');
      expect(ResourceState.SCALING).toBe('SCALING');
      expect(ResourceState.MIGRATING).toBe('MIGRATING');
      expect(ResourceState.DRAINING).toBe('DRAINING');
      expect(ResourceState.SUSPENDED).toBe('SUSPENDED');
      expect(ResourceState.TERMINATING).toBe('TERMINATING');
      expect(ResourceState.ERROR).toBe('ERROR');
    });

    test('should support state transitions', () => {
      let currentState = ResourceState.INITIALIZING;
      
      // Normal lifecycle progression
      currentState = ResourceState.ACTIVE;
      expect(currentState).toBe(ResourceState.ACTIVE);
      
      currentState = ResourceState.SCALING;
      expect(currentState).toBe(ResourceState.SCALING);
      
      currentState = ResourceState.MIGRATING;
      expect(currentState).toBe(ResourceState.MIGRATING);
      
      currentState = ResourceState.TERMINATING;
      expect(currentState).toBe(ResourceState.TERMINATING);
    });
  });

  describe('ResourceHealth Enum', () => {
    test('should have all required health states', () => {
      expect(ResourceHealth.HEALTHY).toBe('HEALTHY');
      expect(ResourceHealth.DEGRADED).toBe('DEGRADED');
      expect(ResourceHealth.UNHEALTHY).toBe('UNHEALTHY');
      expect(ResourceHealth.UNKNOWN).toBe('UNKNOWN');
    });

    test('should support health transitions', () => {
      let currentHealth = ResourceHealth.HEALTHY;
      
      // Health can degrade
      currentHealth = ResourceHealth.DEGRADED;
      expect(currentHealth).toBe(ResourceHealth.DEGRADED);
      
      currentHealth = ResourceHealth.UNHEALTHY;
      expect(currentHealth).toBe(ResourceHealth.UNHEALTHY);
      
      // Health can recover
      currentHealth = ResourceHealth.HEALTHY;
      expect(currentHealth).toBe(ResourceHealth.HEALTHY);
    });
  });

  describe('DistributionStrategy Enum', () => {
    test('should have all required distribution strategies', () => {
      expect(DistributionStrategy.ROUND_ROBIN).toBe('ROUND_ROBIN');
      expect(DistributionStrategy.LEAST_LOADED).toBe('LEAST_LOADED');
      expect(DistributionStrategy.CONSISTENT_HASH).toBe('CONSISTENT_HASH');
      expect(DistributionStrategy.AFFINITY_BASED).toBe('AFFINITY_BASED');
      expect(DistributionStrategy.COST_OPTIMIZED).toBe('COST_OPTIMIZED');
      expect(DistributionStrategy.LATENCY_OPTIMIZED).toBe('LATENCY_OPTIMIZED');
    });
  });

  describe('ResourceTypeDefinition', () => {
    test('should create valid ResourceTypeDefinition', () => {
      const capacityCalculator = jest.fn((metadata: any) => {
        return metadata?.weight || 50;
      });

      const healthChecker = jest.fn((resource: ResourceMetadata) => {
        const utilization = resource.capacity.current / resource.capacity.maximum;
        return utilization > 0.8 ? ResourceHealth.DEGRADED : ResourceHealth.HEALTHY;
      });

      const onResourceCreated = jest.fn();
      const serialize = jest.fn((resource: ResourceMetadata) => ({ ...resource }));
      const deserialize = jest.fn((data: any) => ({ ...data }));

      const definition: ResourceTypeDefinition = {
        typeName: 'test-resource-type',
        version: '1.2.0',
        defaultCapacity: {
          totalCapacity: 1000,
          maxThroughput: 500,
          avgLatency: 10
        },
        capacityCalculator,
        healthChecker,
        performanceMetrics: ['latency', 'throughput', 'errorRate'],
        defaultDistributionStrategy: DistributionStrategy.LEAST_LOADED,
        distributionConstraints: [],
        onResourceCreated,
        serialize,
        deserialize
      };

      expect(definition.typeName).toBe('test-resource-type');
      expect(definition.version).toBe('1.2.0');
      expect(definition.defaultCapacity.totalCapacity).toBe(1000);
      expect(definition.defaultDistributionStrategy).toBe(DistributionStrategy.LEAST_LOADED);
      expect(definition.performanceMetrics).toContain('latency');
      expect(definition.performanceMetrics).toContain('throughput');
      expect(definition.performanceMetrics).toContain('errorRate');
    });

    test('should execute capacity calculator correctly', () => {
      const capacityCalculator = jest.fn((metadata: any) => {
        if (!metadata) return 0;
        return (metadata.participants || 0) * 10;
      });

      const definition: ResourceTypeDefinition = {
        typeName: 'chat-room',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 100, maxThroughput: 50, avgLatency: 10 },
        capacityCalculator,
        healthChecker: () => ResourceHealth.HEALTHY,
        performanceMetrics: ['participants'],
        defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
        distributionConstraints: [],
        serialize: (r) => r,
        deserialize: (d) => d
      };

      // Test capacity calculation
      const result1 = definition.capacityCalculator({ participants: 5 });
      expect(result1).toBe(50);

      const result2 = definition.capacityCalculator({ participants: 10 });
      expect(result2).toBe(100);

      const result3 = definition.capacityCalculator(null);
      expect(result3).toBe(0);

      expect(capacityCalculator).toHaveBeenCalledTimes(3);
    });

    test('should execute health checker correctly', () => {
      const healthChecker = jest.fn((resource: ResourceMetadata) => {
        const utilization = resource.capacity.current / resource.capacity.maximum;
        if (utilization > 0.9) return ResourceHealth.UNHEALTHY;
        if (utilization > 0.7) return ResourceHealth.DEGRADED;
        return ResourceHealth.HEALTHY;
      });

      const definition: ResourceTypeDefinition = {
        typeName: 'load-balancer',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 100, maxThroughput: 1000, avgLatency: 5 },
        capacityCalculator: () => 50,
        healthChecker,
        performanceMetrics: ['connections'],
        defaultDistributionStrategy: DistributionStrategy.LEAST_LOADED,
        distributionConstraints: [],
        serialize: (r) => r,
        deserialize: (d) => d
      };

      // Test healthy resource
      const healthyResource: ResourceMetadata = {
        resourceId: 'test-1',
        resourceType: 'load-balancer',
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 50, maximum: 100, unit: 'connections' },
        performance: { latency: 5, throughput: 500, errorRate: 0.01 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: {},
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      expect(definition.healthChecker(healthyResource)).toBe(ResourceHealth.HEALTHY);

      // Test degraded resource
      const degradedResource = { ...healthyResource, capacity: { current: 80, maximum: 100, unit: 'connections' } };
      expect(definition.healthChecker(degradedResource)).toBe(ResourceHealth.DEGRADED);

      // Test unhealthy resource
      const unhealthyResource = { ...healthyResource, capacity: { current: 95, maximum: 100, unit: 'connections' } };
      expect(definition.healthChecker(unhealthyResource)).toBe(ResourceHealth.UNHEALTHY);

      expect(healthChecker).toHaveBeenCalledTimes(3);
    });

    test('should handle lifecycle hooks', async () => {
      const onResourceCreated = jest.fn();
      const onResourceDestroyed = jest.fn();
      const onResourceMigrated = jest.fn();

      const definition: ResourceTypeDefinition = {
        typeName: 'database',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 1000, maxThroughput: 100, avgLatency: 20 },
        capacityCalculator: () => 500,
        healthChecker: () => ResourceHealth.HEALTHY,
        performanceMetrics: ['queries'],
        defaultDistributionStrategy: DistributionStrategy.AFFINITY_BASED,
        distributionConstraints: [],
        onResourceCreated,
        onResourceDestroyed,
        onResourceMigrated,
        serialize: (r) => r,
        deserialize: (d) => d
      };

      const testResource: ResourceMetadata = {
        resourceId: 'db-1',
        resourceType: 'database',
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 100, maximum: 1000, unit: 'queries' },
        performance: { latency: 20, throughput: 50, errorRate: 0.001 },
        distribution: { shardCount: 1, replicationFactor: 2 },
        applicationData: { schema: 'production' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      // Test lifecycle hooks
      if (definition.onResourceCreated) {
        await definition.onResourceCreated(testResource);
        expect(onResourceCreated).toHaveBeenCalledWith(testResource);
      }

      if (definition.onResourceDestroyed) {
        await definition.onResourceDestroyed(testResource);
        expect(onResourceDestroyed).toHaveBeenCalledWith(testResource);
      }

      if (definition.onResourceMigrated) {
        await definition.onResourceMigrated(testResource, 'node-1', 'node-2');
        expect(onResourceMigrated).toHaveBeenCalledWith(testResource, 'node-1', 'node-2');
      }
    });

    test('should handle serialization and deserialization', () => {
      const serialize = jest.fn((resource: ResourceMetadata) => ({
        id: resource.resourceId,
        type: resource.resourceType,
        data: resource.applicationData
      }));

      const deserialize = jest.fn((data: any) => ({
        resourceId: data.id,
        resourceType: data.type,
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 0, maximum: 100, unit: 'items' },
        performance: { latency: 0, throughput: 0, errorRate: 0 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: data.data,
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      }));

      const definition: ResourceTypeDefinition = {
        typeName: 'cache',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 1000, maxThroughput: 2000, avgLatency: 1 },
        capacityCalculator: () => 500,
        healthChecker: () => ResourceHealth.HEALTHY,
        performanceMetrics: ['hits', 'misses'],
        defaultDistributionStrategy: DistributionStrategy.CONSISTENT_HASH,
        distributionConstraints: [],
        serialize,
        deserialize
      };

      const testResource: ResourceMetadata = {
        resourceId: 'cache-1',
        resourceType: 'cache',
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 500, maximum: 1000, unit: 'entries' },
        performance: { latency: 1, throughput: 1500, errorRate: 0 },
        distribution: { shardCount: 3, replicationFactor: 1 },
        applicationData: { ttl: 3600, eviction: 'lru' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      // Test serialization
      const serialized = definition.serialize(testResource);
      expect(serialize).toHaveBeenCalledWith(testResource);
      expect(serialized).toEqual({
        id: 'cache-1',
        type: 'cache',
        data: { ttl: 3600, eviction: 'lru' }
      });

      // Test deserialization
      const deserialized = definition.deserialize(serialized);
      expect(deserialize).toHaveBeenCalledWith(serialized);
      expect(deserialized.resourceId).toBe('cache-1');
      expect(deserialized.resourceType).toBe('cache');
      expect(deserialized.applicationData).toEqual({ ttl: 3600, eviction: 'lru' });
    });
  });

  describe('Resource Capacity Interface', () => {
    test('should represent node capacity correctly', () => {
      const capacity: ResourceCapacity = {
        nodeId: 'node-1',
        resourceType: 'web-server',
        totalCapacity: 1000,
        availableCapacity: 750,
        reservedCapacity: 250,
        maxThroughput: 5000,
        avgLatency: 15,
        constraints: {
          memoryLimitMB: 2048,
          cpuLimitPercent: 80,
          networkBandwidthMbps: 1000,
          maxConcurrentOperations: 100
        },
        cost: {
          computeCost: 0.10,
          networkCost: 0.02,
          storageCost: 0.05
        }
      };

      expect(capacity.totalCapacity).toBe(1000);
      expect(capacity.availableCapacity).toBe(750);
      expect(capacity.reservedCapacity).toBe(250);
      expect(capacity.totalCapacity).toBe(capacity.availableCapacity + capacity.reservedCapacity);
      
      expect(capacity.constraints.memoryLimitMB).toBe(2048);
      expect(capacity.cost.computeCost).toBe(0.10);
    });

    test('should calculate utilization correctly', () => {
      const capacity: ResourceCapacity = {
        nodeId: 'node-2',
        resourceType: 'database',
        totalCapacity: 100,
        availableCapacity: 30,
        reservedCapacity: 70,
        maxThroughput: 200,
        avgLatency: 25,
        constraints: {},
        cost: { computeCost: 0, networkCost: 0, storageCost: 0 }
      };

      const utilizationPercent = (capacity.reservedCapacity / capacity.totalCapacity) * 100;
      expect(utilizationPercent).toBe(70);

      const availabilityPercent = (capacity.availableCapacity / capacity.totalCapacity) * 100;
      expect(availabilityPercent).toBe(30);
    });
  });
});
