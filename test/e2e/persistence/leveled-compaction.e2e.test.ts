/**
 * E2E tests for LeveledCompactionStrategy
 *
 * Strategy overview:
 *   - Organises immutable segments into levels by sizeBytes:
 *       level 0 = < baseLevelSize (default 10 MB)
 *       level N = < baseLevelSize * levelSizeMultiplier^N
 *   - planCompaction requires >= 2 immutable segments total.
 *   - Within a level it triggers when:
 *       (a) level 0 has >= level0SegmentLimit segments (default 4), OR
 *       (b) any level has segments with overlapping LSN ranges.
 *   - executeCompaction delegates to RealCompactionExecutor when files exist.
 *   - Deduplicates by entityId (latest LSN wins), drops DELETE tombstones.
 */

import fs from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { WALFileImpl } from '../../../src/persistence/wal/WALFile';
import { WALCoordinatorImpl } from '../../../src/persistence/wal/WALCoordinator';
import { LeveledCompactionStrategy } from '../../../src/persistence/compaction/LeveledCompactionStrategy';
import { WALEntry, EntityUpdate } from '../../../src/persistence/wal/types';
import { WALSegment, CompactionPlan } from '../../../src/persistence/compaction/types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function writeSegment(
  dir: string,
  name: string,
  entries: EntityUpdate[],
  coordinator: WALCoordinatorImpl
): Promise<{ walFile: WALFileImpl; segment: WALSegment; walEntries: WALEntry[] }> {
  const filePath = path.join(dir, `${name}.wal`);
  const walFile = new WALFileImpl(filePath);
  await walFile.open();

  const walEntries: WALEntry[] = [];
  for (const update of entries) {
    const entry = coordinator.createEntry(update);
    walEntries.push(entry);
    await walFile.append(entry);
  }
  await walFile.close();

  const sizeBytes = await walFile.getSize();
  const tombstoneCount = walEntries.filter(e => e.data.operation === 'DELETE').length;

  const segment: WALSegment = {
    segmentId: name,
    filePath,
    startLSN: walEntries[0].logSequenceNumber,
    endLSN: walEntries[walEntries.length - 1].logSequenceNumber,
    createdAt: Date.now(),
    sizeBytes,
    entryCount: walEntries.length,
    tombstoneCount,
    isImmutable: true,
  };

  return { walFile, segment, walEntries };
}

/** Build a WALSegment descriptor around an existing on-disk file. */
async function segmentFromFile(
  filePath: string,
  segmentId: string
): Promise<WALSegment> {
  const walFile = new WALFileImpl(filePath);
  const entries = await walFile.readEntries();
  const stats = await fs.stat(filePath);
  const tombstoneCount = entries.filter(e => e.data.operation === 'DELETE').length;
  return {
    segmentId,
    filePath,
    startLSN: entries[0]?.logSequenceNumber ?? 0,
    endLSN: entries[entries.length - 1]?.logSequenceNumber ?? 0,
    createdAt: stats.birthtimeMs || stats.mtimeMs,
    sizeBytes: stats.size,
    entryCount: entries.length,
    tombstoneCount,
    isImmutable: true,
  };
}

function makePlan(
  segments: WALSegment[],
  outputId: string
): CompactionPlan {
  const startLSN = Math.min(...segments.map(s => s.startLSN));
  const endLSN = Math.max(...segments.map(s => s.endLSN));
  return {
    planId: `lv-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    inputSegments: segments,
    outputSegments: [{
      segmentId: outputId,
      estimatedSize: segments.reduce((s, seg) => s + seg.sizeBytes, 0),
      lsnRange: { start: startLSN, end: endLSN },
    }],
    estimatedSpaceSaved: 0,
    estimatedDuration: 100,
    priority: 'high',
  };
}

const emptyCheckpoint = {
  lastCheckpointLSN: 0,
  lastCheckpointAge: 0,
  segmentsSinceCheckpoint: 0,
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('LeveledCompactionStrategy — E2E', () => {
  let testDir: string;
  let coordinator: WALCoordinatorImpl;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `lv-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    await fs.mkdir(testDir, { recursive: true });
    coordinator = new WALCoordinatorImpl();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Level-0 overflow triggers merge to level-1
  //
  // Fill L0 with exactly level0SegmentLimit (4) small segments.  Because all
  // segments are smaller than baseLevelSize the strategy assigns them all to
  // level 0.  planCompaction should detect the overflow and produce a plan
  // covering all 4, with priority 'high'.
  // -------------------------------------------------------------------------
  it('L0 overflow triggers a plan covering all L0 segments with high priority', async () => {
    // baseLevelSize = 500 KB; our tiny segments will all be < this → level 0
    const baseLevelSize = 512 * 1024; // 512 KB
    const strategy = new LeveledCompactionStrategy({
      baseLevelSize,
      level0SegmentLimit: 4,
    });

    const l0Segments: WALSegment[] = [];
    for (let i = 0; i < 4; i++) {
      // Use overlapping entityIds so LSN ranges created by coordinator are distinct
      const entries: EntityUpdate[] = Array.from({ length: 20 }, (_, j) => ({
        entityId: `l0-overflow-seg${i}-entity${j}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + i * 100 + j,
        operation: 'UPDATE',
        metadata: { payload: 'a'.repeat(40) },
      }));
      const { segment } = await writeSegment(testDir, `l0-overflow-seg${i}`, entries, coordinator);
      // Verify our segment is actually below baseLevelSize (i.e. it lands in L0)
      expect(segment.sizeBytes).toBeLessThan(baseLevelSize);
      l0Segments.push(segment);
    }

    const plan = strategy.planCompaction(l0Segments, emptyCheckpoint);
    expect(plan).not.toBeNull();

    // All 4 L0 segments in the plan
    const planIds = plan!.inputSegments.map(s => s.segmentId).sort();
    const l0Ids = l0Segments.map(s => s.segmentId).sort();
    expect(planIds).toEqual(l0Ids);

    // Priority should be 'high' (L0 at limit)
    expect(plan!.priority).toBe('high');

    // Execute with real files
    const result = await strategy.executeCompaction(plan!);
    expect(result.success).toBe(true);
    expect(result.segmentsCreated).toHaveLength(1);
    expect(result.segmentsDeleted).toHaveLength(4);

    // All L0 input files removed
    for (const s of l0Segments) {
      await expect(fs.access(s.filePath)).rejects.toThrow();
    }
    // Single merged output exists and has all live entries
    await expect(fs.access(result.segmentsCreated[0].filePath)).resolves.toBeUndefined();
    const outEntries = await new WALFileImpl(result.segmentsCreated[0].filePath).readEntries();
    expect(outEntries.length).toBe(4 * 20); // all unique entityIds — no duplicates dropped
  }, 15000);

  // -------------------------------------------------------------------------
  // Scenario 2: Overlapping LSN ranges within a level trigger compaction
  //
  // Two segments at the same level with overlapping LSN ranges must be merged.
  // We use hand-built WALSegment descriptors to manufacture overlapping LSN
  // ranges, then call executeCompaction directly with a hand-built plan.
  // This isolates the real-filesystem merge behavior (deduplication) from the
  // planning trigger, which is LSN-overlap based.
  //
  // Note: planCompaction with overlapping segments in level 0 would normally
  // plan them automatically, but using executeCompaction directly lets us also
  // verify what happens when the same entityId appears in two segments — the
  // newer LSN wins.
  // -------------------------------------------------------------------------
  it('overlapping LSN ranges in a level trigger merge and deduplicate entries', async () => {
    // Two segments at level 0 (small) with the same entityId at different LSNs.
    // Coordinator LSNs are monotonically increasing so the second write to the
    // same entityId will have a higher LSN and should survive.

    const sharedEntityId = 'dedup-entity-shared';

    // Segment A: write entities A0..A9 + shared entity (version 1)
    const entriesA: EntityUpdate[] = [];
    for (let i = 0; i < 10; i++) {
      entriesA.push({
        entityId: `dedup-A-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + i,
        operation: 'UPDATE',
        metadata: { payload: 'a'.repeat(40) },
      });
    }
    entriesA.push({
      entityId: sharedEntityId,
      ownerNodeId: 'node-1',
      version: 1,
      timestamp: Date.now() + 100,
      operation: 'UPDATE',
      metadata: { value: 'old' },
    });
    const { segment: segA, walEntries: wEntriesA } = await writeSegment(testDir, 'dedup-seg-a', entriesA, coordinator);

    // Segment B: write entities B0..B9 + shared entity (version 2 — higher LSN)
    const entriesB: EntityUpdate[] = [];
    for (let i = 0; i < 10; i++) {
      entriesB.push({
        entityId: `dedup-B-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + i + 200,
        operation: 'UPDATE',
        metadata: { payload: 'b'.repeat(40) },
      });
    }
    entriesB.push({
      entityId: sharedEntityId,
      ownerNodeId: 'node-1',
      version: 2,
      timestamp: Date.now() + 300,
      operation: 'UPDATE',
      metadata: { value: 'new' },
    });
    const { segment: segB, walEntries: wEntriesB } = await writeSegment(testDir, 'dedup-seg-b', entriesB, coordinator);

    // Manufacture overlapping LSN ranges so planCompaction selects them.
    // Segment A ends at its real endLSN; segment B starts before that end.
    const overlapSegA: WALSegment = {
      ...segA,
      startLSN: wEntriesA[0].logSequenceNumber,
      endLSN: wEntriesA[wEntriesA.length - 1].logSequenceNumber,
    };
    const overlapSegB: WALSegment = {
      ...segB,
      // Force startLSN to overlap with segA's LSN range
      startLSN: overlapSegA.startLSN + 1,
      endLSN: wEntriesB[wEntriesB.length - 1].logSequenceNumber,
    };

    const strategy = new LeveledCompactionStrategy({
      baseLevelSize: 512 * 1024, // both segs are in L0
      level0SegmentLimit: 10,    // high limit — overlap is the trigger
    });

    const plan = strategy.planCompaction([overlapSegA, overlapSegB], emptyCheckpoint);
    expect(plan).not.toBeNull();
    expect(plan!.inputSegments).toHaveLength(2);

    const result = await strategy.executeCompaction(plan!);
    expect(result.success).toBe(true);

    const outFile = new WALFileImpl(result.segmentsCreated[0].filePath);
    const outEntries = await outFile.readEntries();

    // The shared entity should appear exactly once in the output
    const sharedEntries = outEntries.filter(e => e.data.entityId === sharedEntityId);
    expect(sharedEntries).toHaveLength(1);
    // The newer version (from segment B) should be retained
    expect(sharedEntries[0].data.version).toBe(2);
    expect((sharedEntries[0].data.metadata as any)?.value).toBe('new');

    // Total distinct live entityIds: 10 (A) + 10 (B) + 1 (shared) = 21
    expect(outEntries.length).toBe(21);
  }, 15000);

  // -------------------------------------------------------------------------
  // Scenario 3: Cross-level deduplication — same entityId in L0 and L1
  //
  // An entity is written in an "L1" (larger) segment first, then updated in
  // an "L0" (smaller) segment. After compaction the newer L0 write wins.
  //
  // The strategy only merges within a single level per plan.  We therefore
  // use a hand-built plan spanning both segments to exercise the executor's
  // deduplication directly — this is the correct public API for forcing a
  // cross-level merge.
  // -------------------------------------------------------------------------
  it('cross-level deduplication retains the higher-LSN entry', async () => {
    const sharedId = 'cross-level-entity';

    // "L1" segment: larger payload, written first (lower LSN)
    const l1Entries: EntityUpdate[] = [];
    for (let i = 0; i < 15; i++) {
      l1Entries.push({
        entityId: i === 0 ? sharedId : `l1-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + i,
        operation: 'UPDATE',
        metadata: { payload: 'L'.repeat(60), level: 'L1' },
      });
    }
    const { segment: l1Seg, walEntries: l1WalEntries } = await writeSegment(testDir, 'cross-l1-seg', l1Entries, coordinator);

    // "L0" segment: smaller, written after (higher LSN) — overwrites sharedId
    const l0Entries: EntityUpdate[] = [];
    for (let i = 0; i < 10; i++) {
      l0Entries.push({
        entityId: i === 0 ? sharedId : `l0-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 2,
        timestamp: Date.now() + 500 + i,
        operation: 'UPDATE',
        metadata: { payload: 'S'.repeat(40), level: 'L0' },
      });
    }
    const { segment: l0Seg, walEntries: l0WalEntries } = await writeSegment(testDir, 'cross-l0-seg', l0Entries, coordinator);

    // Confirm L0 entry for sharedId has a higher LSN
    const l1SharedLSN = l1WalEntries.find(e => e.data.entityId === sharedId)!.logSequenceNumber;
    const l0SharedLSN = l0WalEntries.find(e => e.data.entityId === sharedId)!.logSequenceNumber;
    expect(l0SharedLSN).toBeGreaterThan(l1SharedLSN);

    // Hand-build a cross-level plan
    const plan = makePlan([l1Seg, l0Seg], `cross-out-${Date.now()}`);

    const strategy = new LeveledCompactionStrategy();
    const result = await strategy.executeCompaction(plan);
    expect(result.success).toBe(true);

    const outFile = new WALFileImpl(result.segmentsCreated[0].filePath);
    const outEntries = await outFile.readEntries();

    // sharedId must appear exactly once; the L0 version wins
    const sharedOuts = outEntries.filter(e => e.data.entityId === sharedId);
    expect(sharedOuts).toHaveLength(1);
    expect((sharedOuts[0].data.metadata as any)?.level).toBe('L0');

    // Total live entries: 15 (L1) + 10 (L0) - 1 duplicate (sharedId) = 24
    expect(outEntries.length).toBe(24);
  }, 15000);

  // -------------------------------------------------------------------------
  // Scenario 4: Tombstone propagation across levels
  //
  // A live entity exists in what would be an "L1" segment; a DELETE tombstone
  // for the same entity exists in a later "L0" segment.  After compaction
  // (via hand-built plan) both the tombstone and the original live entry must
  // be gone from the output.
  // -------------------------------------------------------------------------
  it('delete tombstone from newer segment removes matching live entry in older segment', async () => {
    const deletedId = 'to-be-deleted-entity';

    // "L1" segment: contains a live entry for deletedId
    const l1Entries: EntityUpdate[] = [];
    for (let i = 0; i < 15; i++) {
      l1Entries.push({
        entityId: i === 0 ? deletedId : `l1-live-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + i,
        operation: 'UPDATE',
        metadata: { payload: 'x'.repeat(60) },
      });
    }
    const { segment: l1Seg } = await writeSegment(testDir, 'tomb-l1-seg', l1Entries, coordinator);

    // "L0" segment: contains a DELETE for deletedId + other live entries
    const l0Entries: EntityUpdate[] = [];
    l0Entries.push({
      entityId: deletedId,
      ownerNodeId: 'node-1',
      version: 2,
      timestamp: Date.now() + 500,
      operation: 'DELETE',
      metadata: {},
    });
    for (let i = 1; i < 10; i++) {
      l0Entries.push({
        entityId: `l0-live-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + 500 + i,
        operation: 'UPDATE',
        metadata: { payload: 'y'.repeat(40) },
      });
    }
    const { segment: l0Seg } = await writeSegment(testDir, 'tomb-l0-seg', l0Entries, coordinator);

    const plan = makePlan([l1Seg, l0Seg], `tomb-cross-out-${Date.now()}`);

    const strategy = new LeveledCompactionStrategy();
    const result = await strategy.executeCompaction(plan);
    expect(result.success).toBe(true);

    const outFile = new WALFileImpl(result.segmentsCreated[0].filePath);
    const outEntries = await outFile.readEntries();

    // The deleted entity must not appear at all
    const deletedEntries = outEntries.filter(e => e.data.entityId === deletedId);
    expect(deletedEntries).toHaveLength(0);

    // No tombstones in output
    const tombstones = outEntries.filter(e => e.data.operation === 'DELETE');
    expect(tombstones).toHaveLength(0);

    // Remaining entries: 14 live from L1 (excludes deletedId) + 9 live from L0
    expect(outEntries.length).toBe(14 + 9);
    expect(result.metrics.tombstonesRemoved).toBeGreaterThan(0);
  }, 15000);
});
