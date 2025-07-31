import { EntityRegistryFactory, EntityRegistryFactoryConfig } from '../../../src/cluster/entity/EntityRegistryFactory';
import { EntityRecord, EntityUpdate } from '../../../src/cluster/entity/types';

describe('EntityRegistry Unit Tests', () => {
  // Set timeout for all tests to prevent hanging
  jest.setTimeout(10000);

  describe('InMemoryEntityRegistry', () => {
    let registry: any;

    beforeEach(async () => {
      registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
      await registry.start();
    });

    afterEach(async () => {
      if (registry) {
        await registry.stop();
        registry = null;
      }
    });

    it('should create and retrieve entities', async () => {
      const metadata = { type: 'room', region: 'us-east-1' };
      const entity = await registry.proposeEntity('entity-1', metadata);

      expect(entity.entityId).toBe('entity-1');
      expect(entity.ownerNodeId).toBe('node-1');
      expect(entity.version).toBe(1);
      expect(entity.metadata).toEqual(metadata);

      const retrieved = registry.getEntity('entity-1');
      expect(retrieved).toEqual(entity);

      const host = registry.getEntityHost('entity-1');
      expect(host).toBe('node-1');
    });

    it('should prevent duplicate entity creation', async () => {
      await registry.proposeEntity('entity-1');
      
      await expect(registry.proposeEntity('entity-1'))
        .rejects.toThrow('Entity entity-1 already exists');
    });

    it('should update entity metadata', async () => {
      const entity = await registry.proposeEntity('entity-1', { type: 'room' });
      
      // Small delay to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const updated = await registry.updateEntity('entity-1', { status: 'active' });
      
      expect(updated.version).toBe(2);
      expect(updated.metadata).toEqual({ type: 'room', status: 'active' });
      expect(updated.lastUpdated).toBeGreaterThanOrEqual(entity.lastUpdated);
    });

    it('should transfer entity ownership', async () => {
      const entity = await registry.proposeEntity('entity-1');
      
      const transferred = await registry.transferEntity('entity-1', 'node-2');
      
      expect(transferred.ownerNodeId).toBe('node-2');
      expect(transferred.version).toBe(2);
    });

    it('should release entities', async () => {
      await registry.proposeEntity('entity-1');
      
      await registry.releaseEntity('entity-1');
      
      expect(registry.getEntity('entity-1')).toBeNull();
      expect(registry.getEntityHost('entity-1')).toBeNull();
    });

    it('should filter entities by owner', async () => {
      await registry.proposeEntity('entity-1');
      
      // Simulate remote entity
      const remoteUpdate: EntityUpdate = {
        entityId: 'entity-2',
        ownerNodeId: 'node-2',
        version: 1,
        timestamp: Date.now(),
        operation: 'CREATE',
        metadata: { type: 'remote' }
      };
      await registry.applyRemoteUpdate(remoteUpdate);

      const localEntities = registry.getLocalEntities();
      expect(localEntities).toHaveLength(1);
      expect(localEntities[0].entityId).toBe('entity-1');

      const allEntities = registry.getAllKnownEntities();
      expect(allEntities).toHaveLength(2);

      const node2Entities = registry.getEntitiesByNode('node-2');
      expect(node2Entities).toHaveLength(1);
      expect(node2Entities[0].entityId).toBe('entity-2');
    });

    it('should emit events for entity lifecycle', async () => {
      const createdSpy = jest.fn();
      const updatedSpy = jest.fn();
      const transferredSpy = jest.fn();
      const deletedSpy = jest.fn();

      registry.on('entity:created', createdSpy);
      registry.on('entity:updated', updatedSpy);
      registry.on('entity:transferred', transferredSpy);
      registry.on('entity:deleted', deletedSpy);

      // Test creation
      const entity = await registry.proposeEntity('entity-1');
      expect(createdSpy).toHaveBeenCalledWith(entity);

      // Test update
      const updated = await registry.updateEntity('entity-1', { status: 'active' });
      expect(updatedSpy).toHaveBeenCalledWith(updated);

      // Test transfer
      const transferred = await registry.transferEntity('entity-1', 'node-2');
      expect(transferredSpy).toHaveBeenCalledWith(transferred);

      // Test deletion - create a new entity owned by this node
      const ownedEntity = await registry.proposeEntity('entity-2');
      await registry.releaseEntity('entity-2');
      expect(deletedSpy).toHaveBeenCalledWith(ownedEntity);
    });

    it('should handle snapshots', async () => {
      await registry.proposeEntity('entity-1', { type: 'room' });
      await registry.proposeEntity('entity-2', { type: 'chat' });

      const snapshot = registry.exportSnapshot();
      expect(snapshot.nodeId).toBe('node-1');
      expect(Object.keys(snapshot.entities)).toHaveLength(2);

      // Create new registry and import snapshot
      const newRegistry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
      await newRegistry.start();
      await newRegistry.importSnapshot(snapshot);

      expect(newRegistry.getAllKnownEntities()).toHaveLength(2);
      
      const entity1 = newRegistry.getEntity('entity-1');
      expect(entity1).toBeTruthy();
      if (entity1 && entity1.metadata) {
        expect(entity1.metadata.type).toBe('room');
      }
      
      const entity2 = newRegistry.getEntity('entity-2');
      expect(entity2).toBeTruthy();
      if (entity2 && entity2.metadata) {
        expect(entity2.metadata.type).toBe('chat');
      }

      await newRegistry.stop();
    });

    it('should handle concurrent operations safely', async () => {
      const promises = [];
      
      // Create multiple entities concurrently
      for (let i = 0; i < 10; i++) {
        promises.push(registry.proposeEntity(`entity-${i}`, { index: i }));
      }

      const entities = await Promise.all(promises);
      expect(entities).toHaveLength(10);
      expect(registry.getAllKnownEntities()).toHaveLength(10);

      // Update them concurrently
      const updatePromises = entities.map(entity => 
        registry.updateEntity(entity.entityId, { updated: true })
      );

      const updated = await Promise.all(updatePromises);
      expect(updated.every(e => e.metadata && e.metadata.updated)).toBe(true);
    });
  });

  describe('EntityRegistryFactory', () => {
    it('should create different registry types', async () => {
      const memoryRegistry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
      expect(memoryRegistry).toBeDefined();

      const walRegistry = EntityRegistryFactory.createWAL('node-1', { 
        filePath: './test.wal',
        syncInterval: 0 // Disable timer to prevent open handles in tests
      });
      expect(walRegistry).toBeDefined();
      // Clean up the WAL registry to prevent timer leaks
      await walRegistry.stop();

      const factoryConfig: EntityRegistryFactoryConfig = {
        type: 'memory',
        nodeId: 'node-1',
        logConfig: { enableTestMode: true }
      };
      const factoryRegistry = EntityRegistryFactory.create(factoryConfig);
      expect(factoryRegistry).toBeDefined();
    });

    it('should reject unknown registry types', () => {
      const config: EntityRegistryFactoryConfig = {
        type: 'unknown' as any,
        nodeId: 'node-1'
      };
      
      expect(() => EntityRegistryFactory.create(config))
        .toThrow('Unknown entity registry type: unknown');
    });

    it('should reject unimplemented registry types', () => {
      const etcdConfig: EntityRegistryFactoryConfig = {
        type: 'etcd',
        nodeId: 'node-1'
      };
      
      expect(() => EntityRegistryFactory.create(etcdConfig))
        .toThrow('EtcdEntityRegistry not implemented yet');
    });
  });

  describe('Remote Updates and Synchronization', () => {
    let registry1: any;
    let registry2: any;

    beforeEach(async () => {
      registry1 = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
      registry2 = EntityRegistryFactory.createMemory('node-2', { enableTestMode: true });
      await registry1.start();
      await registry2.start();
    });

    afterEach(async () => {
      if (registry1) {
        await registry1.stop();
        registry1 = null;
      }
      if (registry2) {
        await registry2.stop();
        registry2 = null;
      }
    });

    it('should synchronize entities between registries', async () => {
      // Create entity on registry1
      const entity1 = await registry1.proposeEntity('entity-1', { type: 'room' });

      // Simulate propagation to registry2
      const update: EntityUpdate = {
        entityId: entity1.entityId,
        ownerNodeId: entity1.ownerNodeId,
        version: entity1.version,
        timestamp: entity1.createdAt,
        operation: 'CREATE',
        metadata: entity1.metadata
      };

      const applied = await registry2.applyRemoteUpdate(update);
      expect(applied).toBe(true);

      // Verify entity exists on registry2
      const entity2 = registry2.getEntity('entity-1');
      expect(entity2).toEqual(entity1);
    });

    it('should handle version conflicts correctly', async () => {
      // Create entity on both registries
      await registry1.proposeEntity('entity-1', { source: 'node-1' });
      await registry2.proposeEntity('entity-1', { source: 'node-2' });

      // Try to apply older version - should be ignored
      const olderUpdate: EntityUpdate = {
        entityId: 'entity-1',
        ownerNodeId: 'node-2',
        version: 0, // Older version
        timestamp: Date.now(),
        operation: 'UPDATE',
        metadata: { old: true }
      };

      await registry1.applyRemoteUpdate(olderUpdate);
      
      const entity = registry1.getEntity('entity-1');
      if (entity && entity.metadata) {
        expect(entity.metadata.source).toBe('node-1');
        expect(entity.metadata.old).toBeUndefined();
      }
    });

    it('should apply newer versions correctly', async () => {
      await registry1.proposeEntity('entity-1', { version: 1 });

      const newerUpdate: EntityUpdate = {
        entityId: 'entity-1',
        ownerNodeId: 'node-2',
        version: 5, // Much newer version
        timestamp: Date.now(),
        operation: 'UPDATE',
        metadata: { newer: true }
      };

      await registry1.applyRemoteUpdate(newerUpdate);
      
      const entity = registry1.getEntity('entity-1');
      if (entity && entity.metadata) {
        expect(entity.version).toBe(5);
        expect(entity.metadata.newer).toBe(true);
      }
    });
  });
});
