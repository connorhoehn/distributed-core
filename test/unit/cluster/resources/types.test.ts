import {
  ResourceMetadata,
  ResourceState,
  ResourceHealth,
  ResourceTypeDefinition,
  ResourceCapacity
} from '../../../../src/resources/types';

describe('Resource Types', () => {
  describe('ResourceMetadata', () => {
    test('should create valid ResourceMetadata', () => {
      const resource: ResourceMetadata = {
        id: 'test-id-1',
        resourceId: 'test-resource-1',
        type: 'test',
        resourceType: 'test-type',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: {
          current: 50,
          maximum: 100,
          reserved: 0,
          unit: 'requests'
        },
        performance: {
          latency: 25,
          throughput: 1000,
          errorRate: 0.01
        },
        distribution: {
          shardCount: 2,
          preferredNodes: ['node-1', 'node-2']
        },
        applicationData: {
          name: 'Test Resource',
          priority: 'high'
        },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      expect(resource.resourceId).toBe('test-resource-1');
      expect(resource.capacity!.current).toBe(50);
      expect(resource.performance.latency).toBe(25);
      expect(resource.state).toBe(ResourceState.ACTIVE);
      expect(resource.health).toBe(ResourceHealth.HEALTHY);
    });

    test('should handle different capacity units', () => {
      const memoryResource: ResourceMetadata = {
        id: 'mem-id',
        resourceId: 'memory-resource',
        type: 'memory',
        resourceType: 'memory-pool',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 512, maximum: 1024, reserved: 0, unit: 'MB' },
        performance: { latency: 1, throughput: 10000, errorRate: 0 },
        distribution: { shardCount: 1 },
        applicationData: {},
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      const connectionResource: ResourceMetadata = {
        id: 'conn-id',
        resourceId: 'connection-pool',
        type: 'connection',
        resourceType: 'connection-pool',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 25, maximum: 100, reserved: 0, unit: 'connections' },
        performance: { latency: 5, throughput: 500, errorRate: 0.001 },
        distribution: { shardCount: 1 },
        applicationData: {},
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      expect(memoryResource.capacity!.unit).toBe('MB');
      expect(connectionResource.capacity!.unit).toBe('connections');
    });
  });

  describe('ResourceState Enum', () => {
    test('should have all required states', () => {
      expect(ResourceState.INITIALIZING).toBe('initializing');
      expect(ResourceState.ACTIVE).toBe('active');
      expect(ResourceState.SCALING).toBe('scaling');
      expect(ResourceState.MIGRATING).toBe('migrating');
      expect(ResourceState.INACTIVE).toBe('inactive');
      expect(ResourceState.PENDING).toBe('pending');
      expect(ResourceState.TERMINATING).toBe('terminating');
      expect(ResourceState.ERROR).toBe('error');
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
      expect(ResourceHealth.HEALTHY).toBe('healthy');
      expect(ResourceHealth.DEGRADED).toBe('degraded');
      expect(ResourceHealth.UNHEALTHY).toBe('unhealthy');
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

  describe('ResourceTypeDefinition', () => {
    test('should create valid ResourceTypeDefinition', () => {
      const onResourceCreated = jest.fn();

      const definition: ResourceTypeDefinition = {
        name: 'Test Resource Type',
        typeName: 'test-resource-type',
        version: '1.2.0',
        schema: { type: 'object' },
        constraints: {},
        onResourceCreated,
      };

      expect(definition.typeName).toBe('test-resource-type');
      expect(definition.version).toBe('1.2.0');
      expect(definition.name).toBe('Test Resource Type');
    });

    test('should handle lifecycle hooks', async () => {
      const onResourceCreated = jest.fn();
      const onResourceDestroyed = jest.fn();
      const onResourceMigrated = jest.fn();

      const definition: ResourceTypeDefinition = {
        name: 'database',
        typeName: 'database',
        version: '1.0.0',
        schema: {},
        onResourceCreated,
        onResourceDestroyed,
        onResourceMigrated,
      };

      const testResource: ResourceMetadata = {
        id: 'db-id',
        resourceId: 'db-1',
        type: 'database',
        resourceType: 'database',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 100, maximum: 1000, reserved: 0, unit: 'queries' },
        performance: { latency: 20, throughput: 50, errorRate: 0.001 },
        distribution: { shardCount: 1 },
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
  });

  describe('Resource Capacity Interface', () => {
    test('should represent resource capacity correctly', () => {
      const capacity: ResourceCapacity = {
        current: 750,
        maximum: 1000,
        reserved: 250,
        unit: 'requests'
      };

      expect(capacity.current).toBe(750);
      expect(capacity.maximum).toBe(1000);
      expect(capacity.reserved).toBe(250);
      expect(capacity.unit).toBe('requests');
    });

    test('should calculate utilization correctly', () => {
      const capacity: ResourceCapacity = {
        current: 30,
        maximum: 100,
        reserved: 70,
      };

      const utilizationPercent = (capacity.reserved / capacity.maximum) * 100;
      expect(utilizationPercent).toBe(70);

      const availabilityPercent = (capacity.current / capacity.maximum) * 100;
      expect(availabilityPercent).toBe(30);
    });
  });
});
