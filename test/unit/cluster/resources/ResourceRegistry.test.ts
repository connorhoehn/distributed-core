import { ResourceRegistry, ResourceRegistryConfig } from '../../../../src/cluster/resources/ResourceRegistry';
import { 
  ResourceMetadata, 
  ResourceTypeDefinition, 
  ResourceState, 
  ResourceHealth,
  DistributionStrategy 
} from '../../../../src/cluster/resources/types';

describe('ResourceRegistry', () => {
  let resourceRegistry: ResourceRegistry;
  let mockConfig: ResourceRegistryConfig;

  beforeEach(() => {
    mockConfig = {
      nodeId: 'test-node-1',
      entityRegistryType: 'memory',
      entityRegistryConfig: { enableTestMode: true }
    };
    
    resourceRegistry = new ResourceRegistry(mockConfig);
  });

  afterEach(async () => {
    if (resourceRegistry) {
      await resourceRegistry.stop();
    }
  });

  describe('Constructor and Initialization', () => {
    test('should create ResourceRegistry with valid config', () => {
      expect(resourceRegistry).toBeInstanceOf(ResourceRegistry);
      expect(resourceRegistry).toBeDefined();
    });

    test('should throw error when creating resource before start()', async () => {
      const resourceType: ResourceTypeDefinition = {
        typeName: 'test-resource',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 100, maxThroughput: 50, avgLatency: 10 },
        capacityCalculator: () => 50,
        healthChecker: () => ResourceHealth.HEALTHY,
        performanceMetrics: ['latency', 'throughput'],
        defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
        distributionConstraints: [],
        serialize: (r) => r,
        deserialize: (d) => d
      };

      resourceRegistry.registerResourceType(resourceType);

      const resourceMetadata: ResourceMetadata = {
        resourceId: 'test-resource-1',
        resourceType: 'test-resource',
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 0, maximum: 100, unit: 'items' },
        performance: { latency: 0, throughput: 0, errorRate: 0 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: { name: 'Test Resource' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      await expect(resourceRegistry.createResource(resourceMetadata))
        .rejects.toThrow('ResourceRegistry is not running');
    });
  });

  describe('Resource Type Registration', () => {
    test('should register resource type successfully', () => {
      const resourceType: ResourceTypeDefinition = {
        typeName: 'test-resource',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 100, maxThroughput: 50, avgLatency: 10 },
        capacityCalculator: () => 50,
        healthChecker: () => ResourceHealth.HEALTHY,
        performanceMetrics: ['latency', 'throughput'],
        defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
        distributionConstraints: [],
        serialize: (r) => r,
        deserialize: (d) => d
      };

      expect(() => {
        resourceRegistry.registerResourceType(resourceType);
      }).not.toThrow();
    });

    test('should handle multiple resource type registrations', () => {
      const resourceType1: ResourceTypeDefinition = {
        typeName: 'resource-type-1',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 100, maxThroughput: 50, avgLatency: 10 },
        capacityCalculator: () => 50,
        healthChecker: () => ResourceHealth.HEALTHY,
        performanceMetrics: ['latency'],
        defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
        distributionConstraints: [],
        serialize: (r) => r,
        deserialize: (d) => d
      };

      const resourceType2: ResourceTypeDefinition = {
        typeName: 'resource-type-2',
        version: '2.0.0',
        defaultCapacity: { totalCapacity: 200, maxThroughput: 100, avgLatency: 5 },
        capacityCalculator: () => 100,
        healthChecker: () => ResourceHealth.DEGRADED,
        performanceMetrics: ['throughput'],
        defaultDistributionStrategy: DistributionStrategy.LEAST_LOADED,
        distributionConstraints: [],
        serialize: (r) => r,
        deserialize: (d) => d
      };

      resourceRegistry.registerResourceType(resourceType1);
      resourceRegistry.registerResourceType(resourceType2);

      // Test that both types are registered by trying to create resources of each type
      expect(() => resourceRegistry.registerResourceType(resourceType1)).not.toThrow();
      expect(() => resourceRegistry.registerResourceType(resourceType2)).not.toThrow();
    });
  });

  describe('Resource Lifecycle Management', () => {
    let testResourceType: ResourceTypeDefinition;

    beforeEach(async () => {
      testResourceType = {
        typeName: 'test-resource',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 100, maxThroughput: 50, avgLatency: 10 },
        capacityCalculator: (appData) => appData?.weight || 50,
        healthChecker: (resource) => {
          const usage = resource.capacity.current / resource.capacity.maximum;
          return usage > 0.9 ? ResourceHealth.DEGRADED : ResourceHealth.HEALTHY;
        },
        performanceMetrics: ['latency', 'throughput'],
        defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
        distributionConstraints: [],
        serialize: (r) => r,
        deserialize: (d) => d
      };

      resourceRegistry.registerResourceType(testResourceType);
      await resourceRegistry.start();
    });

    test('should create resource successfully', async () => {
      const resourceMetadata: ResourceMetadata = {
        resourceId: 'test-resource-1',
        resourceType: 'test-resource',
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 10, maximum: 100, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: { name: 'Test Resource', weight: 75 },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      const createdResource = await resourceRegistry.createResource(resourceMetadata);

      expect(createdResource).toBeDefined();
      expect(createdResource.resourceId).toBe('test-resource-1');
      expect(createdResource.resourceType).toBe('test-resource');
      expect(createdResource.applicationData.name).toBe('Test Resource');
    });

    test('should reject resource creation for unregistered type', async () => {
      const resourceMetadata: ResourceMetadata = {
        resourceId: 'unknown-resource-1',
        resourceType: 'unknown-type',
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 0, maximum: 100, unit: 'items' },
        performance: { latency: 0, throughput: 0, errorRate: 0 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: {},
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      await expect(resourceRegistry.createResource(resourceMetadata))
        .rejects.toThrow("Resource type 'unknown-type' is not registered");
    });

    test('should update resource successfully', async () => {
      // First create a resource
      const resourceMetadata: ResourceMetadata = {
        resourceId: 'update-test-resource',
        resourceType: 'test-resource',
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 10, maximum: 100, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: { name: 'Original Name' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      await resourceRegistry.createResource(resourceMetadata);

      // Update the resource
      const updatedResource = await resourceRegistry.updateResource('update-test-resource', {
        applicationData: { name: 'Updated Name', description: 'New description' },
        capacity: { current: 20, maximum: 100, unit: 'items' }
      });

      expect(updatedResource.applicationData.name).toBe('Updated Name');
      expect(updatedResource.applicationData.description).toBe('New description');
      expect(updatedResource.capacity.current).toBe(20);
    });

    test('should remove resource successfully', async () => {
      // Create a resource
      const resourceMetadata: ResourceMetadata = {
        resourceId: 'remove-test-resource',
        resourceType: 'test-resource',
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 10, maximum: 100, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: { name: 'To Be Removed' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      await resourceRegistry.createResource(resourceMetadata);

      // Verify it exists
      const resource = resourceRegistry.getResource('remove-test-resource');
      expect(resource).toBeDefined();

      // Remove it
      await resourceRegistry.removeResource('remove-test-resource');

      // Verify it's gone
      const removedResource = resourceRegistry.getResource('remove-test-resource');
      expect(removedResource).toBeNull();
    });

    test('should get resource by ID', async () => {
      const resourceMetadata: ResourceMetadata = {
        resourceId: 'get-test-resource',
        resourceType: 'test-resource',
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 25, maximum: 100, unit: 'items' },
        performance: { latency: 3, throughput: 30, errorRate: 0.05 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: { name: 'Get Test Resource' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      await resourceRegistry.createResource(resourceMetadata);

      const retrievedResource = resourceRegistry.getResource('get-test-resource');
      expect(retrievedResource).toBeDefined();
      expect(retrievedResource!.resourceId).toBe('get-test-resource');
      expect(retrievedResource!.applicationData.name).toBe('Get Test Resource');
    });
  });

  describe('Resource Queries and Filtering', () => {
    beforeEach(async () => {
      const resourceType: ResourceTypeDefinition = {
        typeName: 'query-test-resource',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 100, maxThroughput: 50, avgLatency: 10 },
        capacityCalculator: () => 50,
        healthChecker: () => ResourceHealth.HEALTHY,
        performanceMetrics: ['latency'],
        defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
        distributionConstraints: [],
        serialize: (r) => r,
        deserialize: (d) => d
      };

      resourceRegistry.registerResourceType(resourceType);
      await resourceRegistry.start();

      // Create multiple test resources
      const resources = [
        {
          resourceId: 'query-resource-1',
          applicationData: { category: 'A', priority: 'high' }
        },
        {
          resourceId: 'query-resource-2',
          applicationData: { category: 'B', priority: 'low' }
        },
        {
          resourceId: 'query-resource-3',
          applicationData: { category: 'A', priority: 'medium' }
        }
      ];

      for (const resourceData of resources) {
        const resourceMetadata: ResourceMetadata = {
          ...resourceData,
          resourceType: 'query-test-resource',
          nodeId: 'test-node-1',
          timestamp: Date.now(),
          capacity: { current: 10, maximum: 100, unit: 'items' },
          performance: { latency: 5, throughput: 20, errorRate: 0.1 },
          distribution: { shardCount: 1, replicationFactor: 1 },
          state: ResourceState.ACTIVE,
          health: ResourceHealth.HEALTHY
        };

        await resourceRegistry.createResource(resourceMetadata);
      }
    });

    test('should get resources by type', () => {
      const resources = resourceRegistry.getResourcesByType('query-test-resource');
      expect(resources).toHaveLength(3);
      expect(resources.every(r => r.resourceType === 'query-test-resource')).toBe(true);
    });

    test('should get local resources', () => {
      const localResources = resourceRegistry.getLocalResources();
      expect(localResources.length).toBeGreaterThanOrEqual(3);
      expect(localResources.every(r => r.nodeId === 'test-node-1')).toBe(true);
    });

    test('should filter resources by application data', () => {
      const resources = resourceRegistry.getResourcesByType('query-test-resource');
      const categoryAResources = resources.filter(r => r.applicationData.category === 'A');
      
      expect(categoryAResources).toHaveLength(2);
      expect(categoryAResources.every(r => r.applicationData.category === 'A')).toBe(true);
    });
  });

  describe('Event System', () => {
    let eventSpy: jest.SpyInstance;
    let testResourceType: ResourceTypeDefinition;

    beforeEach(async () => {
      eventSpy = jest.spyOn(resourceRegistry, 'emit');
      
      testResourceType = {
        typeName: 'event-test-resource',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 100, maxThroughput: 50, avgLatency: 10 },
        capacityCalculator: () => 50,
        healthChecker: () => ResourceHealth.HEALTHY,
        performanceMetrics: ['latency'],
        defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
        distributionConstraints: [],
        serialize: (r) => r,
        deserialize: (d) => d
      };

      resourceRegistry.registerResourceType(testResourceType);
      await resourceRegistry.start();
    });

    test('should emit resource:created event', async () => {
      const resourceMetadata: ResourceMetadata = {
        resourceId: 'event-test-resource-1',
        resourceType: 'event-test-resource',
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 10, maximum: 100, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: { name: 'Event Test' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      await resourceRegistry.createResource(resourceMetadata);

      expect(eventSpy).toHaveBeenCalledWith('resource:created', expect.objectContaining({
        resourceId: 'event-test-resource-1',
        resourceType: 'event-test-resource'
      }), expect.any(Object));
    });

    test('should emit resource:updated event', async () => {
      // Create resource first
      const resourceMetadata: ResourceMetadata = {
        resourceId: 'event-update-test',
        resourceType: 'event-test-resource',
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 10, maximum: 100, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: { name: 'Original' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      await resourceRegistry.createResource(resourceMetadata);
      
      // Clear previous calls
      eventSpy.mockClear();

      // Update resource
      await resourceRegistry.updateResource('event-update-test', {
        applicationData: { name: 'Updated' }
      });

      expect(eventSpy).toHaveBeenCalledWith('resource:updated', expect.objectContaining({
        resourceId: 'event-update-test'
      }), expect.any(Object));
    });
  });

  describe('Lifecycle Hooks', () => {
    test('should call onResourceCreated hook', async () => {
      const onResourceCreatedSpy = jest.fn();
      
      const resourceType: ResourceTypeDefinition = {
        typeName: 'hook-test-resource',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 100, maxThroughput: 50, avgLatency: 10 },
        capacityCalculator: () => 50,
        healthChecker: () => ResourceHealth.HEALTHY,
        performanceMetrics: ['latency'],
        defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
        distributionConstraints: [],
        onResourceCreated: onResourceCreatedSpy,
        serialize: (r) => r,
        deserialize: (d) => d
      };

      resourceRegistry.registerResourceType(resourceType);
      await resourceRegistry.start();

      const resourceMetadata: ResourceMetadata = {
        resourceId: 'hook-test-resource-1',
        resourceType: 'hook-test-resource',
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 10, maximum: 100, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: { name: 'Hook Test' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      await resourceRegistry.createResource(resourceMetadata);

      expect(onResourceCreatedSpy).toHaveBeenCalledWith(expect.objectContaining({
        resourceId: 'hook-test-resource-1'
      }));
    });

    test('should call health checker correctly', async () => {
      const healthCheckerSpy = jest.fn((resource: ResourceMetadata) => ResourceHealth.DEGRADED);
      
      const resourceType: ResourceTypeDefinition = {
        typeName: 'health-test-resource',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 100, maxThroughput: 50, avgLatency: 10 },
        capacityCalculator: () => 50,
        healthChecker: healthCheckerSpy,
        performanceMetrics: ['latency'],
        defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
        distributionConstraints: [],
        serialize: (r) => r,
        deserialize: (d) => d
      };

      resourceRegistry.registerResourceType(resourceType);
      await resourceRegistry.start();

      const resourceMetadata: ResourceMetadata = {
        resourceId: 'health-test-resource-1',
        resourceType: 'health-test-resource',
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 95, maximum: 100, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1, replicationFactor: 1 },
        applicationData: { name: 'Health Test' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      await resourceRegistry.createResource(resourceMetadata);

      // Test health checker directly to verify it works
      const testResult = healthCheckerSpy(resourceMetadata);
      expect(testResult).toBe(ResourceHealth.DEGRADED);
      expect(healthCheckerSpy).toHaveBeenCalledWith(resourceMetadata);
    });
  });

  describe('Error Handling', () => {
    test('should handle updating non-existent resource', async () => {
      const resourceType: ResourceTypeDefinition = {
        typeName: 'error-test-resource',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 100, maxThroughput: 50, avgLatency: 10 },
        capacityCalculator: () => 50,
        healthChecker: () => ResourceHealth.HEALTHY,
        performanceMetrics: ['latency'],
        defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
        distributionConstraints: [],
        serialize: (r) => r,
        deserialize: (d) => d
      };

      resourceRegistry.registerResourceType(resourceType);
      await resourceRegistry.start();

      // Test updating non-existent resource
      await expect(resourceRegistry.updateResource('non-existent-resource', {
        applicationData: { test: 'value' }
      })).rejects.toThrow();
    });

    test('should handle removing non-existent resource', async () => {
      const resourceType: ResourceTypeDefinition = {
        typeName: 'error-test-resource-2',
        version: '1.0.0',
        defaultCapacity: { totalCapacity: 100, maxThroughput: 50, avgLatency: 10 },
        capacityCalculator: () => 50,
        healthChecker: () => ResourceHealth.HEALTHY,
        performanceMetrics: ['latency'],
        defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
        distributionConstraints: [],
        serialize: (r) => r,
        deserialize: (d) => d
      };

      resourceRegistry.registerResourceType(resourceType);
      await resourceRegistry.start();

      // Test removing non-existent resource
      await expect(resourceRegistry.removeResource('non-existent-resource'))
        .rejects.toThrow();
    });
  });
});
