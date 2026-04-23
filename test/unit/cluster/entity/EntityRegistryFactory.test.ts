/**
 * EntityRegistryFactory unit tests.
 *
 * Strategy for WAL registry: the WriteAheadLogEntityRegistry constructor
 * instantiates WALWriterImpl / WALReaderImpl internally, but it does NOT call
 * start() itself, so no file I/O happens during construction.  We can safely
 * create the instance and verify its class identity without mocking anything.
 *
 * For the unsupported-type branches we just verify the expected Error is thrown
 * synchronously (no awaiting needed, create() is synchronous).
 */

import { EntityRegistryFactory, EntityRegistryFactoryConfig } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { InMemoryEntityRegistry } from '../../../../src/cluster/entity/InMemoryEntityRegistry';
import { WriteAheadLogEntityRegistry } from '../../../../src/cluster/entity/WriteAheadLogEntityRegistry';
import { CrdtEntityRegistry } from '../../../../src/cluster/entity/CrdtEntityRegistry';

jest.setTimeout(10000);

describe('EntityRegistryFactory', () => {
  // ---------------------------------------------------------------------------
  // Supported types
  // ---------------------------------------------------------------------------

  describe('type: memory', () => {
    it('returns an InMemoryEntityRegistry instance', () => {
      const config: EntityRegistryFactoryConfig = {
        type: 'memory',
        nodeId: 'node-1',
        logConfig: { enableTestMode: true },
      };

      const registry = EntityRegistryFactory.create(config);

      expect(registry).toBeInstanceOf(InMemoryEntityRegistry);
    });

    it('createMemory() convenience method also returns InMemoryEntityRegistry', () => {
      const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
      expect(registry).toBeInstanceOf(InMemoryEntityRegistry);
    });

    it('passes nodeId through to the created registry', async () => {
      const registry = EntityRegistryFactory.createMemory('my-special-node', {
        enableTestMode: true,
      }) as InMemoryEntityRegistry;

      await registry.start();

      // Confirm the nodeId is used: propose an entity and check ownerNodeId
      const entity = await registry.proposeEntity('probe');
      expect(entity.ownerNodeId).toBe('my-special-node');

      await registry.stop();
    });
  });

  describe('type: wal', () => {
    let walRegistry: WriteAheadLogEntityRegistry | null = null;

    afterEach(async () => {
      // Always stop the WAL registry to prevent open handles / timers
      if (walRegistry) {
        await walRegistry.stop().catch(() => {/* ignore stop errors in cleanup */});
        walRegistry = null;
      }
    });

    it('returns a WriteAheadLogEntityRegistry instance', () => {
      const config: EntityRegistryFactoryConfig = {
        type: 'wal',
        nodeId: 'node-wal',
        walConfig: {
          filePath: '/tmp/test-factory.wal',
          syncInterval: 0, // disable sync timer to prevent open handles
        },
      };

      const registry = EntityRegistryFactory.create(config);
      walRegistry = registry as WriteAheadLogEntityRegistry;

      expect(registry).toBeInstanceOf(WriteAheadLogEntityRegistry);
    });

    it('createWAL() convenience method also returns WriteAheadLogEntityRegistry', () => {
      const registry = EntityRegistryFactory.createWAL('node-wal', {
        filePath: '/tmp/test-factory-convenience.wal',
        syncInterval: 0,
      });
      walRegistry = registry as WriteAheadLogEntityRegistry;

      expect(registry).toBeInstanceOf(WriteAheadLogEntityRegistry);
    });
  });

  describe('type: crdt', () => {
    it('returns a CrdtEntityRegistry instance', () => {
      const config: EntityRegistryFactoryConfig = {
        type: 'crdt',
        nodeId: 'node-crdt',
      };

      const registry = EntityRegistryFactory.create(config);

      expect(registry).toBeInstanceOf(CrdtEntityRegistry);
    });

    it('passes nodeId through: created entity is owned by the correct node', async () => {
      const config: EntityRegistryFactoryConfig = {
        type: 'crdt',
        nodeId: 'crdt-owner',
      };

      const registry = EntityRegistryFactory.create(config) as CrdtEntityRegistry;
      await registry.start();

      const entity = await registry.proposeEntity('probe-crdt');
      expect(entity.ownerNodeId).toBe('crdt-owner');

      await registry.stop();
    });
  });

  // ---------------------------------------------------------------------------
  // Unsupported / unimplemented types
  // ---------------------------------------------------------------------------

  describe('unknown type', () => {
    it('throws for an unrecognised type', () => {
      const config = { type: 'unknown' as any, nodeId: 'node-1' };
      expect(() => EntityRegistryFactory.create(config)).toThrow('Unknown entity registry type');
    });
  });

  describe('unknown type', () => {
    it('throws for a completely unknown registry type', () => {
      const config = {
        type: 'cassandra' as any,
        nodeId: 'node-1',
      };

      expect(() => EntityRegistryFactory.create(config)).toThrow(
        'Unknown entity registry type: cassandra',
      );
    });

    it('error message includes the unknown type string', () => {
      const unknownType = 'redis-cluster';
      const config = {
        type: unknownType as any,
        nodeId: 'node-1',
      };

      expect(() => EntityRegistryFactory.create(config)).toThrow(unknownType);
    });
  });

  // ---------------------------------------------------------------------------
  // Factory returns objects that satisfy the EntityRegistry contract
  // ---------------------------------------------------------------------------

  describe('created registries share the EntityRegistry interface', () => {
    it('memory registry exposes all required methods', () => {
      const registry = EntityRegistryFactory.createMemory('node-contract', {
        enableTestMode: true,
      });

      expect(typeof registry.proposeEntity).toBe('function');
      expect(typeof registry.getEntity).toBe('function');
      expect(typeof registry.getEntityHost).toBe('function');
      expect(typeof registry.releaseEntity).toBe('function');
      expect(typeof registry.updateEntity).toBe('function');
      expect(typeof registry.transferEntity).toBe('function');
      expect(typeof registry.getLocalEntities).toBe('function');
      expect(typeof registry.getAllKnownEntities).toBe('function');
      expect(typeof registry.getEntitiesByNode).toBe('function');
      expect(typeof registry.applyRemoteUpdate).toBe('function');
      expect(typeof registry.getUpdatesAfter).toBe('function');
      expect(typeof registry.exportSnapshot).toBe('function');
      expect(typeof registry.importSnapshot).toBe('function');
      expect(typeof registry.start).toBe('function');
      expect(typeof registry.stop).toBe('function');
      expect(typeof registry.on).toBe('function');
    });

    it('crdt registry exposes all required methods', () => {
      const registry = EntityRegistryFactory.create({
        type: 'crdt',
        nodeId: 'node-contract-crdt',
      });

      expect(typeof registry.proposeEntity).toBe('function');
      expect(typeof registry.getEntity).toBe('function');
      expect(typeof registry.applyRemoteUpdate).toBe('function');
      expect(typeof registry.getUpdatesAfter).toBe('function');
      expect(typeof registry.start).toBe('function');
      expect(typeof registry.stop).toBe('function');
    });
  });
});
