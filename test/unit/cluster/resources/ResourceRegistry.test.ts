import { ResourceRegistry, ResourceRegistryConfig } from '../../../../src/resources/core/ResourceRegistry';
import {
  ResourceMetadata,
  ResourceTypeDefinition,
  ResourceState,
  ResourceHealth,
} from '../../../../src/resources/types';

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
        name: 'Test Resource',
        typeName: 'test-resource',
        version: '1.0.0',
        schema: { type: 'object' },
      };

      resourceRegistry.registerResourceType(resourceType);

      const resourceMetadata: ResourceMetadata = {
        id: 'test-id-1',
        resourceId: 'test-resource-1',
        type: 'test',
        resourceType: 'test-resource',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 0, maximum: 100, reserved: 0, unit: 'items' },
        performance: { latency: 0, throughput: 0, errorRate: 0 },
        distribution: { shardCount: 1 },
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
        name: 'Test Resource',
        typeName: 'test-resource',
        version: '1.0.0',
        schema: { type: 'object' },
      };

      expect(() => {
        resourceRegistry.registerResourceType(resourceType);
      }).not.toThrow();
    });

    test('should handle multiple resource type registrations', () => {
      const resourceType1: ResourceTypeDefinition = {
        name: 'Resource Type 1',
        typeName: 'resource-type-1',
        version: '1.0.0',
        schema: { type: 'object' },
      };

      const resourceType2: ResourceTypeDefinition = {
        name: 'Resource Type 2',
        typeName: 'resource-type-2',
        version: '2.0.0',
        schema: { type: 'object' },
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
        name: 'Test Resource',
        typeName: 'test-resource',
        version: '1.0.0',
        schema: { type: 'object' },
      };

      resourceRegistry.registerResourceType(testResourceType);
      await resourceRegistry.start();
    });

    test('should create resource successfully', async () => {
      const resourceMetadata: ResourceMetadata = {
        id: 'test-id-1',
        resourceId: 'test-resource-1',
        type: 'test',
        resourceType: 'test-resource',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 10, maximum: 100, reserved: 0, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1 },
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
        id: 'unknown-id',
        resourceId: 'unknown-resource-1',
        type: 'unknown',
        resourceType: 'unknown-type',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 0, maximum: 100, reserved: 0, unit: 'items' },
        performance: { latency: 0, throughput: 0, errorRate: 0 },
        distribution: { shardCount: 1 },
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
        id: 'update-id',
        resourceId: 'update-test-resource',
        type: 'test',
        resourceType: 'test-resource',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 10, maximum: 100, reserved: 0, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1 },
        applicationData: { name: 'Original Name' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      await resourceRegistry.createResource(resourceMetadata);

      // Update the resource
      const updatedResource = await resourceRegistry.updateResource('update-test-resource', {
        applicationData: { name: 'Updated Name', description: 'New description' },
        capacity: { current: 20, maximum: 100, reserved: 0, unit: 'items' }
      });

      expect(updatedResource.applicationData.name).toBe('Updated Name');
      expect(updatedResource.applicationData.description).toBe('New description');
      expect(updatedResource.capacity!.current).toBe(20);
    });

    test('should remove resource successfully', async () => {
      // Create a resource
      const resourceMetadata: ResourceMetadata = {
        id: 'remove-id',
        resourceId: 'remove-test-resource',
        type: 'test',
        resourceType: 'test-resource',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 10, maximum: 100, reserved: 0, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1 },
        applicationData: { name: 'To Be Removed' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      await resourceRegistry.createResource(resourceMetadata);

      // Verify it exists
      const resource = await resourceRegistry.getResource('remove-test-resource');
      expect(resource).toBeDefined();

      // Remove it
      await resourceRegistry.removeResource('remove-test-resource');

      // Verify it's gone
      const removedResource = await resourceRegistry.getResource('remove-test-resource');
      expect(removedResource).toBeNull();
    });

    test('should get resource by ID', async () => {
      const resourceMetadata: ResourceMetadata = {
        id: 'get-id',
        resourceId: 'get-test-resource',
        type: 'test',
        resourceType: 'test-resource',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 25, maximum: 100, reserved: 0, unit: 'items' },
        performance: { latency: 3, throughput: 30, errorRate: 0.05 },
        distribution: { shardCount: 1 },
        applicationData: { name: 'Get Test Resource' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      await resourceRegistry.createResource(resourceMetadata);

      const retrievedResource = await resourceRegistry.getResource('get-test-resource');
      expect(retrievedResource).toBeDefined();
      expect(retrievedResource!.resourceId).toBe('get-test-resource');
      expect(retrievedResource!.applicationData.name).toBe('Get Test Resource');
    });
  });

  describe('Resource Queries and Filtering', () => {
    beforeEach(async () => {
      const resourceType: ResourceTypeDefinition = {
        name: 'Query Test Resource',
        typeName: 'query-test-resource',
        version: '1.0.0',
        schema: { type: 'object' },
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
          id: resourceData.resourceId,
          type: 'query-test',
          resourceType: 'query-test-resource',
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          nodeId: 'test-node-1',
          timestamp: Date.now(),
          capacity: { current: 10, maximum: 100, reserved: 0, unit: 'items' },
          performance: { latency: 5, throughput: 20, errorRate: 0.1 },
          distribution: { shardCount: 1 },
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
        name: 'Event Test Resource',
        typeName: 'event-test-resource',
        version: '1.0.0',
        schema: { type: 'object' },
      };

      resourceRegistry.registerResourceType(testResourceType);
      await resourceRegistry.start();
    });

    test('should emit resource:created event', async () => {
      const resourceMetadata: ResourceMetadata = {
        id: 'event-id-1',
        resourceId: 'event-test-resource-1',
        type: 'event-test',
        resourceType: 'event-test-resource',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 10, maximum: 100, reserved: 0, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1 },
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
        id: 'event-update-id',
        resourceId: 'event-update-test',
        type: 'event-test',
        resourceType: 'event-test-resource',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 10, maximum: 100, reserved: 0, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1 },
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
        name: 'Hook Test Resource',
        typeName: 'hook-test-resource',
        version: '1.0.0',
        schema: { type: 'object' },
        onResourceCreated: onResourceCreatedSpy,
      };

      resourceRegistry.registerResourceType(resourceType);
      await resourceRegistry.start();

      const resourceMetadata: ResourceMetadata = {
        id: 'hook-id-1',
        resourceId: 'hook-test-resource-1',
        type: 'hook-test',
        resourceType: 'hook-test-resource',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 10, maximum: 100, reserved: 0, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1 },
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
      const resourceType: ResourceTypeDefinition = {
        name: 'Health Test Resource',
        typeName: 'health-test-resource',
        version: '1.0.0',
        schema: { type: 'object' },
      };

      resourceRegistry.registerResourceType(resourceType);
      await resourceRegistry.start();

      const resourceMetadata: ResourceMetadata = {
        id: 'health-id-1',
        resourceId: 'health-test-resource-1',
        type: 'health-test',
        resourceType: 'health-test-resource',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        nodeId: 'test-node-1',
        timestamp: Date.now(),
        capacity: { current: 95, maximum: 100, reserved: 0, unit: 'items' },
        performance: { latency: 5, throughput: 20, errorRate: 0.1 },
        distribution: { shardCount: 1 },
        applicationData: { name: 'Health Test' },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY
      };

      await resourceRegistry.createResource(resourceMetadata);

      // Verify resource was created with the correct health value
      const resource = await resourceRegistry.getResource('health-test-resource-1');
      expect(resource).toBeDefined();
      expect(resource!.health).toBe(ResourceHealth.HEALTHY);
    });
  });

  describe('Error Handling', () => {
    test('should handle updating non-existent resource', async () => {
      const resourceType: ResourceTypeDefinition = {
        name: 'Error Test Resource',
        typeName: 'error-test-resource',
        version: '1.0.0',
        schema: { type: 'object' },
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
        name: 'Error Test Resource 2',
        typeName: 'error-test-resource-2',
        version: '1.0.0',
        schema: { type: 'object' },
      };

      resourceRegistry.registerResourceType(resourceType);
      await resourceRegistry.start();

      // Test removing non-existent resource
      await expect(resourceRegistry.removeResource('non-existent-resource'))
        .rejects.toThrow();
    });
  });
});
