import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import { ResourceTypeRegistry } from '../../../../src/resources/core/ResourceTypeRegistry';
import { ResourceTypeDefinition, ResourceHealth, ResourceMetadata } from '../../../../src/resources/types';

describe('ResourceTypeRegistry', () => {
  let registry: ResourceTypeRegistry;

  const sampleResourceType: ResourceTypeDefinition = {
    name: 'Test Resource',
    typeName: 'test-resource',
    version: '1.0.0',
    schema: { type: 'object' },
    onResourceCreated: async (resource: ResourceMetadata) => {},
    onResourceDestroyed: async (resource: ResourceMetadata) => {},
    onResourceMigrated: async (resource: ResourceMetadata, fromNode: string, toNode: string) => {},
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

    test('should access lifecycle hooks from definition', () => {
      const resourceType = registry.getResourceType('test-resource');
      expect(resourceType).toBeDefined();
      expect(resourceType!.onResourceCreated).toBeDefined();
      expect(resourceType!.onResourceDestroyed).toBeDefined();
      expect(resourceType!.onResourceMigrated).toBeDefined();
    });

    test('should access schema from definition', () => {
      const resourceType = registry.getResourceType('test-resource');
      expect(resourceType).toBeDefined();
      expect(resourceType!.schema).toEqual({ type: 'object' });
    });

    test('should access version from definition', () => {
      const resourceType = registry.getResourceType('test-resource');
      expect(resourceType).toBeDefined();
      expect(resourceType!.version).toBe('1.0.0');
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

    test('should support constraints in resource type definition', () => {
      const complexConstraints = {
        memoryRequirement: 'high',
        networkLatency: 'low'
      };

      const typeWithConstraints: ResourceTypeDefinition = {
        ...sampleResourceType,
        typeName: 'complex-resource',
        constraints: complexConstraints
      };

      expect(() => {
        registry.registerResourceType(typeWithConstraints);
      }).not.toThrow();

      const retrieved = registry.getResourceType('complex-resource');
      expect(retrieved?.constraints).toEqual(complexConstraints);
      expect(retrieved?.constraints.memoryRequirement).toBe('high');
    });

    test('should support different versions', () => {
      const versions = ['1.0.0', '2.0.0', '3.0.0'];

      versions.forEach((version, index) => {
        const typeWithVersion: ResourceTypeDefinition = {
          ...sampleResourceType,
          typeName: `version-${index}`,
          version
        };

        expect(() => {
          registry.registerResourceType(typeWithVersion);
        }).not.toThrow();

        const retrieved = registry.getResourceType(`version-${index}`);
        expect(retrieved?.version).toBe(version);
      });
    });

    test('should support custom schema definitions', () => {
      const customSchema = { type: 'object', properties: { metric1: 'number', metric2: 'string' } };

      const typeWithSchema: ResourceTypeDefinition = {
        ...sampleResourceType,
        typeName: 'schema-resource',
        schema: customSchema
      };

      expect(() => {
        registry.registerResourceType(typeWithSchema);
      }).not.toThrow();

      const retrieved = registry.getResourceType('schema-resource');
      expect(retrieved?.schema).toEqual(customSchema);
    });
  });
});
