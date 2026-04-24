/**
 * E2E tests for VacuumBasedCompactionStrategy
 *
 * Strategy overview:
 *   - Scores each immutable segment by deadTupleRatio and fragmentationRatio.
 *     deadTupleRatio  = min(tombstoneCount * 2, entryCount) / entryCount
 *     fragmentationRatio = wastedEntries / entryCount  (same formula, different framing)
 *   - planCompaction selects segments that exceed either threshold (default: 0.2 / 0.3).
 *   - If no segment qualifies, returns null → no compaction.
 *   - executeCompaction delegates to RealCompactionExecutor when all input files exist:
 *       reads all entries, deduplicates by entityId (latest LSN wins),
 *       drops entities whose latest operation is DELETE.
 */

import fs from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { WALFileImpl } from '../../../src/persistence/wal/WALFile';
import { WALCoordinatorImpl } from '../../../src/persistence/wal/WALCoordinator';
import { VacuumBasedCompactionStrategy } from '../../../src/persistence/compaction/VacuumBasedCompactionStrategy';
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
    planId: `vac-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

describe('VacuumBasedCompactionStrategy — E2E', () => {
  let testDir: string;
  let coordinator: WALCoordinatorImpl;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `vac-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
  // Scenario 1: High tombstone ratio triggers vacuum
  //
  // The strategy's deadTupleRatio formula:
  //   deadTupleRatio = min(tombstoneCount * 2, entryCount) / entryCount
  //
  // With 20 total entries and 10 tombstones:
  //   deadTupleRatio = min(20, 20) / 20 = 1.0
  //
  // This easily exceeds the 0.2 default threshold, so planCompaction should
  // select the segment and executeCompaction should clean it.
  // -------------------------------------------------------------------------
  it('segment with high tombstone ratio is selected by planCompaction and cleaned', async () => {
    // 10 distinct entities: each gets one live UPDATE then one DELETE tombstone
    const entityCount = 10;
    const entries: EntityUpdate[] = [];

    for (let i = 0; i < entityCount; i++) {
      entries.push({
        entityId: `high-tomb-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + i,
        operation: 'UPDATE',
        metadata: { payload: 'x'.repeat(80) },
      });
    }
    for (let i = 0; i < entityCount; i++) {
      entries.push({
        entityId: `high-tomb-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 2,
        timestamp: Date.now() + entityCount + i,
        operation: 'DELETE',
        metadata: {},
      });
    }

    const { segment } = await writeSegment(testDir, 'high-tomb-seg', entries, coordinator);

    // Verify the dead-tuple ratio would trigger vacuum
    // deadTupleRatio = min(10*2, 20) / 20 = 1.0
    expect(segment.tombstoneCount).toBe(entityCount);
    expect(segment.entryCount).toBe(entityCount * 2);

    const strategy = new VacuumBasedCompactionStrategy({
      deadTupleThreshold: 0.2,  // default — easily exceeded
      vacuumIntervalMs: 0,       // no cooldown
    });

    const plan = strategy.planCompaction([segment], emptyCheckpoint);
    expect(plan).not.toBeNull();
    expect(plan!.inputSegments.map(s => s.segmentId)).toContain(segment.segmentId);

    const result = await strategy.executeCompaction(plan!);
    expect(result.success).toBe(true);
    expect(result.metrics.tombstonesRemoved).toBeGreaterThan(0);

    // Output file should have no tombstones and no live entries for deleted entities
    const outFile = new WALFileImpl(result.segmentsCreated[0].filePath);
    const outEntries = await outFile.readEntries();
    expect(outEntries.filter(e => e.data.operation === 'DELETE')).toHaveLength(0);
    // All entities were deleted → nothing survives
    expect(outEntries).toHaveLength(0);

    // Input file deleted
    await expect(fs.access(segment.filePath)).rejects.toThrow();
  }, 15000);

  // -------------------------------------------------------------------------
  // Scenario 2: Low tombstone ratio — segment is not selected
  //
  // A segment with very few tombstones relative to its total entries should
  // NOT exceed the deadTupleThreshold (0.2) and should be excluded from the
  // compaction plan.  If no segment qualifies, planCompaction returns null.
  //
  // With 40 live entries and 1 tombstone:
  //   deadTupleRatio = min(1*2, 41) / 41 ≈ 0.049 — well below 0.2
  //   fragmentationRatio = wastedEntries / 41 = 2/41 ≈ 0.049 — below 0.3
  // → strategy should skip this segment → null plan.
  // -------------------------------------------------------------------------
  it('segment with low tombstone ratio is not selected for compaction', async () => {
    const entries: EntityUpdate[] = [];

    // 40 unique live entries
    for (let i = 0; i < 40; i++) {
      entries.push({
        entityId: `low-tomb-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + i,
        operation: 'UPDATE',
        metadata: { payload: 'x'.repeat(60) },
      });
    }
    // Only 1 tombstone
    entries.push({
      entityId: 'low-tomb-entity-0',
      ownerNodeId: 'node-1',
      version: 2,
      timestamp: Date.now() + 100,
      operation: 'DELETE',
      metadata: {},
    });

    const { segment } = await writeSegment(testDir, 'low-tomb-seg', entries, coordinator);

    // deadTupleRatio = min(1*2, 41)/41 ≈ 0.049 < 0.2
    expect(segment.tombstoneCount).toBe(1);
    expect(segment.entryCount).toBe(41);

    const strategy = new VacuumBasedCompactionStrategy({
      deadTupleThreshold: 0.2,
      fragmentationThreshold: 0.3,
      vacuumIntervalMs: 0,
    });

    const plan = strategy.planCompaction([segment], emptyCheckpoint);
    // No segment qualifies → null
    expect(plan).toBeNull();
  }, 5000);

  // -------------------------------------------------------------------------
  // Scenario 3: Post-vacuum size reduction matches tombstone count roughly
  //
  // Write a segment with M entries, N of which are DELETE tombstones for
  // distinct entityIds (each with a matching live entry).
  // After vacuum the output file should be roughly (M - 2N) / M of the input
  // size (each tombstone removes itself + 1 live entry).
  //
  // We use a lenient tolerance (±30%) because JSON serialization overhead
  // varies and the executor uses real byte sizes, not entry counts.
  // -------------------------------------------------------------------------
  it('post-vacuum file size reflects tombstone removal proportionally', async () => {
    const liveCount = 30;   // entities that survive
    const deadCount = 20;   // entities that are deleted

    const entries: EntityUpdate[] = [];

    // Live entities (survive)
    for (let i = 0; i < liveCount; i++) {
      entries.push({
        entityId: `size-live-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + i,
        operation: 'UPDATE',
        metadata: { payload: 'A'.repeat(100) },
      });
    }
    // Dead entities: one live write then one DELETE
    for (let i = 0; i < deadCount; i++) {
      entries.push({
        entityId: `size-dead-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 1,
        timestamp: Date.now() + liveCount + i,
        operation: 'UPDATE',
        metadata: { payload: 'B'.repeat(100) },
      });
    }
    for (let i = 0; i < deadCount; i++) {
      entries.push({
        entityId: `size-dead-entity-${i}`,
        ownerNodeId: 'node-1',
        version: 2,
        timestamp: Date.now() + liveCount + deadCount + i,
        operation: 'DELETE',
        metadata: {},
      });
    }

    const totalEntries = liveCount + deadCount * 2; // 30 + 40 = 70
    const { segment } = await writeSegment(testDir, 'size-ratio-seg', entries, coordinator);
    const sizeBefore = segment.sizeBytes;

    expect(segment.entryCount).toBe(totalEntries);
    expect(segment.tombstoneCount).toBe(deadCount);

    const plan = makePlan([segment], `size-ratio-out-${Date.now()}`);

    const strategy = new VacuumBasedCompactionStrategy({
      deadTupleThreshold: 0.01,  // very sensitive → will always trigger
      vacuumIntervalMs: 0,
    });

    const result = await strategy.executeCompaction(plan);
    expect(result.success).toBe(true);
    expect(result.actualSpaceSaved).toBeGreaterThan(0);

    const outStats = await fs.stat(result.segmentsCreated[0].filePath);
    const sizeAfter = outStats.size;

    // Only liveCount entries should remain; the dead ones (live + tombstone) are gone
    const outFile = new WALFileImpl(result.segmentsCreated[0].filePath);
    const outEntries = await outFile.readEntries();
    expect(outEntries).toHaveLength(liveCount);
    expect(outEntries.every(e => e.data.operation !== 'DELETE')).toBe(true);

    // Rough size check: output should be no larger than the portion of entries retained
    // Expected retention: liveCount / totalEntries = 30/70 ≈ 0.43
    // Allow generous ±30 percentage point tolerance for JSON overhead variation
    const retentionFraction = sizeAfter / sizeBefore;
    const expectedRetentionFraction = liveCount / totalEntries; // ~0.43

    expect(retentionFraction).toBeLessThan(expectedRetentionFraction + 0.30);
    // It must be smaller than the original
    expect(sizeAfter).toBeLessThan(sizeBefore);
  }, 15000);
});
