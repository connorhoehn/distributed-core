import fs from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { WALFileImpl } from '../../../../src/persistence/wal/WALFile';
import { WALCoordinatorImpl } from '../../../../src/persistence/wal/WALCoordinator';
import { executeRealCompaction, inputsExistOnDisk } from '../../../../src/persistence/compaction/RealCompactionExecutor';
import { CompactionPlan, WALSegment } from '../../../../src/persistence/compaction/types';
import { EntityUpdate } from '../../../../src/persistence/wal/types';

const coordinator = new WALCoordinatorImpl();

// Helper: create a temp dir unique to this test run
function makeTempDir(): string {
  return path.join(tmpdir(), `real-compaction-test-${randomUUID()}`);
}

// Helper: write entries to a new WAL file and return its path + segment metadata
async function writeSegment(
  dir: string,
  name: string,
  entries: EntityUpdate[]
): Promise<{ filePath: string; segment: WALSegment }> {
  const filePath = path.join(dir, `${name}.wal`);
  const walFile = new WALFileImpl(filePath);
  await walFile.open();
  const walEntries = entries.map(e => coordinator.createEntry(e));
  for (const entry of walEntries) {
    await walFile.append(entry);
  }
  await walFile.close();

  const sizeBytes = await walFile.getSize();
  const tombstoneCount = walEntries.filter(e => e.data.operation === 'DELETE').length;

  const segment: WALSegment = {
    segmentId: name,
    filePath,
    startLSN: walEntries[0]?.logSequenceNumber ?? 0,
    endLSN: walEntries[walEntries.length - 1]?.logSequenceNumber ?? 0,
    createdAt: Date.now(),
    sizeBytes,
    entryCount: walEntries.length,
    tombstoneCount,
    isImmutable: true,
  };

  return { filePath, segment };
}

// Helper: build a minimal CompactionPlan from segments
function makePlan(segments: WALSegment[], outputId = 'compacted-output'): CompactionPlan {
  return {
    planId: `test-plan-${randomUUID()}`,
    inputSegments: segments,
    outputSegments: [
      {
        segmentId: outputId,
        estimatedSize: segments.reduce((s, seg) => s + seg.sizeBytes, 0),
        lsnRange: {
          start: Math.min(...segments.map(s => s.startLSN)),
          end: Math.max(...segments.map(s => s.endLSN)),
        },
      },
    ],
    estimatedSpaceSaved: 0,
    estimatedDuration: 0,
    priority: 'medium',
  };
}

describe('RealCompactionExecutor', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = makeTempDir();
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // inputsExistOnDisk
  // ---------------------------------------------------------------------------
  describe('inputsExistOnDisk()', () => {
    test('returns true when all input files exist', async () => {
      const { segment: seg1 } = await writeSegment(testDir, 'seg-a', [
        { entityId: 'e1', version: 1, timestamp: 1, operation: 'UPDATE' },
      ]);
      const { segment: seg2 } = await writeSegment(testDir, 'seg-b', [
        { entityId: 'e2', version: 1, timestamp: 2, operation: 'UPDATE' },
      ]);
      const plan = makePlan([seg1, seg2]);
      expect(await inputsExistOnDisk(plan)).toBe(true);
    });

    test('returns false when one file is missing (mixed)', async () => {
      const { segment: seg1 } = await writeSegment(testDir, 'seg-exists', [
        { entityId: 'e1', version: 1, timestamp: 1, operation: 'UPDATE' },
      ]);
      const missingSegment: WALSegment = {
        segmentId: 'missing',
        filePath: path.join(testDir, 'does-not-exist.wal'),
        startLSN: 9000,
        endLSN: 9999,
        createdAt: Date.now(),
        sizeBytes: 0,
        entryCount: 0,
        tombstoneCount: 0,
        isImmutable: true,
      };
      const plan = makePlan([seg1, missingSegment]);
      expect(await inputsExistOnDisk(plan)).toBe(false);
    });

    test('returns false when all files are missing', async () => {
      const fakeSegment: WALSegment = {
        segmentId: 'fake',
        filePath: '/data/wal/segment-001.wal',
        startLSN: 1,
        endLSN: 100,
        createdAt: Date.now(),
        sizeBytes: 1000,
        entryCount: 10,
        tombstoneCount: 0,
        isImmutable: true,
      };
      const plan = makePlan([fakeSegment]);
      expect(await inputsExistOnDisk(plan)).toBe(false);
    });

    test('returns false for an empty inputSegments list', async () => {
      const plan = makePlan([]);
      expect(await inputsExistOnDisk(plan)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // executeRealCompaction — basic read/dedup/write/delete
  // ---------------------------------------------------------------------------
  describe('executeRealCompaction()', () => {
    test('reads entries, deduplicates by entityId, writes output, deletes inputs', async () => {
      // Two entities each updated once in seg-1, updated again in seg-2
      const { segment: seg1 } = await writeSegment(testDir, 'seg-1', [
        { entityId: 'alpha', version: 1, timestamp: 100, operation: 'UPDATE' },
        { entityId: 'beta', version: 1, timestamp: 101, operation: 'UPDATE' },
      ]);
      const { segment: seg2 } = await writeSegment(testDir, 'seg-2', [
        { entityId: 'alpha', version: 2, timestamp: 200, operation: 'UPDATE' },
        { entityId: 'beta', version: 2, timestamp: 201, operation: 'UPDATE' },
      ]);

      const plan = makePlan([seg1, seg2]);
      const result = await executeRealCompaction(plan, Date.now());

      expect(result.success).toBe(true);
      // Inputs should be gone
      await expect(fs.access(seg1.filePath)).rejects.toThrow();
      await expect(fs.access(seg2.filePath)).rejects.toThrow();
      // Output file should exist
      expect(result.segmentsCreated.length).toBe(1);
      await expect(fs.access(result.segmentsCreated[0].filePath)).resolves.toBeUndefined();
    });

    test('correct counts: entriesProcessed, entriesCompacted, tombstonesRemoved, duplicatesRemoved', async () => {
      // seg-1: entity-1 UPDATE, entity-2 UPDATE, entity-3 DELETE
      // seg-2: entity-1 UPDATE (duplicate, higher LSN), entity-4 UPDATE
      const { segment: seg1 } = await writeSegment(testDir, 'seg-counts-1', [
        { entityId: 'entity-1', version: 1, timestamp: 100, operation: 'UPDATE' },
        { entityId: 'entity-2', version: 1, timestamp: 101, operation: 'UPDATE' },
        { entityId: 'entity-3', version: 1, timestamp: 102, operation: 'DELETE' },
      ]);
      const { segment: seg2 } = await writeSegment(testDir, 'seg-counts-2', [
        { entityId: 'entity-1', version: 2, timestamp: 200, operation: 'UPDATE' }, // duplicate — wins
        { entityId: 'entity-4', version: 1, timestamp: 201, operation: 'UPDATE' },
      ]);

      const plan = makePlan([seg1, seg2]);
      const result = await executeRealCompaction(plan, Date.now());

      // 5 entries total across both files
      expect(result.metrics.entriesProcessed).toBe(5);
      // entity-1 (version 2), entity-2, entity-4 are kept — entity-3 is tombstoned
      expect(result.metrics.entriesCompacted).toBe(3);
      // 1 DELETE entry in the raw data
      expect(result.metrics.tombstonesRemoved).toBe(1);
      // 1 stale entity-1 (version 1) removed as duplicate
      expect(result.metrics.duplicatesRemoved).toBe(1);
    });

    test('actualSpaceSaved is non-zero when duplicates/tombstones exist', async () => {
      // Write many duplicates + tombstones so the output will clearly be smaller
      const entries: EntityUpdate[] = [];
      for (let i = 0; i < 20; i++) {
        entries.push({ entityId: `e-${i}`, version: 1, timestamp: i, operation: 'UPDATE' });
      }
      // Overwrite all 20 with v2, then DELETE the first 10
      for (let i = 0; i < 20; i++) {
        entries.push({ entityId: `e-${i}`, version: 2, timestamp: 100 + i, operation: 'UPDATE' });
      }
      for (let i = 0; i < 10; i++) {
        entries.push({ entityId: `e-${i}`, version: 3, timestamp: 200 + i, operation: 'DELETE' });
      }

      const { segment } = await writeSegment(testDir, 'seg-space', entries);
      const plan = makePlan([segment]);
      const result = await executeRealCompaction(plan, Date.now());

      expect(result.actualSpaceSaved).toBeGreaterThan(0);
    });

    test('segmentsCreated[0].filePath points to a real file in the same directory', async () => {
      const { segment } = await writeSegment(testDir, 'seg-dir', [
        { entityId: 'x', version: 1, timestamp: 1, operation: 'UPDATE' },
      ]);
      const plan = makePlan([segment], 'my-output-segment');
      const result = await executeRealCompaction(plan, Date.now());

      const outputPath = result.segmentsCreated[0].filePath;
      expect(path.dirname(outputPath)).toBe(testDir);
      const stat = await fs.stat(outputPath);
      expect(stat.isFile()).toBe(true);
    });

    test('entry with highest LSN wins regardless of timestamp', async () => {
      // Write two entries for the same entity: the FIRST written has a higher timestamp
      // but lower LSN — the SECOND (lower timestamp, higher LSN) should win.
      const { segment } = await writeSegment(testDir, 'seg-lsn-wins', [
        { entityId: 'contested', version: 1, timestamp: 9999, operation: 'UPDATE' },
        { entityId: 'contested', version: 2, timestamp: 1,    operation: 'UPDATE' },
      ]);

      const plan = makePlan([segment]);
      const result = await executeRealCompaction(plan, Date.now());

      // Only 1 entry should remain
      expect(result.metrics.entriesCompacted).toBe(1);
      expect(result.metrics.duplicatesRemoved).toBe(1);

      // Read the output and verify version=2 (the higher-LSN entry) was kept
      const outputWal = new WALFileImpl(result.segmentsCreated[0].filePath);
      await outputWal.open();
      const kept = await outputWal.readEntries();
      await outputWal.close();
      expect(kept.length).toBe(1);
      expect(kept[0].data.version).toBe(2);
    });

    test('empty input (all tombstoned) produces an almost-empty output file', async () => {
      // Every entity is immediately deleted
      const { segment } = await writeSegment(testDir, 'seg-all-tombstoned', [
        { entityId: 'ghost-1', version: 1, timestamp: 1, operation: 'DELETE' },
        { entityId: 'ghost-2', version: 1, timestamp: 2, operation: 'DELETE' },
        { entityId: 'ghost-3', version: 1, timestamp: 3, operation: 'DELETE' },
      ]);

      const plan = makePlan([segment]);
      const result = await executeRealCompaction(plan, Date.now());

      expect(result.success).toBe(true);
      expect(result.metrics.entriesCompacted).toBe(0);
      expect(result.metrics.tombstonesRemoved).toBe(3);

      // Output file still exists but has no surviving entries
      const outputWal = new WALFileImpl(result.segmentsCreated[0].filePath);
      await outputWal.open();
      const kept = await outputWal.readEntries();
      await outputWal.close();
      expect(kept.length).toBe(0);
    });
  });
});
