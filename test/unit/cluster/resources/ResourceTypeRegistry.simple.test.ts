import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import { ResourceTypeRegistry } from '../../../../src/cluster/resources/ResourceTypeRegistry';
import { ResourceTypeDefinition, DistributionStrategy, ResourceHealth, ResourceMetadata } from '../../../../src/cluster/resources/types';

describe('ResourceTypeRegistry', () => {
  let registry: ResourceTypeRegistry;

  const sampleResourceType: ResourceTypeDefinition = {
    typeName: 'test-resource',
    version: '1.0.0',
    defaultCapacity: {
      totalCapacity: 100,
      maxThroughput: 50,
      avgLatency: 10
    },
    capacityCalculator: (resource) => 50,
    healthChecker: (resource) => ResourceHealth.HEALTHY,
    performanceMetrics: ['latency', 'throughput', 'errorRate'],
    defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
    distributionConstraints: [],
    serialize: (resource) => JSON.stringify(resource),
    deserialize: (data) => JSON.parse(data as string)
  };

  beforeEach(async () => {
    registry = new ResourceTypeRegistry();
    await registry.start();
  });

  afterEach(async () => {
    await registry.stop();
  });

  describe('Resource Type Registration', () => {
    test('should register a new resource type', () => {
      registry.registerResourceType(sampleResourceType);

      const retrievedType = registry.getResourceType('test-resource');
      expect(retrievedType).toEqual(sampleResourceType);
    });

    test('should throw error when registering duplicate resource type', () => {
      registry.registerResourceType(sampleResourceType);

      expect(() => {
        registry.registerResourceType(sampleResourceType);
      }).toThrow('Resource type \'test-resource\' is already registered');
    });

    test('should throw error when registering before start', async () => {
      const newRegistry = new ResourceTypeRegistry();
      // Don't call start()
      
      expect(() => {
        newRegistry.registerResourceType(sampleResourceType);
      }).toThrow('ResourceTypeRegistry is not started. Call start() first.');
      
      await newRegistry.stop();
    });

    test('should register multiple different resource types', () => {
      const anotherType: ResourceTypeDefinition = {
        ...sampleResourceType,
        typeName: 'another-resource',
        version: '2.0.0'
      };

      registry.registerResourceType(sampleResourceType);
      registry.registerResourceType(anotherType);

      expect(registry.getResourceType('test-resource')).toBeDefined();
      expect(registry.getResourceType('another-resource')).toBeDefined();
      expect(registry.getAllResourceTypes()).toHaveLength(2);
    });

    test('should emit event when resource type is registered', () => {
      const eventSpy = jest.fn();
      registry.on('resource-type:registered', eventSpy);

      registry.registerResourceType(sampleResourceType);

      expect(eventSpy).toHaveBeenCalledWith(sampleResourceType);
    });
  });

  describe('Resource Type Retrieval', () => {
    beforeEach(() => {
      registry.registerResourceType(sampleResourceType);
    });

    test('should retrieve registered resource type', () => {
      const retrieved = registry.getResourceType('test-resource');
      expect(retrieved).toEqual(sampleResourceType);
    });

    test('should return undefined for non-existent resource type', () => {
      const retrieved = registry.getResourceType('non-existent');
      expect(retrieved).toBeUndefined();
    });

    test('should check if resource type exists', () => {
      expect(registry.hasResourceType('test-resource')).toBe(true);
      expect(registry.hasResourceType('non-existent')).toBe(false);
    });

    test('should list all registered resource types', () => {
      const anotherType = {
        ...sampleResourceType,
        typeName: 'another-type'
      };
      registry.registerResourceType(anotherType);

      const allTypes = registry.getAllResourceTypes();
      expect(allTypes).toHaveLength(2);
      expect(allTypes.map(t => t.typeName)).toContain('test-resource');
      expect(allTypes.map(t => t.typeName)).toContain('another-type');
    });

    test('should filter resource types', () => {
      const v1Type = { ...sampleResourceType, typeName: 'v1-type', version: '1.0.0' };
      const v2Type = { ...sampleResourceType, typeName: 'v2-type', version: '2.0.0' };
      
      registry.registerResourceType(v1Type);
      registry.registerResourceType(v2Type);

      const v1Types = registry.getResourceTypesByFilter(def => def.version === '1.0.0');
      expect(v1Types).toHaveLength(2); // original + v1Type
      expect(v1Types.every(t => t.version === '1.0.0')).toBe(true);
    });
  });

  describe('Resource Type Unregistration', () => {
    beforeEach(() => {
      registry.registerResourceType(sampleResourceType);
    });

    test('should unregister existing resource type', () => {
      expect(registry.hasResourceType('test-resource')).toBe(true);
      
      const result = registry.unregisterResourceType('test-resource');
      
      expect(result).toBe(true);
      expect(registry.hasResourceType('test-resource')).toBe(false);
    });

    test('should return false when unregistering non-existent type', () => {
      const result = registry.unregisterResourceType('non-existent');
      expect(result).toBe(false);
    });

    test('should emit event when resource type is unregistered', () => {
      const eventSpy = jest.fn();
      registry.on('resource-type:unregistered', eventSpy);

      registry.unregisterResourceType('test-resource');

      expect(eventSpy).toHaveBeenCalledWith('test-resource');
    });
  });

  describe('Resource Type Operations via Definition', () => {
    beforeEach(() => {
      registry.registerResourceType(sampleResourceType);
    });

    test('should access capacity calculator from definition', () => {
      const resourceType = registry.getResourceType('test-resource');
      expect(resourceType).toBeDefined();
      
      const mockResource = { capacity: 75 };
      const result = resourceType!.capacityCalculator(mockResource);
      expect(result).toBe(50);
    });

    test('should access health checker from definition', () => {
      const resourceType = registry.getResourceType('test-resource');
      expect(resourceType).toBeDefined();
      
      const mockResource = {
        resourceId: 'test-1',
        resourceType: 'test-resource',
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 50, maximum: 100, unit: 'items' },
        performance: { latency: 10, throughput: 100, errorRate: 0.1 },
        distribution: {},
        applicationData: {},
        state: 'ACTIVE' as any,
        health: ResourceHealth.HEALTHY
      } as ResourceMetadata;
      
      const health = resourceType!.healthChecker(mockResource);
      expect(health).toBe(ResourceHealth.HEALTHY);
    });

    test('should access serialization methods from definition', () => {
      const resourceType = registry.getResourceType('test-resource');
      expect(resourceType).toBeDefined();
      
      const mockResource = {
        resourceId: 'test-1',
        resourceType: 'test-resource',
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 50, maximum: 100, unit: 'items' },
        performance: { latency: 10, throughput: 100, errorRate: 0.1 },
        distribution: {},
        applicationData: { data: 'sample' },
        state: 'ACTIVE' as any,
        health: ResourceHealth.HEALTHY
      } as ResourceMetadata;
      
      const serialized = resourceType!.serialize(mockResource);
      expect(typeof serialized).toBe('string');
      
      const deserialized = resourceType!.deserialize(serialized);
      expect(deserialized).toEqual(mockResource);
    });
  });

  describe('Registry Lifecycle', () => {
    test('should handle start and stop lifecycle', async () => {
      const newRegistry = new ResourceTypeRegistry();
      
      // Should not be able to register before start
      expect(() => {
        newRegistry.registerResourceType(sampleResourceType);
      }).toThrow();
      
      await newRegistry.start();
      
      // Should be able to register after start
      expect(() => {
        newRegistry.registerResourceType(sampleResourceType);
      }).not.toThrow();
      
      expect(newRegistry.hasResourceType('test-resource')).toBe(true);
      
      await newRegistry.stop();
      
      // After stop, registry should be cleared
      expect(newRegistry.hasResourceType('test-resource')).toBe(false);
    });

    test('should emit lifecycle events', async () => {
      const newRegistry = new ResourceTypeRegistry();
      const startSpy = jest.fn();
      const stopSpy = jest.fn();
      
      newRegistry.on('registry:started', startSpy);
      newRegistry.on('registry:stopped', stopSpy);
      
      await newRegistry.start();
      expect(startSpy).toHaveBeenCalled();
      
      await newRegistry.stop();
      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe('Advanced Resource Type Features', () => {
    test('should support optional lifecycle hooks in resource type definition', () => {
      const typeWithHooks: ResourceTypeDefinition = {
        ...sampleResourceType,
        typeName: 'hooks-resource',
        onResourceCreated: async (resource) => {
          // Optional lifecycle hook
        },
        onResourceDestroyed: async (resource) => {
          // Optional lifecycle hook  
        },
        onResourceMigrated: async (resource, fromNode, toNode) => {
          // Optional lifecycle hook
        }
      };

      expect(() => {
        registry.registerResourceType(typeWithHooks);
      }).not.toThrow();
      
      const retrieved = registry.getResourceType('hooks-resource');
      expect(retrieved?.onResourceCreated).toBeDefined();
      expect(retrieved?.onResourceDestroyed).toBeDefined();
      expect(retrieved?.onResourceMigrated).toBeDefined();
    });

    test('should support distribution constraints', () => {
      const complexConstraints = [
        {
          name: 'memoryRequirement',
          validator: (resource: any, targetNode: any, cluster: any) => true,
          weight: 0.9,
          description: 'Requires high-memory nodes'
        },
        {
          name: 'networkLatency',
          validator: (resource: any, targetNode: any, cluster: any) => true,
          weight: 0.7,
          description: 'Prefers low-latency connections'
        }
      ];

      const typeWithConstraints: ResourceTypeDefinition = {
        ...sampleResourceType,
        typeName: 'complex-resource',
        distributionConstraints: complexConstraints
      };

      expect(() => {
        registry.registerResourceType(typeWithConstraints);
      }).not.toThrow();
      
      const retrieved = registry.getResourceType('complex-resource');
      expect(retrieved?.distributionConstraints).toHaveLength(2);
      expect(retrieved?.distributionConstraints[0].weight).toBe(0.9);
    });

    test('should support different distribution strategies', () => {
      const strategies = [
        DistributionStrategy.ROUND_ROBIN,
        DistributionStrategy.LEAST_LOADED,
        DistributionStrategy.CONSISTENT_HASH,
        DistributionStrategy.AFFINITY_BASED,
        DistributionStrategy.COST_OPTIMIZED,
        DistributionStrategy.LATENCY_OPTIMIZED
      ];

      strategies.forEach((strategy, index) => {
        const typeWithStrategy: ResourceTypeDefinition = {
          ...sampleResourceType,
          typeName: `strategy-${index}`,
          defaultDistributionStrategy: strategy
        };

        expect(() => {
          registry.registerResourceType(typeWithStrategy);
        }).not.toThrow();

        const retrieved = registry.getResourceType(`strategy-${index}`);
        expect(retrieved?.defaultDistributionStrategy).toBe(strategy);
      });
    });

    test('should support custom performance metrics', () => {
      const customMetrics = ['customLatency', 'businessMetric', 'userSatisfaction'];
      
      const typeWithMetrics: ResourceTypeDefinition = {
        ...sampleResourceType,
        typeName: 'metrics-resource',
        performanceMetrics: customMetrics
      };

      expect(() => {
        registry.registerResourceType(typeWithMetrics);
      }).not.toThrow();

      const retrieved = registry.getResourceType('metrics-resource');
      expect(retrieved?.performanceMetrics).toEqual(customMetrics);
    });
  });
});
