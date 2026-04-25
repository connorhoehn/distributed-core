import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { WALSnapshotVersionStore } from '../../../../src/persistence/snapshot/WALSnapshotVersionStore';
import type { CompactionResult } from '../../../../src/persistence/snapshot/WALSnapshotVersionStore';

function tmpPath(): string {
  return path.join(os.tmpdir(), `wal-snap-test-${randomUUID()}.wal`);
}

describe('WALSnapshotVersionStore', () => {
  let store: WALSnapshotVersionStore<unknown>;
  let filePath: string;

  beforeEach(async () => {
    filePath = tmpPath();
    store = new WALSnapshotVersionStore(filePath);
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    await fs.unlink(filePath).catch(() => {});
  });

  test('initialize then store saves a snapshot', async () => {
    const entry = await store.store('key1', { value: 42 });
    expect(entry.id).toBeDefined();
    expect(entry.key).toBe('key1');
    expect(entry.data).toEqual({ value: 42 });
    expect(entry.type).toBe('auto');
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  test('getLatest returns the most recent snapshot for a key', async () => {
    await store.store('key1', { v: 1 });
    await new Promise(r => setTimeout(r, 5));
    await store.store('key1', { v: 2 });

    const latest = await store.getLatest('key1');
    expect(latest).not.toBeNull();
    expect((latest!.data as { v: number }).v).toBe(2);
  });

  test('getLatest returns null for unknown key', async () => {
    const result = await store.getLatest('nonexistent');
    expect(result).toBeNull();
  });

  test('multiple stores for the same key — getLatest returns the newest', async () => {
    await store.store('mykey', 'first');
    await new Promise(r => setTimeout(r, 5));
    await store.store('mykey', 'second');
    await new Promise(r => setTimeout(r, 5));
    await store.store('mykey', 'third');

    const latest = await store.getLatest('mykey');
    expect(latest!.data).toBe('third');
  });

  test('list returns entries newest-first and respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.store('listkey', { i });
      await new Promise(r => setTimeout(r, 5));
    }

    const all = await store.list('listkey');
    expect(all.length).toBe(5);
    for (let i = 0; i < all.length - 1; i++) {
      expect(all[i].timestamp).toBeGreaterThanOrEqual(all[i + 1].timestamp);
    }

    const limited = await store.list('listkey', 3);
    expect(limited.length).toBe(3);
    expect((limited[0].data as { i: number }).i).toBe(4);
  });

  test('getAt returns the newest entry at-or-before the given timestamp', async () => {
    await store.store('atkey', 'first');
    await new Promise(r => setTimeout(r, 10));
    const mid = Date.now();
    await new Promise(r => setTimeout(r, 10));
    await store.store('atkey', 'second');

    const result = await store.getAt('atkey', mid);
    expect(result).not.toBeNull();
    expect(result!.data).toBe('first');
  });

  test('delete removes an entry and getLatest returns previous', async () => {
    await store.store('delkey', 'first');
    await new Promise(r => setTimeout(r, 5));
    const second = await store.store('delkey', 'second');

    const deleted = await store.delete('delkey', second.timestamp);
    expect(deleted).toBe(true);

    const latest = await store.getLatest('delkey');
    expect(latest!.data).toBe('first');
  });

  test('delete returns false for unknown timestamp', async () => {
    await store.store('key1', 'data');
    const result = await store.delete('key1', 0);
    expect(result).toBe(false);
  });

  test('purgeExpired removes entries past their expiresAt', async () => {
    const past = Date.now() - 1000;
    await store.store('expkey', 'gone', { expiresAt: past });
    await store.store('expkey', 'alive', { expiresAt: Date.now() + 60000 });

    const purged = await store.purgeExpired();
    expect(purged).toBe(1);

    const latest = await store.getLatest('expkey');
    expect(latest!.data).toBe('alive');
  });

  test('data round-trips correctly', async () => {
    const obj = { nested: { a: 1, b: [true, null, 'hello'] }, count: 99 };
    await store.store('rtkey', obj);

    const latest = await store.getLatest('rtkey');
    expect(latest!.data).toEqual(obj);
  });

  test('multiple keys are independent', async () => {
    await store.store('alpha', 'for-alpha');
    await store.store('beta', 'for-beta');

    const a = await store.getLatest('alpha');
    const b = await store.getLatest('beta');
    expect(a!.data).toBe('for-alpha');
    expect(b!.data).toBe('for-beta');

    const aList = await store.list('alpha');
    expect(aList.length).toBe(1);
    const bList = await store.list('beta');
    expect(bList.length).toBe(1);
  });

  test('survives re-initialize: new instance on same filePath reads previous snapshots', async () => {
    await store.store('persist-key', { persisted: true });
    await store.close();

    const store2 = new WALSnapshotVersionStore(filePath);
    await store2.initialize();
    try {
      const latest = await store2.getLatest('persist-key');
      expect(latest).not.toBeNull();
      expect((latest!.data as { persisted: boolean }).persisted).toBe(true);
    } finally {
      await store2.close();
    }
  });

  describe('compact()', () => {
    let compactStore: WALSnapshotVersionStore<unknown>;
    let compactFilePath: string;

    beforeEach(async () => {
      compactFilePath = path.join(os.tmpdir(), randomUUID());
      compactStore = new WALSnapshotVersionStore(compactFilePath);
      await compactStore.initialize();
    });

    afterEach(async () => {
      await compactStore.close();
      await fs.unlink(compactFilePath).catch(() => {});
    });

    test('compaction of a key with more entries than maxEntriesPerKey keeps only the N newest', async () => {
      for (let i = 0; i < 5; i++) {
        await compactStore.store('k', { i });
        await new Promise(r => setTimeout(r, 5));
      }

      await compactStore.compact({ maxEntriesPerKey: 3, deleteExpired: false });

      const entries = await compactStore.list('k', 10);
      expect(entries.length).toBe(3);
      expect((entries[0].data as { i: number }).i).toBe(4);
      expect((entries[1].data as { i: number }).i).toBe(3);
      expect((entries[2].data as { i: number }).i).toBe(2);
    });

    test('after compact, list() returns the kept entries', async () => {
      for (let i = 0; i < 4; i++) {
        await compactStore.store('listkey', { i });
        await new Promise(r => setTimeout(r, 5));
      }

      await compactStore.compact({ maxEntriesPerKey: 2, deleteExpired: false });

      const entries = await compactStore.list('listkey', 10);
      expect(entries.length).toBe(2);
    });

    test('compaction removes expired entries when deleteExpired: true', async () => {
      const past = Date.now() - 5000;
      await compactStore.store('expkey', 'expired1', { expiresAt: past });
      await compactStore.store('expkey', 'expired2', { expiresAt: past });
      await compactStore.store('expkey', 'alive', { expiresAt: Date.now() + 60000 });

      await compactStore.compact({ deleteExpired: true, maxEntriesPerKey: 100 });

      const entries = await compactStore.list('expkey', 10);
      expect(entries.length).toBe(1);
      expect(entries[0].data).toBe('alive');
    });

    test('compaction does NOT remove non-expired entries when deleteExpired: false', async () => {
      const past = Date.now() - 5000;
      await compactStore.store('expkey', 'old', { expiresAt: past });
      await compactStore.store('expkey', 'alive', { expiresAt: Date.now() + 60000 });

      await compactStore.compact({ deleteExpired: false, maxEntriesPerKey: 100 });

      const entries = await compactStore.list('expkey', 10);
      expect(entries.length).toBe(2);
    });

    test('compaction with an empty store returns zero counts', async () => {
      const result: CompactionResult = await compactStore.compact();
      expect(result.keysVisited).toBe(0);
      expect(result.entriesKept).toBe(0);
      expect(result.entriesRemoved).toBe(0);
    });

    test('after compact, new store() calls still work correctly', async () => {
      await compactStore.store('k', { v: 1 });
      await compactStore.compact({ maxEntriesPerKey: 1, deleteExpired: false });

      await new Promise(r => setTimeout(r, 5));
      await compactStore.store('k', { v: 2 });

      const latest = await compactStore.getLatest('k');
      expect((latest!.data as { v: number }).v).toBe(2);
    });

    test('compact returns correct entriesKept and entriesRemoved counts', async () => {
      for (let i = 0; i < 6; i++) {
        await compactStore.store('k', { i });
        await new Promise(r => setTimeout(r, 5));
      }

      const result: CompactionResult = await compactStore.compact({
        maxEntriesPerKey: 2,
        deleteExpired: false,
      });

      expect(result.keysVisited).toBe(1);
      expect(result.entriesKept).toBe(2);
      expect(result.entriesRemoved).toBe(4);
    });

    test('after compact, creating a new WALSnapshotVersionStore on the same path sees the compacted state', async () => {
      for (let i = 0; i < 5; i++) {
        await compactStore.store('k', { i });
        await new Promise(r => setTimeout(r, 5));
      }

      await compactStore.compact({ maxEntriesPerKey: 2, deleteExpired: false });
      await compactStore.close();

      const store2 = new WALSnapshotVersionStore(compactFilePath);
      await store2.initialize();
      try {
        const entries = await store2.list('k', 10);
        expect(entries.length).toBe(2);
        expect((entries[0].data as { i: number }).i).toBe(4);
        expect((entries[1].data as { i: number }).i).toBe(3);
      } finally {
        await store2.close();
      }
    });

    it('propagates rename errors (atomic swap failure) during compact', async () => {
      const tempPath = path.join(os.tmpdir(), randomUUID());
      const store = new WALSnapshotVersionStore<{ n: number }>(tempPath);
      await store.initialize();
      await store.store('k', { n: 1 });

      const renameSpy = jest.spyOn(fs, 'rename').mockRejectedValueOnce(
        Object.assign(new Error('Simulated rename failure'), { code: 'EIO' }),
      );

      try {
        await expect(store.compact()).rejects.toThrow();
      } finally {
        renameSpy.mockRestore();
        await store.close().catch(() => {});
        await fs.unlink(tempPath).catch(() => {});
      }
    });

    // -----------------------------------------------------------------------
    // Atomicity regression tests (C2 fix)
    // -----------------------------------------------------------------------
    describe('atomicity', () => {
      test('temp file does NOT survive a successful compact', async () => {
        for (let i = 0; i < 4; i++) {
          await compactStore.store('k', { i });
          await new Promise(r => setTimeout(r, 5));
        }
        await compactStore.compact({ maxEntriesPerKey: 2, deleteExpired: false });

        const tmpPath = `${compactFilePath}.${process.pid}.tmp`;
        await expect(fs.access(tmpPath)).rejects.toThrow();
      });

      test('original file is intact when rename throws mid-compact', async () => {
        // Write several entries so the file has real content.
        for (let i = 0; i < 3; i++) {
          await compactStore.store('k', { i });
          await new Promise(r => setTimeout(r, 5));
        }

        const originalContent = await fs.readFile(compactFilePath, 'utf-8');

        // Simulate a crash between the temp-write and the rename.
        const renameSpy = jest.spyOn(fs, 'rename').mockRejectedValueOnce(
          new Error('Simulated rename failure'),
        );

        try {
          await expect(
            compactStore.compact({ maxEntriesPerKey: 1, deleteExpired: false }),
          ).rejects.toThrow('Simulated rename failure');
        } finally {
          renameSpy.mockRestore();
        }

        // The original file must still be present and unchanged.
        const afterContent = await fs.readFile(compactFilePath, 'utf-8');
        expect(afterContent).toBe(originalContent);

        // The temp file must have been cleaned up.
        const tmpPath = `${compactFilePath}.${process.pid}.tmp`;
        await expect(fs.access(tmpPath)).rejects.toThrow();
      });
    });
  });
});
