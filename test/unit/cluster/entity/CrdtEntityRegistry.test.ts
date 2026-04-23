import { CrdtEntityRegistry } from '../../../../src/cluster/entity/CrdtEntityRegistry';
import { EntityUpdate } from '../../../../src/cluster/entity/types';

jest.setTimeout(10000);

// Helper to build an EntityUpdate with defaults
function makeUpdate(overrides: Partial<EntityUpdate> & Pick<EntityUpdate, 'entityId' | 'operation'>): EntityUpdate {
  return {
    ownerNodeId: 'remote-node',
    version: 1,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('CrdtEntityRegistry', () => {
  let registry: CrdtEntityRegistry;
  const NODE_ID = 'node-A';

  beforeEach(async () => {
    registry = new CrdtEntityRegistry(NODE_ID);
    await registry.start();
  });

  afterEach(async () => {
    await registry.stop();
  });

  // ---------------------------------------------------------------------------
  // Basic CRUD
  // ---------------------------------------------------------------------------

  describe('Basic CRUD operations', () => {
    it('register (proposeEntity) creates an entity and get (getEntity) retrieves it', async () => {
      const metadata = { type: 'room', region: 'us-east-1' };
      const entity = await registry.proposeEntity('entity-1', metadata);

      expect(entity.entityId).toBe('entity-1');
      expect(entity.ownerNodeId).toBe(NODE_ID);
      expect(entity.version).toBeGreaterThan(0);
      expect(entity.metadata).toEqual(metadata);

      const retrieved = registry.getEntity('entity-1');
      expect(retrieved).toEqual(entity);
    });

    it('getEntity returns null for unknown entity', () => {
      expect(registry.getEntity('does-not-exist')).toBeNull();
    });

    it('proposeEntity throws when the same entityId is registered twice', async () => {
      await registry.proposeEntity('entity-dup');
      await expect(registry.proposeEntity('entity-dup')).rejects.toThrow(
        'Entity entity-dup already exists',
      );
    });

    it('updateEntity modifies metadata and increments logical version', async () => {
      const initial = await registry.proposeEntity('entity-upd', { colour: 'red' });

      const updated = await registry.updateEntity('entity-upd', { colour: 'blue' });

      expect(updated.version).toBeGreaterThan(initial.version);
      expect(updated.metadata).toMatchObject({ colour: 'blue' });
      expect(updated.lastUpdated).toBeGreaterThanOrEqual(initial.lastUpdated);
    });

    it('releaseEntity removes entity and subsequent getEntity returns null', async () => {
      await registry.proposeEntity('entity-del');
      await registry.releaseEntity('entity-del');

      expect(registry.getEntity('entity-del')).toBeNull();
      expect(registry.getEntityHost('entity-del')).toBeNull();
    });

    it('getAllKnownEntities returns all registered entities', async () => {
      await registry.proposeEntity('e1');
      await registry.proposeEntity('e2');
      await registry.proposeEntity('e3');

      const all = registry.getAllKnownEntities();
      const ids = all.map((e) => e.entityId).sort();
      expect(ids).toEqual(['e1', 'e2', 'e3']);
    });

    it('getLocalEntities filters to entities owned by this node', async () => {
      await registry.proposeEntity('local-1');

      // Inject a remote entity
      await registry.applyRemoteUpdate(
        makeUpdate({ entityId: 'remote-1', ownerNodeId: 'node-B', version: 100, operation: 'CREATE' }),
      );

      const locals = registry.getLocalEntities();
      expect(locals).toHaveLength(1);
      expect(locals[0].entityId).toBe('local-1');
    });

    it('getEntitiesByNode returns entities owned by a specific node', async () => {
      await registry.proposeEntity('local-1');
      await registry.applyRemoteUpdate(
        makeUpdate({ entityId: 'remote-1', ownerNodeId: 'node-B', version: 100, operation: 'CREATE' }),
      );
      await registry.applyRemoteUpdate(
        makeUpdate({ entityId: 'remote-2', ownerNodeId: 'node-B', version: 101, operation: 'CREATE' }),
      );

      const nodeB = registry.getEntitiesByNode('node-B');
      expect(nodeB).toHaveLength(2);

      const nodeA = registry.getEntitiesByNode(NODE_ID);
      expect(nodeA).toHaveLength(1);
    });

    it('getEntityHost returns ownerNodeId or null', async () => {
      await registry.proposeEntity('entity-host');
      expect(registry.getEntityHost('entity-host')).toBe(NODE_ID);
      expect(registry.getEntityHost('missing')).toBeNull();
    });

    it('releaseEntity throws for non-existent entity', async () => {
      await expect(registry.releaseEntity('ghost')).rejects.toThrow('Entity ghost not found');
    });

    it('updateEntity throws for non-existent entity', async () => {
      await expect(registry.updateEntity('ghost', { x: 1 })).rejects.toThrow(
        'Entity ghost not found',
      );
    });

    it('operations throw when registry is not started', async () => {
      const unstarted = new CrdtEntityRegistry('unstarted-node');
      await expect(unstarted.proposeEntity('e')).rejects.toThrow(
        'CrdtEntityRegistry is not running',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // CRDT / LWW semantics
  // ---------------------------------------------------------------------------

  describe('CRDT / LWW semantics', () => {
    it('higher logical timestamp wins on concurrent remote CREATE', async () => {
      // Apply a lower-version CREATE first
      await registry.applyRemoteUpdate(
        makeUpdate({
          entityId: 'crdt-1',
          ownerNodeId: 'node-B',
          version: 5,
          operation: 'CREATE',
          metadata: { winner: false },
        }),
      );

      // Apply a higher-version CREATE — must overwrite
      await registry.applyRemoteUpdate(
        makeUpdate({
          entityId: 'crdt-1',
          ownerNodeId: 'node-C',
          version: 10,
          operation: 'CREATE',
          metadata: { winner: true },
        }),
      );

      const entity = registry.getEntity('crdt-1');
      expect(entity).not.toBeNull();
      expect(entity!.ownerNodeId).toBe('node-C');
      expect(entity!.metadata).toMatchObject({ winner: true });
    });

    it('when timestamps are equal, lexicographically higher nodeId wins', async () => {
      const TIE_TS = 42;

      await registry.applyRemoteUpdate(
        makeUpdate({
          entityId: 'tie-entity',
          ownerNodeId: 'node-A',
          version: TIE_TS,
          operation: 'CREATE',
          metadata: { from: 'node-A' },
        }),
      );

      // node-Z > node-A lexicographically
      await registry.applyRemoteUpdate(
        makeUpdate({
          entityId: 'tie-entity',
          ownerNodeId: 'node-Z',
          version: TIE_TS,
          operation: 'CREATE',
          metadata: { from: 'node-Z' },
        }),
      );

      const entity = registry.getEntity('tie-entity');
      expect(entity!.ownerNodeId).toBe('node-Z');
      expect(entity!.metadata).toMatchObject({ from: 'node-Z' });
    });

    it('lower-nodeId remote update is ignored on timestamp tie', async () => {
      const TIE_TS = 42;

      await registry.applyRemoteUpdate(
        makeUpdate({
          entityId: 'tie-entity-2',
          ownerNodeId: 'node-Z',
          version: TIE_TS,
          operation: 'CREATE',
          metadata: { from: 'node-Z' },
        }),
      );

      // node-A < node-Z — should be ignored
      await registry.applyRemoteUpdate(
        makeUpdate({
          entityId: 'tie-entity-2',
          ownerNodeId: 'node-A',
          version: TIE_TS,
          operation: 'CREATE',
          metadata: { from: 'node-A' },
        }),
      );

      const entity = registry.getEntity('tie-entity-2');
      expect(entity!.ownerNodeId).toBe('node-Z');
    });

    it('applyRemoteUpdate with lower timestamp than current is ignored (stale update)', async () => {
      // Establish local state at a high logical clock
      await registry.proposeEntity('stale-test', { value: 'original' });
      // After propose, logicalClock = 1; version = 1
      // We add another update to push version to 2
      await registry.updateEntity('stale-test', { value: 'original' });

      const before = registry.getEntity('stale-test');

      // Stale remote update with version 1 — lower than local version 2
      const result = await registry.applyRemoteUpdate(
        makeUpdate({
          entityId: 'stale-test',
          ownerNodeId: 'node-B',
          version: 1,
          operation: 'UPDATE',
          metadata: { value: 'stale' },
        }),
      );

      expect(result).toBe(true);
      const after = registry.getEntity('stale-test');
      expect(after!.metadata).toMatchObject({ value: 'original' });
      expect(after!.version).toBe(before!.version);
    });

    it('applyRemoteUpdate with higher timestamp overrides local state', async () => {
      await registry.proposeEntity('override-test', { value: 'local' });

      await registry.applyRemoteUpdate(
        makeUpdate({
          entityId: 'override-test',
          ownerNodeId: 'node-B',
          version: 9999,
          operation: 'UPDATE',
          metadata: { value: 'remote-winner' },
        }),
      );

      const entity = registry.getEntity('override-test');
      expect(entity!.version).toBe(9999);
      expect(entity!.metadata).toMatchObject({ value: 'remote-winner' });
    });

    describe('Tombstone semantics', () => {
      it('after releaseEntity, stale remote UPDATE with older timestamp does NOT resurrect the entity', async () => {
        await registry.proposeEntity('tomb-1', { alive: true });
        const localVersion = registry.getEntity('tomb-1')!.version;

        await registry.releaseEntity('tomb-1');

        // Stale remote update with timestamp older than the delete
        await registry.applyRemoteUpdate(
          makeUpdate({
            entityId: 'tomb-1',
            ownerNodeId: 'node-B',
            version: localVersion - 1 >= 1 ? localVersion - 1 : 1,
            operation: 'UPDATE',
            metadata: { alive: 'resurrected' },
          }),
        );

        expect(registry.getEntity('tomb-1')).toBeNull();
      });

      it('after releaseEntity, stale remote CREATE with older timestamp does NOT resurrect the entity', async () => {
        await registry.proposeEntity('tomb-create', { alive: true });
        const deleteTs = registry.getEntity('tomb-create')!.version;

        await registry.releaseEntity('tomb-create');

        await registry.applyRemoteUpdate(
          makeUpdate({
            entityId: 'tomb-create',
            ownerNodeId: 'node-B',
            // Use a version we know is lower than the delete tick
            version: deleteTs - 1 >= 1 ? deleteTs - 1 : 1,
            operation: 'CREATE',
            metadata: { alive: 'zombie' },
          }),
        );

        expect(registry.getEntity('tomb-create')).toBeNull();
      });

      it('remote UPDATE with NEWER timestamp than delete DOES resurrect the entity (LWW)', async () => {
        await registry.proposeEntity('tomb-lww', { value: 'first' });
        await registry.releaseEntity('tomb-lww');

        expect(registry.getEntity('tomb-lww')).toBeNull();

        // Remote CREATE with a much higher timestamp should win over tombstone
        await registry.applyRemoteUpdate(
          makeUpdate({
            entityId: 'tomb-lww',
            ownerNodeId: 'node-B',
            version: 99999,
            operation: 'CREATE',
            metadata: { value: 'resurrected' },
          }),
        );

        const resurrected = registry.getEntity('tomb-lww');
        expect(resurrected).not.toBeNull();
        expect(resurrected!.metadata).toMatchObject({ value: 'resurrected' });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Causality / logical clock
  // ---------------------------------------------------------------------------

  describe('Causality / logical clock', () => {
    it('local logical clock increments on each write', async () => {
      const e1 = await registry.proposeEntity('clock-1');
      const e2 = await registry.proposeEntity('clock-2');
      const e3 = await registry.proposeEntity('clock-3');

      // Each entity's version should be the clock value at that write
      expect(e2.version).toBeGreaterThan(e1.version);
      expect(e3.version).toBeGreaterThan(e2.version);
    });

    it('applyRemoteUpdate advances clock to max(local, remote)', async () => {
      // Start with local clock at 1 (one write)
      await registry.proposeEntity('clock-adv');

      // Remote update with a much higher version — should advance the clock
      await registry.applyRemoteUpdate(
        makeUpdate({
          entityId: 'clock-adv',
          ownerNodeId: 'node-B',
          version: 500,
          operation: 'UPDATE',
          metadata: { x: 1 },
        }),
      );

      // The next local write must use a version > 500
      const next = await registry.proposeEntity('after-remote');
      expect(next.version).toBeGreaterThan(500);
    });

    it('getUpdatesAfter returns only updates after the given version', async () => {
      await registry.proposeEntity('upd-1'); // version 1
      await registry.proposeEntity('upd-2'); // version 2
      await registry.proposeEntity('upd-3'); // version 3

      const all = registry.getUpdatesAfter(0);
      expect(all.length).toBeGreaterThanOrEqual(3);

      const partial = registry.getUpdatesAfter(1);
      expect(partial.every((u: EntityUpdate) => u.version > 1)).toBe(true);

      const none = registry.getUpdatesAfter(9999);
      expect(none).toHaveLength(0);
    });

    it('getUpdatesAfter includes remote updates applied via applyRemoteUpdate', async () => {
      await registry.applyRemoteUpdate(
        makeUpdate({
          entityId: 'remote-log',
          ownerNodeId: 'node-B',
          version: 77,
          operation: 'CREATE',
        }),
      );

      const updates = registry.getUpdatesAfter(0);
      const found = updates.find((u: EntityUpdate) => u.entityId === 'remote-log');
      expect(found).toBeDefined();
      expect(found!.version).toBe(77);
    });
  });

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  describe('Events', () => {
    it('proposeEntity emits entity:created', async () => {
      const createdSpy = jest.fn();
      registry.on('entity:created', createdSpy);

      const entity = await registry.proposeEntity('evt-create');

      expect(createdSpy).toHaveBeenCalledTimes(1);
      expect(createdSpy).toHaveBeenCalledWith(entity);
    });

    it('updateEntity emits entity:updated', async () => {
      await registry.proposeEntity('evt-upd');
      const updatedSpy = jest.fn();
      registry.on('entity:updated', updatedSpy);

      const updated = await registry.updateEntity('evt-upd', { changed: true });

      expect(updatedSpy).toHaveBeenCalledTimes(1);
      expect(updatedSpy).toHaveBeenCalledWith(updated);
    });

    it('releaseEntity emits entity:deleted', async () => {
      const entity = await registry.proposeEntity('evt-del');
      const deletedSpy = jest.fn();
      registry.on('entity:deleted', deletedSpy);

      await registry.releaseEntity('evt-del');

      expect(deletedSpy).toHaveBeenCalledTimes(1);
      expect(deletedSpy).toHaveBeenCalledWith(entity);
    });

    it('transferEntity emits entity:transferred', async () => {
      await registry.proposeEntity('evt-transfer');
      const transferredSpy = jest.fn();
      registry.on('entity:transferred', transferredSpy);

      const transferred = await registry.transferEntity('evt-transfer', 'node-B');

      expect(transferredSpy).toHaveBeenCalledTimes(1);
      expect(transferredSpy).toHaveBeenCalledWith(transferred);
    });

    it('proposeEntity does NOT emit entity:updated or entity:deleted', async () => {
      const updatedSpy = jest.fn();
      const deletedSpy = jest.fn();
      registry.on('entity:updated', updatedSpy);
      registry.on('entity:deleted', deletedSpy);

      await registry.proposeEntity('no-extra-events');

      expect(updatedSpy).not.toHaveBeenCalled();
      expect(deletedSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Snapshotting
  // ---------------------------------------------------------------------------

  describe('Snapshotting', () => {
    it('exportSnapshot captures current state', async () => {
      await registry.proposeEntity('snap-1', { a: 1 });
      await registry.proposeEntity('snap-2', { b: 2 });

      const snapshot = registry.exportSnapshot();

      expect(snapshot.nodeId).toBe(NODE_ID);
      expect(Object.keys(snapshot.entities)).toHaveLength(2);
      expect(snapshot.entities['snap-1']).toBeDefined();
      expect(snapshot.entities['snap-2']).toBeDefined();
      expect(snapshot.version).toBeGreaterThan(0);
    });

    it('importSnapshot replaces state and allows querying', async () => {
      await registry.proposeEntity('pre-snap');
      const snap = registry.exportSnapshot();

      const fresh = new CrdtEntityRegistry('node-B');
      await fresh.start();
      await fresh.importSnapshot(snap);

      const all = fresh.getAllKnownEntities();
      expect(all).toHaveLength(1);
      expect(all[0].entityId).toBe('pre-snap');

      await fresh.stop();
    });
  });
});
