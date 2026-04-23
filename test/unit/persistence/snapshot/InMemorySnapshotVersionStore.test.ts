import { InMemorySnapshotVersionStore } from '../../../../src/persistence/snapshot/InMemorySnapshotVersionStore';

describe('InMemorySnapshotVersionStore', () => {
  let store: InMemorySnapshotVersionStore<string>;

  beforeEach(() => {
    store = new InMemorySnapshotVersionStore();
  });

  // ---------------------------------------------------------------------------
  // store
  // ---------------------------------------------------------------------------

  describe('store()', () => {
    it('returns an entry with correct shape', async () => {
      const before = Date.now();
      const entry = await store.store('ch-1', 'state-v1');
      const after = Date.now();

      expect(entry.id).toMatch(/^snap-/);
      expect(entry.key).toBe('ch-1');
      expect(entry.data).toBe('state-v1');
      expect(entry.type).toBe('auto');
      expect(entry.timestamp).toBeGreaterThanOrEqual(before);
      expect(entry.timestamp).toBeLessThanOrEqual(after);
      expect(entry.expiresAt).toBeUndefined();
      expect(entry.name).toBeUndefined();
    });

    it('respects the type option', async () => {
      const manual = await store.store('ch-1', 'state', { type: 'manual', name: 'v1.0' });
      expect(manual.type).toBe('manual');
      expect(manual.name).toBe('v1.0');

      const checkpoint = await store.store('ch-1', 'state', { type: 'checkpoint' });
      expect(checkpoint.type).toBe('checkpoint');
    });

    it('sets expiresAt when ttlMs is provided', async () => {
      const before = Date.now();
      const entry = await store.store('ch-1', 'state', { ttlMs: 60_000 });
      expect(entry.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    });

    it('preserves metadata', async () => {
      const entry = await store.store('ch-1', 'state', { metadata: { author: 'alice' } });
      expect(entry.metadata).toEqual({ author: 'alice' });
    });

    it('ids are unique across multiple stores', async () => {
      const a = await store.store('ch-1', 'a');
      const b = await store.store('ch-1', 'b');
      expect(a.id).not.toBe(b.id);
    });
  });

  // ---------------------------------------------------------------------------
  // getLatest
  // ---------------------------------------------------------------------------

  describe('getLatest()', () => {
    it('returns null for an unknown key', async () => {
      expect(await store.getLatest('missing')).toBeNull();
    });

    it('returns the most recently stored entry', async () => {
      await store.store('ch-1', 'first');
      await store.store('ch-1', 'second');
      const latest = await store.getLatest('ch-1');
      expect(latest?.data).toBe('second');
    });

    it('skips expired entries', async () => {
      const past = Date.now() - 1000;
      await store.store('ch-1', 'old', { ttlMs: -500 }); // already expired
      await store.store('ch-1', 'current');

      // Manually set expiresAt in the past for the first entry (ttlMs: -500)
      // The store stores it with expiresAt = now - 500 → expired immediately
      const latest = await store.getLatest('ch-1');
      expect(latest?.data).toBe('current');
    });

    it('returns null when all entries are expired', async () => {
      await store.store('ch-1', 'expired', { ttlMs: -1 });
      expect(await store.getLatest('ch-1')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------

  describe('list()', () => {
    it('returns empty array for unknown key', async () => {
      expect(await store.list('missing')).toEqual([]);
    });

    it('returns entries newest-first', async () => {
      await store.store('ch-1', 'a');
      await store.store('ch-1', 'b');
      await store.store('ch-1', 'c');
      const entries = await store.list('ch-1');
      expect(entries.map((e) => e.data)).toEqual(['c', 'b', 'a']);
    });

    it('respects the limit', async () => {
      for (let i = 0; i < 10; i++) await store.store('ch-1', `s${i}`);
      const entries = await store.list('ch-1', 3);
      expect(entries).toHaveLength(3);
    });

    it('filters out expired entries', async () => {
      await store.store('ch-1', 'valid');
      await store.store('ch-1', 'expired', { ttlMs: -1 });
      const entries = await store.list('ch-1');
      expect(entries).toHaveLength(1);
      expect(entries[0].data).toBe('valid');
    });
  });

  // ---------------------------------------------------------------------------
  // getAt
  // ---------------------------------------------------------------------------

  describe('getAt()', () => {
    it('returns null for unknown key or timestamp', async () => {
      expect(await store.getAt('missing', 123)).toBeNull();
    });

    it('finds an entry by exact timestamp', async () => {
      const entry = await store.store('ch-1', 'target');
      const found = await store.getAt('ch-1', entry.timestamp);
      expect(found?.data).toBe('target');
    });

    it('returns null if the timestamp does not match', async () => {
      await store.store('ch-1', 'data');
      expect(await store.getAt('ch-1', 0)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  describe('delete()', () => {
    it('returns false for a non-existent key', async () => {
      expect(await store.delete('missing', 123)).toBe(false);
    });

    it('returns false when timestamp does not match any entry', async () => {
      await store.store('ch-1', 'data');
      expect(await store.delete('ch-1', 0)).toBe(false);
    });

    it('removes the entry and returns true', async () => {
      const entry = await store.store('ch-1', 'data');
      expect(await store.delete('ch-1', entry.timestamp)).toBe(true);
      expect(await store.getAt('ch-1', entry.timestamp)).toBeNull();
    });

    it('does not affect other entries for the same key', async () => {
      await store.store('ch-1', 'keep');
      const toDelete = await store.store('ch-1', 'remove');
      await store.delete('ch-1', toDelete.timestamp);

      const remaining = await store.list('ch-1');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].data).toBe('keep');
    });
  });

  // ---------------------------------------------------------------------------
  // purgeExpired
  // ---------------------------------------------------------------------------

  describe('purgeExpired()', () => {
    it('returns 0 when nothing is expired', async () => {
      await store.store('ch-1', 'data');
      expect(await store.purgeExpired()).toBe(0);
    });

    it('removes expired entries and returns the count', async () => {
      await store.store('ch-1', 'valid');
      await store.store('ch-1', 'expired', { ttlMs: -1 });
      await store.store('ch-2', 'also-expired', { ttlMs: -1 });

      const removed = await store.purgeExpired();
      expect(removed).toBe(2);
      expect(await store.list('ch-1')).toHaveLength(1);
      expect(await store.list('ch-2')).toHaveLength(0);
    });

    it('removes keys that become completely empty after purge', async () => {
      await store.store('ch-1', 'expired', { ttlMs: -1 });
      await store.purgeExpired();
      expect(await store.getLatest('ch-1')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // isolation
  // ---------------------------------------------------------------------------

  describe('key isolation', () => {
    it('entries under different keys are independent', async () => {
      await store.store('ch-1', 'a');
      await store.store('ch-2', 'b');

      expect((await store.getLatest('ch-1'))?.data).toBe('a');
      expect((await store.getLatest('ch-2'))?.data).toBe('b');
    });

    it('deleting from one key does not affect another', async () => {
      const e1 = await store.store('ch-1', 'a');
      await store.store('ch-2', 'b');

      await store.delete('ch-1', e1.timestamp);
      expect(await store.getLatest('ch-2')).not.toBeNull();
    });
  });
});
