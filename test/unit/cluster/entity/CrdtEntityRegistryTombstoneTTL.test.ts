/**
 * Tombstone TTL / compaction tests for CrdtEntityRegistry (GAPS doc §3).
 *
 * These tests cover:
 *  - Default behavior (TTL = Infinity) preserves "tombstones forever" / no
 *    resurrection guarantee.
 *  - With a finite TTL, the periodic compaction sweep evicts stale tombstones.
 *  - The explicit resurrection-window contract: once a tombstone is evicted,
 *    a re-CREATE for the same entityId IS accepted (the AP/CP tradeoff).
 *  - updateLog retention compaction.
 *  - Factory wiring.
 *
 * All tests use `jest.useFakeTimers()` so they run synchronously.
 */

import { CrdtEntityRegistry } from '../../../../src/cluster/entity/CrdtEntityRegistry';
import { EntityRegistryFactory } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { EntityUpdate } from '../../../../src/cluster/entity/types';

jest.setTimeout(10_000);

function makeUpdate(
  overrides: Partial<EntityUpdate> & Pick<EntityUpdate, 'entityId' | 'operation'>,
): EntityUpdate {
  return {
    ownerNodeId: 'remote-node',
    version: 1,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('CrdtEntityRegistry — tombstone TTL / compaction (GAPS §3)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Pin wall-clock so we can advance Date.now() deterministically.
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Default config (TTL = Infinity)', () => {
    it('does not evict tombstones — existing CRDT no-resurrection guarantee holds', async () => {
      const registry = new CrdtEntityRegistry('node-A');
      await registry.start();

      try {
        await registry.proposeEntity('default-tomb');
        const ts = registry.getEntity('default-tomb')!.version;
        await registry.releaseEntity('default-tomb');

        // Advance wall-clock by a long time and run any pending timers.
        jest.advanceTimersByTime(24 * 60 * 60 * 1000); // 24h

        // Stale CREATE with timestamp older than the delete must NOT resurrect.
        await registry.applyRemoteUpdate(
          makeUpdate({
            entityId: 'default-tomb',
            ownerNodeId: 'node-B',
            version: ts - 1 >= 1 ? ts - 1 : 1,
            operation: 'CREATE',
            metadata: { resurrected: true },
          }),
        );

        expect(registry.getEntity('default-tomb')).toBeNull();
      } finally {
        await registry.stop();
      }
    });

    it('does not start a compaction interval timer when both retentions are Infinity', async () => {
      const registry = new CrdtEntityRegistry('node-A');
      const before = jest.getTimerCount();
      await registry.start();
      const after = jest.getTimerCount();
      expect(after).toBe(before);
      await registry.stop();
    });
  });

  describe('Finite tombstoneTTLMs', () => {
    it('evicts tombstones older than TTL via the compaction interval', async () => {
      const registry = new CrdtEntityRegistry('node-A', {
        tombstoneTTLMs: 5_000,
        compactionIntervalMs: 1_000,
      });
      await registry.start();

      try {
        await registry.proposeEntity('ttl-1');
        await registry.releaseEntity('ttl-1');

        // Tombstone present immediately after delete.
        expect((registry as any).tombstones.has('ttl-1')).toBe(true);

        // Advance past TTL and let the compaction interval fire at least once.
        jest.advanceTimersByTime(6_000);

        expect((registry as any).tombstones.has('ttl-1')).toBe(false);
      } finally {
        await registry.stop();
      }
    });

    it('keeps tombstones that are younger than TTL', async () => {
      const registry = new CrdtEntityRegistry('node-A', {
        tombstoneTTLMs: 60_000,
        compactionIntervalMs: 1_000,
      });
      await registry.start();

      try {
        await registry.proposeEntity('ttl-young');
        await registry.releaseEntity('ttl-young');

        // Sweep multiple times but stay under the TTL window.
        jest.advanceTimersByTime(10_000);

        expect((registry as any).tombstones.has('ttl-young')).toBe(true);
      } finally {
        await registry.stop();
      }
    });

    it('compact() (manual) is idempotent and reports counts', async () => {
      const registry = new CrdtEntityRegistry('node-A', {
        tombstoneTTLMs: 1_000,
        compactionIntervalMs: 60_000, // long — we drive compact() manually
      });
      await registry.start();

      try {
        await registry.proposeEntity('manual-1');
        await registry.proposeEntity('manual-2');
        await registry.releaseEntity('manual-1');
        await registry.releaseEntity('manual-2');

        // Within TTL — nothing evicted.
        const r1 = registry.compact();
        expect(r1.tombstonesEvicted).toBe(0);

        jest.setSystemTime(Date.now() + 5_000);
        const r2 = registry.compact();
        expect(r2.tombstonesEvicted).toBe(2);

        // Idempotent — no tombstones left.
        const r3 = registry.compact();
        expect(r3.tombstonesEvicted).toBe(0);
      } finally {
        await registry.stop();
      }
    });
  });

  describe('Resurrection-window contract (explicit AP/CP tradeoff)', () => {
    it('after TTL expiry, a partitioned node rejoining CAN re-create the same entityId', async () => {
      // Scenario: node-A creates entity X, deletes it. After TTL, node-A
      // forgets the tombstone. A node-B that has been partitioned the whole
      // time sends a stale CREATE for X. With finite TTL, X is reborn —
      // documented and accepted as the cost of bounded memory.
      const registry = new CrdtEntityRegistry('node-A', {
        tombstoneTTLMs: 5_000,
        compactionIntervalMs: 1_000,
      });
      await registry.start();

      try {
        await registry.proposeEntity('rejoin-X', { origin: 'A-original' });
        const originalTs = registry.getEntity('rejoin-X')!.version;
        await registry.releaseEntity('rejoin-X');
        expect(registry.getEntity('rejoin-X')).toBeNull();

        // Wait long enough for the compaction sweep to evict the tombstone.
        jest.advanceTimersByTime(6_000);
        expect((registry as any).tombstones.has('rejoin-X')).toBe(false);

        // Partitioned node-B finally syncs a stale CREATE that *predates* the
        // delete. Without a tombstone to suppress it, the entity is reborn.
        const result = await registry.applyRemoteUpdate(
          makeUpdate({
            entityId: 'rejoin-X',
            ownerNodeId: 'node-B',
            version: originalTs, // strictly less than the (now-evicted) delete tick
            operation: 'CREATE',
            metadata: { origin: 'B-stale-but-accepted' },
          }),
        );

        expect(result).toBe(true);
        const reborn = registry.getEntity('rejoin-X');
        expect(reborn).not.toBeNull();
        expect(reborn!.metadata).toMatchObject({ origin: 'B-stale-but-accepted' });
      } finally {
        await registry.stop();
      }
    });

    it('with default config the same scenario does NOT resurrect (control)', async () => {
      const registry = new CrdtEntityRegistry('node-A'); // defaults
      await registry.start();

      try {
        await registry.proposeEntity('rejoin-Y', { origin: 'A-original' });
        const originalTs = registry.getEntity('rejoin-Y')!.version;
        await registry.releaseEntity('rejoin-Y');

        jest.advanceTimersByTime(6_000);

        await registry.applyRemoteUpdate(
          makeUpdate({
            entityId: 'rejoin-Y',
            ownerNodeId: 'node-B',
            version: originalTs,
            operation: 'CREATE',
            metadata: { origin: 'B-stale' },
          }),
        );

        expect(registry.getEntity('rejoin-Y')).toBeNull();
      } finally {
        await registry.stop();
      }
    });
  });

  describe('updateLogRetentionMs', () => {
    it('evicts updateLog entries older than the retention window', async () => {
      const registry = new CrdtEntityRegistry('node-A', {
        updateLogRetentionMs: 5_000,
        compactionIntervalMs: 1_000,
      });
      await registry.start();

      try {
        await registry.proposeEntity('log-1');
        // Move forward and add a fresh update.
        jest.setSystemTime(Date.now() + 10_000);
        await registry.proposeEntity('log-2');

        // Trigger compaction tick — old `log-1` create should be evicted,
        // new `log-2` create retained.
        jest.advanceTimersByTime(1_000);

        const remaining = registry.getUpdatesAfter(0).map((u) => u.entityId);
        expect(remaining).toContain('log-2');
        expect(remaining).not.toContain('log-1');
      } finally {
        await registry.stop();
      }
    });
  });

  describe('Lifecycle + factory wiring', () => {
    it('stop() clears the compaction timer (no leaked handles)', async () => {
      const registry = new CrdtEntityRegistry('node-A', {
        tombstoneTTLMs: 1_000,
        compactionIntervalMs: 500,
      });
      await registry.start();
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      await registry.stop();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('start() is idempotent — does not double-register the timer', async () => {
      const registry = new CrdtEntityRegistry('node-A', {
        tombstoneTTLMs: 1_000,
        compactionIntervalMs: 500,
      });
      await registry.start();
      const t1 = jest.getTimerCount();
      await registry.start();
      const t2 = jest.getTimerCount();
      expect(t2).toBe(t1);
      await registry.stop();
    });

    it('EntityRegistryFactory.createCRDT wires options through', async () => {
      const registry = EntityRegistryFactory.createCRDT('node-factory', {
        tombstoneTTLMs: 5_000,
        compactionIntervalMs: 1_000,
      }) as CrdtEntityRegistry;

      await registry.start();
      try {
        await registry.proposeEntity('factory-tomb');
        await registry.releaseEntity('factory-tomb');
        expect((registry as any).tombstones.has('factory-tomb')).toBe(true);

        jest.advanceTimersByTime(6_000);
        expect((registry as any).tombstones.has('factory-tomb')).toBe(false);
      } finally {
        await registry.stop();
      }
    });

    it('EntityRegistryFactory.create({ type: "crdt", crdtOptions }) wires options through', async () => {
      const registry = EntityRegistryFactory.create({
        type: 'crdt',
        nodeId: 'node-factory-2',
        crdtOptions: { tombstoneTTLMs: 3_000, compactionIntervalMs: 500 },
      }) as CrdtEntityRegistry;

      await registry.start();
      try {
        await registry.proposeEntity('factory-cfg');
        await registry.releaseEntity('factory-cfg');
        jest.advanceTimersByTime(4_000);
        expect((registry as any).tombstones.has('factory-cfg')).toBe(false);
      } finally {
        await registry.stop();
      }
    });
  });
});
