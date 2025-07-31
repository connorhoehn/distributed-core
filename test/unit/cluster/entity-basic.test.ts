import { EntityRegistryFactory } from '../../../src/cluster/entity/EntityRegistryFactory';

describe('Entity Registry Basic Tests', () => {
  describe('InMemoryEntityRegistry', () => {
    let registry: any;

    beforeEach(async () => {
      registry = EntityRegistryFactory.createMemory('node-1');
      await registry.start();
    });

    afterEach(async () => {
      await registry.stop();
    });

    it('should create a memory registry', () => {
      expect(registry).toBeDefined();
      expect(registry.nodeId).toBe('node-1');
    });

    it('should create and retrieve an entity', async () => {
      const entity = await registry.proposeEntity('test-entity', { type: 'test' });
      
      expect(entity.entityId).toBe('test-entity');
      expect(entity.ownerNodeId).toBe('node-1');
      expect(entity.version).toBe(1);

      const retrieved = registry.getEntity('test-entity');
      expect(retrieved).toEqual(entity);
    });

    it('should get entity host', async () => {
      await registry.proposeEntity('test-entity');
      const host = registry.getEntityHost('test-entity');
      expect(host).toBe('node-1');
    });

    it('should list local entities', async () => {
      await registry.proposeEntity('entity-1');
      await registry.proposeEntity('entity-2');

      const locals = registry.getLocalEntities();
      expect(locals).toHaveLength(2);
    });
  });

  describe('EntityRegistryFactory', () => {
    it('should create memory registry', () => {
      const registry = EntityRegistryFactory.createMemory('node-1');
      expect(registry).toBeDefined();
    });

    it('should create WAL registry', () => {
      const registry = EntityRegistryFactory.createWAL('node-1', { filePath: './test.wal' });
      expect(registry).toBeDefined();
    });
  });
});
