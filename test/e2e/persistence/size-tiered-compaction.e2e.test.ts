/**
 * E2E tests for SizeTieredCompactionStrategy
 *
 * Strategy overview:
 *   - Groups immutable segments by size tier (default boundaries: 1 MB, 10 MB, 100 MB).
 *   - Compacts a tier only when it has >= maxSegmentsPerTier segments.
 *   - executeCompaction delegates to RealCompactionExecutor when all input files exist.
 *   - Deduplicates by entityId (latest LSN wins), drops DELETE tombstones entirely.
 */

import fs from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { WALFileImpl } from '../../../src/persistence/wal/WALFile';
import { WALCoordinatorImpl } from '../../../src/persistence/wal/WALCoordinator';
import { SizeTieredCompactionStrategy } from '../../../src/persistence/compaction/SizeTieredCompactionStrategy';
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

function makePlan(
  segments: WALSegment[],
  outputId: string
): CompactionPlan {
  const startLSN = Math.min(...segments.map(s => s.startLSN));
  const endLSN = Math.max(...segments.map(s => s.endLSN));
  return {
    planId: `st-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    inputSegments: segments,
    outputSegments: [{
      segmentId: outputId,
      estimatedSize: segments.reduce((s, seg) => s + seg.sizeBytes, 0),
      lsnRange: { start: startLSN, end: endLSN },
    }],
    estimatedSpaceSaved: 0,
    estimatedDuration: 100,
    priority: 'medium',
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SizeTieredCompactionStrategy — E2E', () => {
  let testDir: string;
  let coordinator: WALCoordinatorImpl;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `st-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
  // Scenario 1: Similar-sized tier groups compact together
  //
  // Create 4 small segments (all in tier-0) + 2 large segments (tier-1).
  // Configure strategy with tier boundary between the two groups.
  // planCompaction should select the 4 small ones (tier-0) because that tier
  // reaches maxSegmentsPerTier=4.  The 2 large ones should NOT be included.
  // -------------------------------------------------------------------------
  it('similar-sized tier groups compact together while other tiers are untouched', async () => {
    const smallPayload = 'a'.repeat(20);   // tiny payload → small file
    const largePayload = 'b'.repeat(400);  // bigger payload → larger file

    // Write 4 small segments (20 entries each)
    const smallSegments: WALSegment[] = [];
    for (let i = 0; i < 4; i++) {
      const entries: EntityUpdate[] = Array.from({ length: 20 }, (_, j) => ({
        entityId: `small-${i}-entity-${j}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + j,
        operation: 'UPDATE',
        metadata: { payload: smallPayload },
      }));
      const { segment } = await writeSegment(testDir, `small-seg-${i}`, entries, coordinator);
      smallSegments.push(segment);
    }

    // Write 2 large segments (20 entries each, bigger payload)
    const largeSegments: WALSegment[] = [];
    for (let i = 0; i < 2; i++) {
      const entries: EntityUpdate[] = Array.from({ length: 20 }, (_, j) => ({
        entityId: `large-${i}-entity-${j}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + j,
        operation: 'UPDATE',
        metadata: { payload: largePayload },
      }));
      const { segment } = await writeSegment(testDir, `large-seg-${i}`, entries, coordinator);
      largeSegments.push(segment);
    }

    // Determine real file sizes so we can set a tier boundary between the two groups
    const smallSize = smallSegments[0].sizeBytes;
    const largeSize = largeSegments[0].sizeBytes;
    expect(largeSize).toBeGreaterThan(smallSize);

    // Tier boundary: anything <= midpoint goes to tier-0; above goes to tier-1
    const tierBoundary = Math.floor((smallSize + largeSize) / 2);

    const strategy = new SizeTieredCompactionStrategy({
      sizeTiers: [tierBoundary],
      maxSegmentsPerTier: 4, // exactly 4 small segments → triggers tier-0
    });

    const allSegments = [...smallSegments, ...largeSegments];
    const plan = strategy.planCompaction(allSegments, {
      lastCheckpointLSN: 0,
      lastCheckpointAge: 0,
      segmentsSinceCheckpoint: 0,
    });

    // A plan must be produced
    expect(plan).not.toBeNull();

    // Only the 4 small segments should be in the plan
    const planIds = plan!.inputSegments.map(s => s.segmentId).sort();
    const smallIds = smallSegments.map(s => s.segmentId).sort();
    expect(planIds).toEqual(smallIds);

    // Large segments must NOT appear in the plan
    for (const ls of largeSegments) {
      expect(plan!.inputSegments.map(s => s.segmentId)).not.toContain(ls.segmentId);
    }

    // Now execute with real files: only small-seg-* files should be merged
    const result = await strategy.executeCompaction(plan!);
    expect(result.success).toBe(true);
    expect(result.segmentsCreated).toHaveLength(1);
    expect(result.segmentsDeleted).toHaveLength(4);

    // Input small files deleted
    for (const s of smallSegments) {
      await expect(fs.access(s.filePath)).rejects.toThrow();
    }
    // Large files still present
    for (const l of largeSegments) {
      await expect(fs.access(l.filePath)).resolves.toBeUndefined();
    }
    // Output file exists
    await expect(fs.access(result.segmentsCreated[0].filePath)).resolves.toBeUndefined();
  }, 15000);

  // -------------------------------------------------------------------------
  // Scenario 2: Tombstone-heavy segment → post-compact file is smaller
  //
  // Write one segment where half the entries are DELETE tombstones.
  // Execute compaction directly (bypassing planCompaction) with a hand-built
  // plan (planCompaction requires >= maxSegmentsPerTier in a tier; hand-built
  // plan is simpler here and exercises the executeCompaction public API).
  // Verify the output file is smaller than the input.
  // -------------------------------------------------------------------------
  it('tombstone-heavy segment shrinks after compaction', async () => {
    // 30 live entries + 30 DELETE tombstones for those same entityIds
    const entityCount = 30;
    const entries: EntityUpdate[] = [];

    for (let i = 0; i < entityCount; i++) {
      entries.push({
        entityId: `tomb-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + i,
        operation: 'UPDATE',
        metadata: { payload: 'x'.repeat(80) },
      });
    }
    // Tombstone every entity
    for (let i = 0; i < entityCount; i++) {
      entries.push({
        entityId: `tomb-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 2,
        timestamp: Date.now() + entityCount + i,
        operation: 'DELETE',
        metadata: {},
      });
    }

    const { segment } = await writeSegment(testDir, 'tomb-seg', entries, coordinator);
    const sizeBefore = segment.sizeBytes;

    expect(segment.tombstoneCount).toBe(entityCount);
    expect(segment.entryCount).toBe(entityCount * 2);

    const strategy = new SizeTieredCompactionStrategy({
      sizeTiers: [sizeBefore * 2],
      maxSegmentsPerTier: 1, // hand-built plan anyway
    });

    const plan = makePlan([segment], `tomb-out-${Date.now()}`);
    const result = await strategy.executeCompaction(plan);

    expect(result.success).toBe(true);
    // All tombstones (and their matching live entries) should have been removed
    // by executeRealCompaction — the output file should be empty or much smaller
    expect(result.actualSpaceSaved).toBeGreaterThan(0);

    const outStats = await fs.stat(result.segmentsCreated[0].filePath);
    expect(outStats.size).toBeLessThan(sizeBefore);

    // Input deleted
    await expect(fs.access(segment.filePath)).rejects.toThrow();

    // Verify no tombstones remain in output
    const walFile = new WALFileImpl(result.segmentsCreated[0].filePath);
    const remainingEntries = await walFile.readEntries();
    const remainingTombstones = remainingEntries.filter(e => e.data.operation === 'DELETE');
    expect(remainingTombstones).toHaveLength(0);
  }, 15000);

  // -------------------------------------------------------------------------
  // Scenario 3: No-op when fewer than minSegmentsToCompact in a tier
  //
  // Only 1 segment exists → planCompaction must return null because the tier
  // has only 1 entry, which is below maxSegmentsPerTier.
  // -------------------------------------------------------------------------
  it('returns null plan when only one segment exists in a tier', async () => {
    const entries: EntityUpdate[] = Array.from({ length: 20 }, (_, i) => ({
      entityId: `noop-entity-${i}`,
      ownerNodeId: 'node-1',
      version: 1,
      timestamp: Date.now() + i,
      operation: 'UPDATE',
      metadata: { payload: 'x'.repeat(50) },
    }));

    const { segment } = await writeSegment(testDir, 'noop-seg', entries, coordinator);

    // Default maxSegmentsPerTier=4 — 1 segment can never trigger
    const strategy = new SizeTieredCompactionStrategy({
      sizeTiers: [segment.sizeBytes * 2],
      maxSegmentsPerTier: 4,
    });

    const plan = strategy.planCompaction([segment], {
      lastCheckpointLSN: 0,
      lastCheckpointAge: 0,
      segmentsSinceCheckpoint: 0,
    });

    expect(plan).toBeNull();
  }, 5000);

  // -------------------------------------------------------------------------
  // Scenario 4: Multiple rounds of compaction
  //
  // Round 1: planCompaction selects 4 same-tier segments → executeCompaction
  //          merges them into 1 output file.
  // Round 2: 3 fresh segments are written, then a hand-built plan merges the
  //          round-1 output together with those 3 new segments into a final
  //          output.  (planCompaction is not used for round 2 because the
  //          merged output is ~4× larger than each individual segment, which
  //          places it in a higher tier — a realistic outcome of size-tiered
  //          compaction that the tier-based planner intentionally defers until
  //          that tier fills up.  The hand-built plan exercises the public
  //          executeCompaction API directly, which is the correct approach when
  //          the caller wants to force a cross-tier merge.)
  //
  // Verify the final output contains all distinct live entries from both rounds.
  // -------------------------------------------------------------------------
  it('multiple rounds of compaction accumulate correctly', async () => {
    const entryCount = 15;
    const payload = 'z'.repeat(60);

    // --- Round 1: planCompaction-driven ---
    const round1Segments: WALSegment[] = [];
    for (let i = 0; i < 4; i++) {
      const entries: EntityUpdate[] = Array.from({ length: entryCount }, (_, j) => ({
        entityId: `r1-entity-${i}-${j}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + j,
        operation: 'UPDATE',
        metadata: { payload },
      }));
      const { segment } = await writeSegment(testDir, `r1-seg-${i}`, entries, coordinator);
      round1Segments.push(segment);
    }

    const tierBoundary = round1Segments[0].sizeBytes * 2;
    const strategy = new SizeTieredCompactionStrategy({
      sizeTiers: [tierBoundary],
      maxSegmentsPerTier: 4,
    });

    const plan1 = strategy.planCompaction(round1Segments, {
      lastCheckpointLSN: 0,
      lastCheckpointAge: 0,
      segmentsSinceCheckpoint: 0,
    });
    expect(plan1).not.toBeNull();

    const result1 = await strategy.executeCompaction(plan1!);
    expect(result1.success).toBe(true);
    expect(result1.segmentsCreated).toHaveLength(1);
    // Round-1 inputs must all be gone
    for (const s of round1Segments) {
      await expect(fs.access(s.filePath)).rejects.toThrow();
    }

    // Construct segment descriptor for the round-1 output
    const r1OutStats = await fs.stat(result1.segmentsCreated[0].filePath);
    const r1OutEntries = await new WALFileImpl(result1.segmentsCreated[0].filePath).readEntries();
    expect(r1OutEntries.length).toBe(4 * entryCount); // all unique → nothing dropped
    const r1OutSegment: WALSegment = {
      segmentId: result1.segmentsCreated[0].segmentId,
      filePath: result1.segmentsCreated[0].filePath,
      startLSN: result1.segmentsCreated[0].startLSN,
      endLSN: result1.segmentsCreated[0].endLSN,
      createdAt: Date.now(),
      sizeBytes: r1OutStats.size,
      entryCount: r1OutEntries.length,
      tombstoneCount: 0,
      isImmutable: true,
    };

    // --- Round 2: 3 more segments with fresh entityIds, merged via hand-built plan ---
    const round2NewSegments: WALSegment[] = [];
    for (let i = 0; i < 3; i++) {
      const entries: EntityUpdate[] = Array.from({ length: entryCount }, (_, j) => ({
        entityId: `r2-entity-${i}-${j}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + j,
        operation: 'UPDATE',
        metadata: { payload },
      }));
      const { segment } = await writeSegment(testDir, `r2-seg-${i}`, entries, coordinator);
      round2NewSegments.push(segment);
    }

    // Hand-build a plan merging the round-1 output with the 3 new segments.
    // This exercises executeCompaction directly — the correct API for forcing
    // a cross-tier merge without modifying source files.
    const allRound2Segments = [r1OutSegment, ...round2NewSegments];
    const plan2 = makePlan(allRound2Segments, `r2-out-${Date.now()}`);

    const result2 = await strategy.executeCompaction(plan2);
    expect(result2.success).toBe(true);
    expect(result2.segmentsCreated).toHaveLength(1);

    // Final output must contain all distinct live entries from both rounds:
    //   round1 merged = 4 * entryCount unique entries
    //   round2 new    = 3 * entryCount unique entries
    //   total         = 7 * entryCount
    const finalWal = new WALFileImpl(result2.segmentsCreated[0].filePath);
    const finalEntries = await finalWal.readEntries();
    expect(finalEntries.length).toBe(7 * entryCount);
    expect(finalEntries.every(e => e.data.operation !== 'DELETE')).toBe(true);
  }, 20000);
});
