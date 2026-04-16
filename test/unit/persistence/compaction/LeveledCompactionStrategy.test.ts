import { LeveledCompactionStrategy } from '../../../../src/persistence/compaction/LeveledCompactionStrategy';
import { WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan } from '../../../../src/persistence/compaction/types';

function makeSegment(overrides: Partial<WALSegment> = {}): WALSegment {
  return {
    segmentId: `seg-${Math.random().toString(36).substr(2, 6)}`,
    filePath: '/data/wal/segment.wal',
    startLSN: 1,
    endLSN: 100,
    createdAt: Date.now() - 3600_000,
    sizeBytes: 1 * 1024 * 1024, // 1MB — fits in level 0
    entryCount: 1000,
    tombstoneCount: 100,
    isImmutable: true,
    ...overrides,
  };
}

function makeSegments(count: number, overrides: Partial<WALSegment> = {}): WALSegment[] {
  const segments: WALSegment[] = [];
  for (let i = 0; i < count; i++) {
    segments.push(makeSegment({
      segmentId: `seg-${i}`,
      startLSN: i * 100 + 1,
      endLSN: (i + 1) * 100,
      ...overrides,
    }));
  }
  return segments;
}

describe('LeveledCompactionStrategy', () => {
  let strategy: LeveledCompactionStrategy;
  let checkpointMetrics: CheckpointMetrics;

  beforeEach(() => {
    strategy = new LeveledCompactionStrategy({
      maxLevels: 7,
      levelSizeMultiplier: 10,
      level0SegmentLimit: 4,
      baseLevelSize: 10 * 1024 * 1024, // 10MB
    });

    checkpointMetrics = {
      lastCheckpointLSN: 50,
      lastCheckpointAge: 3600_000,
      segmentsSinceCheckpoint: 2,
    };
  });

  // ----------------------------------------------------------------
  // shouldCompact
  // ----------------------------------------------------------------
  describe('shouldCompact', () => {
    test('returns false when all metrics are below thresholds', () => {
      const metrics: WALMetrics = {
        segmentCount: 2,
        totalSizeBytes: 1024,
        oldestSegmentAge: 1000,
        tombstoneRatio: 0.1,
        duplicateEntryRatio: 0.05,
      };
      expect(strategy.shouldCompact(metrics, checkpointMetrics)).toBe(false);
    });

    test('returns true when segment count exceeds level0SegmentLimit', () => {
      const metrics: WALMetrics = {
        segmentCount: 5, // > 4
        totalSizeBytes: 1024,
        oldestSegmentAge: 1000,
        tombstoneRatio: 0.1,
        duplicateEntryRatio: 0.05,
      };
      expect(strategy.shouldCompact(metrics, checkpointMetrics)).toBe(true);
    });

    test('returns true when total size exceeds baseLevelSize', () => {
      const metrics: WALMetrics = {
        segmentCount: 2,
        totalSizeBytes: 20 * 1024 * 1024, // 20MB > 10MB
        oldestSegmentAge: 1000,
        tombstoneRatio: 0.1,
        duplicateEntryRatio: 0.05,
      };
      expect(strategy.shouldCompact(metrics, checkpointMetrics)).toBe(true);
    });

    test('returns true when tombstone ratio is high', () => {
      const metrics: WALMetrics = {
        segmentCount: 2,
        totalSizeBytes: 1024,
        oldestSegmentAge: 1000,
        tombstoneRatio: 0.5, // > 0.3
        duplicateEntryRatio: 0.05,
      };
      expect(strategy.shouldCompact(metrics, checkpointMetrics)).toBe(true);
    });

    test('returns false when compaction is already running', () => {
      // Force isRunning via executeCompaction side-effect
      const metrics: WALMetrics = {
        segmentCount: 100,
        totalSizeBytes: 1024 * 1024 * 1024,
        oldestSegmentAge: 999999999,
        tombstoneRatio: 0.9,
        duplicateEntryRatio: 0.9,
      };

      // Access internal metrics to set isRunning
      (strategy as any).metrics.isRunning = true;
      expect(strategy.shouldCompact(metrics, checkpointMetrics)).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // planCompaction
  // ----------------------------------------------------------------
  describe('planCompaction', () => {
    test('returns null for empty segments', () => {
      expect(strategy.planCompaction([], checkpointMetrics)).toBeNull();
    });

    test('returns null for a single segment with no overlaps', () => {
      const segments = [makeSegment()];
      expect(strategy.planCompaction(segments, checkpointMetrics)).toBeNull();
    });

    test('produces a plan when level 0 exceeds segment limit', () => {
      // 6 small segments all in level 0 (< baseLevelSize)
      const segments = makeSegments(6, { sizeBytes: 1 * 1024 * 1024 });
      // Give them overlapping LSN ranges so they get picked up
      segments[1].startLSN = 50; // overlaps with seg-0 endLSN=100
      const plan = strategy.planCompaction(segments, checkpointMetrics);

      expect(plan).not.toBeNull();
      expect(plan!.planId).toMatch(/^leveled-/);
      expect(plan!.inputSegments.length).toBeGreaterThanOrEqual(2);
      expect(plan!.outputSegments.length).toBe(1);
      expect(plan!.estimatedSpaceSaved).toBeGreaterThan(0);
      expect(plan!.priority).toBe('high'); // L0 compaction is high priority
    });

    test('produces a plan for overlapping segments even without level overflow', () => {
      // Two segments with overlapping key (LSN) ranges
      const seg1 = makeSegment({ segmentId: 'a', startLSN: 1, endLSN: 200 });
      const seg2 = makeSegment({ segmentId: 'b', startLSN: 100, endLSN: 300 });
      const plan = strategy.planCompaction([seg1, seg2], checkpointMetrics);

      expect(plan).not.toBeNull();
      expect(plan!.inputSegments.length).toBe(2);
      expect(plan!.outputSegments[0].lsnRange.start).toBe(1);
      expect(plan!.outputSegments[0].lsnRange.end).toBe(300);
    });

    test('skips mutable segments', () => {
      const seg1 = makeSegment({ segmentId: 'a', startLSN: 1, endLSN: 200, isImmutable: false });
      const seg2 = makeSegment({ segmentId: 'b', startLSN: 100, endLSN: 300, isImmutable: false });
      const plan = strategy.planCompaction([seg1, seg2], checkpointMetrics);
      expect(plan).toBeNull();
    });

    test('plan output segment estimated size accounts for savings', () => {
      const segments = makeSegments(6, { sizeBytes: 2 * 1024 * 1024 });
      segments[1].startLSN = 50; // overlap
      const plan = strategy.planCompaction(segments, checkpointMetrics);

      if (plan) {
        const inputSize = plan.inputSegments.reduce((s, seg) => s + seg.sizeBytes, 0);
        const outputSize = plan.outputSegments[0].estimatedSize;
        expect(outputSize).toBeLessThan(inputSize);
        expect(plan.estimatedSpaceSaved).toBe(inputSize - outputSize);
      }
    });

    test('assigns large segments to higher levels and compacts when size exceeds target', () => {
      // Create segments large enough to be assigned to level 1 (> 10MB)
      const largeSegments = makeSegments(3, {
        sizeBytes: 15 * 1024 * 1024, // 15MB each, total 45MB > baseLevelSize 10MB
      });
      // Give overlapping ranges
      largeSegments[1].startLSN = 50;
      const plan = strategy.planCompaction(largeSegments, checkpointMetrics);

      expect(plan).not.toBeNull();
      expect(plan!.inputSegments.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ----------------------------------------------------------------
  // executeCompaction
  // ----------------------------------------------------------------
  describe('executeCompaction', () => {
    test('successfully executes a compaction plan', async () => {
      const segments = makeSegments(3, {
        sizeBytes: 1 * 1024 * 1024,
        entryCount: 1000,
        tombstoneCount: 200,
      });
      segments[1].startLSN = 50; // overlap

      const plan = strategy.planCompaction(segments, checkpointMetrics);
      expect(plan).not.toBeNull();

      const result = await strategy.executeCompaction(plan!);

      expect(result.success).toBe(true);
      expect(result.planId).toBe(plan!.planId);
      expect(result.segmentsDeleted.length).toBe(plan!.inputSegments.length);
      expect(result.segmentsCreated.length).toBe(1);
      expect(result.metrics.entriesProcessed).toBeGreaterThan(0);
      expect(result.metrics.tombstonesRemoved).toBeGreaterThan(0);
      expect(result.metrics.duplicatesRemoved).toBeGreaterThan(0);
      expect(result.actualSpaceSaved).toBeGreaterThan(0);
    });

    test('created segment has correct LSN range', async () => {
      const seg1 = makeSegment({ segmentId: 'a', startLSN: 10, endLSN: 200 });
      const seg2 = makeSegment({ segmentId: 'b', startLSN: 100, endLSN: 500 });
      const plan = strategy.planCompaction([seg1, seg2], checkpointMetrics);
      expect(plan).not.toBeNull();

      const result = await strategy.executeCompaction(plan!);
      expect(result.segmentsCreated[0].startLSN).toBe(10);
      expect(result.segmentsCreated[0].endLSN).toBe(500);
    });

    test('created segment has zero tombstones after compaction', async () => {
      const seg1 = makeSegment({ segmentId: 'a', startLSN: 1, endLSN: 200, tombstoneCount: 500 });
      const seg2 = makeSegment({ segmentId: 'b', startLSN: 100, endLSN: 300, tombstoneCount: 300 });
      const plan = strategy.planCompaction([seg1, seg2], checkpointMetrics);

      const result = await strategy.executeCompaction(plan!);
      expect(result.segmentsCreated[0].tombstoneCount).toBe(0);
    });

    test('updates strategy metrics after execution', async () => {
      const seg1 = makeSegment({ segmentId: 'a', startLSN: 1, endLSN: 200 });
      const seg2 = makeSegment({ segmentId: 'b', startLSN: 100, endLSN: 300 });
      const plan = strategy.planCompaction([seg1, seg2], checkpointMetrics);

      await strategy.executeCompaction(plan!);

      const metrics = strategy.getMetrics();
      expect(metrics.totalRuns).toBe(1);
      expect(metrics.successfulRuns).toBe(1);
      expect(metrics.totalSpaceSaved).toBeGreaterThan(0);
      expect(metrics.isRunning).toBe(false);
    });

    test('isRunning is false after execution completes', async () => {
      const seg1 = makeSegment({ segmentId: 'a', startLSN: 1, endLSN: 200 });
      const seg2 = makeSegment({ segmentId: 'b', startLSN: 100, endLSN: 300 });
      const plan = strategy.planCompaction([seg1, seg2], checkpointMetrics);

      await strategy.executeCompaction(plan!);
      expect(strategy.getMetrics().isRunning).toBe(false);
    });

    test('handles plan with no entries gracefully', async () => {
      const plan: CompactionPlan = {
        planId: 'empty-plan',
        inputSegments: [
          makeSegment({ entryCount: 0, tombstoneCount: 0, sizeBytes: 0 }),
          makeSegment({ entryCount: 0, tombstoneCount: 0, sizeBytes: 0 }),
        ],
        outputSegments: [{
          segmentId: 'compacted-empty',
          estimatedSize: 0,
          lsnRange: { start: 1, end: 100 },
        }],
        estimatedSpaceSaved: 0,
        estimatedDuration: 10,
        priority: 'low',
      };

      const result = await strategy.executeCompaction(plan);
      expect(result.success).toBe(true);
      expect(result.metrics.entriesProcessed).toBe(0);
      expect(result.actualSpaceSaved).toBe(0);
    });
  });

  // ----------------------------------------------------------------
  // Priority calculation
  // ----------------------------------------------------------------
  describe('priority', () => {
    test('L0 compaction has high priority', () => {
      const segments = makeSegments(6, { sizeBytes: 1 * 1024 * 1024 });
      segments[1].startLSN = 50; // overlap
      const plan = strategy.planCompaction(segments, checkpointMetrics);
      expect(plan).not.toBeNull();
      expect(['high', 'urgent']).toContain(plan!.priority);
    });
  });

  // ----------------------------------------------------------------
  // Configuration
  // ----------------------------------------------------------------
  describe('configuration', () => {
    test('uses default values when no config provided', () => {
      const defaultStrategy = new LeveledCompactionStrategy();
      const metrics = defaultStrategy.getMetrics();
      expect(metrics.strategy).toBe('LeveledCompactionStrategy');
    });

    test('custom level0SegmentLimit changes trigger threshold', () => {
      const customStrategy = new LeveledCompactionStrategy({ level0SegmentLimit: 10 });
      const metrics: WALMetrics = {
        segmentCount: 8, // > 4 default, but < 10 custom
        totalSizeBytes: 1024,
        oldestSegmentAge: 1000,
        tombstoneRatio: 0.1,
        duplicateEntryRatio: 0.05,
      };
      expect(customStrategy.shouldCompact(metrics, checkpointMetrics)).toBe(false);
    });

    test('custom baseLevelSize changes size trigger threshold', () => {
      const customStrategy = new LeveledCompactionStrategy({
        baseLevelSize: 500 * 1024 * 1024, // 500MB
      });
      const metrics: WALMetrics = {
        segmentCount: 2,
        totalSizeBytes: 100 * 1024 * 1024, // 100MB, below 500MB threshold
        oldestSegmentAge: 1000,
        tombstoneRatio: 0.1,
        duplicateEntryRatio: 0.05,
      };
      expect(customStrategy.shouldCompact(metrics, checkpointMetrics)).toBe(false);
    });
  });
});
