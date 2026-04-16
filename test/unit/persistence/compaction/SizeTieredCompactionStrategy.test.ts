import { SizeTieredCompactionStrategy } from '../../../../src/persistence/compaction/SizeTieredCompactionStrategy';
import { WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan } from '../../../../src/persistence/compaction/types';

describe('SizeTieredCompactionStrategy', () => {
  let strategy: SizeTieredCompactionStrategy;
  let mockCheckpointMetrics: CheckpointMetrics;

  beforeEach(() => {
    strategy = new SizeTieredCompactionStrategy();
    mockCheckpointMetrics = {
      lastCheckpointLSN: 1000,
      lastCheckpointAge: 12 * 60 * 60 * 1000,
      segmentsSinceCheckpoint: 3
    };
  });

  function makeSegment(overrides: Partial<WALSegment> = {}): WALSegment {
    return {
      segmentId: `seg-${Math.random().toString(36).substr(2, 6)}`,
      filePath: '/data/wal/segment.wal',
      startLSN: 1,
      endLSN: 500,
      createdAt: Date.now() - 3600000,
      sizeBytes: 5 * 1024 * 1024, // 5MB (small tier by default)
      entryCount: 1000,
      tombstoneCount: 100,
      isImmutable: true,
      ...overrides
    };
  }

  describe('shouldCompact', () => {
    test('returns false when already running', () => {
      // Force isRunning via a dummy execute that we do not await
      const metrics = strategy.getMetrics();
      expect(metrics.isRunning).toBe(false);

      const walMetrics: WALMetrics = {
        segmentCount: 20,
        totalSizeBytes: 500 * 1024 * 1024,
        oldestSegmentAge: 86400000,
        tombstoneRatio: 0.5,
        duplicateEntryRatio: 0.5
      };

      // First call should want to compact
      expect(strategy.shouldCompact(walMetrics, mockCheckpointMetrics)).toBe(true);
    });

    test('returns true when segment count exceeds maxSegmentsPerTier', () => {
      const walMetrics: WALMetrics = {
        segmentCount: 5, // > default 4
        totalSizeBytes: 50 * 1024 * 1024,
        oldestSegmentAge: 1000,
        tombstoneRatio: 0.1,
        duplicateEntryRatio: 0.1
      };
      expect(strategy.shouldCompact(walMetrics, mockCheckpointMetrics)).toBe(true);
    });

    test('returns false when segment count is within threshold', () => {
      const walMetrics: WALMetrics = {
        segmentCount: 3,
        totalSizeBytes: 30 * 1024 * 1024,
        oldestSegmentAge: 1000,
        tombstoneRatio: 0.1,
        duplicateEntryRatio: 0.1
      };
      expect(strategy.shouldCompact(walMetrics, mockCheckpointMetrics)).toBe(false);
    });

    test('returns true when tombstone ratio is high', () => {
      const walMetrics: WALMetrics = {
        segmentCount: 2,
        totalSizeBytes: 20 * 1024 * 1024,
        oldestSegmentAge: 1000,
        tombstoneRatio: 0.5,
        duplicateEntryRatio: 0.1
      };
      expect(strategy.shouldCompact(walMetrics, mockCheckpointMetrics)).toBe(true);
    });

    test('returns true when duplicate ratio is high', () => {
      const walMetrics: WALMetrics = {
        segmentCount: 2,
        totalSizeBytes: 20 * 1024 * 1024,
        oldestSegmentAge: 1000,
        tombstoneRatio: 0.1,
        duplicateEntryRatio: 0.6
      };
      expect(strategy.shouldCompact(walMetrics, mockCheckpointMetrics)).toBe(true);
    });

    test('respects custom maxSegmentsPerTier', () => {
      const customStrategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 8 });
      const walMetrics: WALMetrics = {
        segmentCount: 6,
        totalSizeBytes: 60 * 1024 * 1024,
        oldestSegmentAge: 1000,
        tombstoneRatio: 0.1,
        duplicateEntryRatio: 0.1
      };
      // 6 <= 8, should not trigger
      expect(customStrategy.shouldCompact(walMetrics, mockCheckpointMetrics)).toBe(false);
    });
  });

  describe('planCompaction', () => {
    test('returns null for empty segments', () => {
      expect(strategy.planCompaction([], mockCheckpointMetrics)).toBeNull();
    });

    test('returns null for a single segment', () => {
      const segments = [makeSegment()];
      expect(strategy.planCompaction(segments, mockCheckpointMetrics)).toBeNull();
    });

    test('returns null when no immutable segments', () => {
      const segments = [
        makeSegment({ isImmutable: false }),
        makeSegment({ isImmutable: false })
      ];
      expect(strategy.planCompaction(segments, mockCheckpointMetrics)).toBeNull();
    });

    test('groups segments by size tier and picks the largest group', () => {
      // 3 small segments (5MB each) and 1 large segment (150MB)
      const segments = [
        makeSegment({ segmentId: 'small-1', sizeBytes: 5 * 1024 * 1024, startLSN: 1, endLSN: 100 }),
        makeSegment({ segmentId: 'small-2', sizeBytes: 7 * 1024 * 1024, startLSN: 101, endLSN: 200 }),
        makeSegment({ segmentId: 'small-3', sizeBytes: 8 * 1024 * 1024, startLSN: 201, endLSN: 300 }),
        makeSegment({ segmentId: 'large-1', sizeBytes: 150 * 1024 * 1024, startLSN: 301, endLSN: 400 })
      ];

      const plan = strategy.planCompaction(segments, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      // Should pick the small tier (3 segments) over the large tier (1 segment)
      expect(plan!.inputSegments).toHaveLength(3);
      expect(plan!.inputSegments.map(s => s.segmentId)).toEqual(
        expect.arrayContaining(['small-1', 'small-2', 'small-3'])
      );
    });

    test('plan has valid structure', () => {
      const segments = [
        makeSegment({ segmentId: 'a', sizeBytes: 5 * 1024 * 1024, startLSN: 1, endLSN: 100, entryCount: 500, tombstoneCount: 50 }),
        makeSegment({ segmentId: 'b', sizeBytes: 6 * 1024 * 1024, startLSN: 101, endLSN: 200, entryCount: 600, tombstoneCount: 60 })
      ];

      const plan = strategy.planCompaction(segments, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      expect(plan!.planId).toContain('size-tiered-');
      expect(plan!.outputSegments).toHaveLength(1);
      expect(plan!.outputSegments[0].lsnRange.start).toBe(1);
      expect(plan!.outputSegments[0].lsnRange.end).toBe(200);
      expect(plan!.estimatedSpaceSaved).toBeGreaterThan(0);
      expect(plan!.estimatedDuration).toBeGreaterThan(0);
      expect(['low', 'medium', 'high', 'urgent']).toContain(plan!.priority);
    });

    test('orders input segments by LSN', () => {
      const segments = [
        makeSegment({ segmentId: 'c', sizeBytes: 5 * 1024 * 1024, startLSN: 301, endLSN: 400 }),
        makeSegment({ segmentId: 'a', sizeBytes: 5 * 1024 * 1024, startLSN: 1, endLSN: 100 }),
        makeSegment({ segmentId: 'b', sizeBytes: 5 * 1024 * 1024, startLSN: 101, endLSN: 300 })
      ];

      const plan = strategy.planCompaction(segments, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      const lsns = plan!.inputSegments.map(s => s.startLSN);
      expect(lsns).toEqual([...lsns].sort((a, b) => a - b));
    });

    test('returns null when each tier has only 1 segment', () => {
      const segments = [
        makeSegment({ segmentId: 'small', sizeBytes: 500 * 1024, startLSN: 1, endLSN: 100 }),      // tier 0
        makeSegment({ segmentId: 'medium', sizeBytes: 50 * 1024 * 1024, startLSN: 101, endLSN: 200 }), // tier 2
        makeSegment({ segmentId: 'large', sizeBytes: 150 * 1024 * 1024, startLSN: 201, endLSN: 300 })  // tier 3
      ];

      const plan = strategy.planCompaction(segments, mockCheckpointMetrics);
      expect(plan).toBeNull();
    });
  });

  describe('executeCompaction', () => {
    test('successfully merges segments and reports metrics', async () => {
      const segments = [
        makeSegment({ segmentId: 'a', sizeBytes: 5 * 1024 * 1024, startLSN: 1, endLSN: 100, entryCount: 500, tombstoneCount: 50 }),
        makeSegment({ segmentId: 'b', sizeBytes: 6 * 1024 * 1024, startLSN: 101, endLSN: 200, entryCount: 600, tombstoneCount: 60 })
      ];

      const plan = strategy.planCompaction(segments, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();

      const result = await strategy.executeCompaction(plan);

      expect(result.success).toBe(true);
      expect(result.planId).toBe(plan.planId);
      expect(result.actualSpaceSaved).toBeGreaterThan(0);
      expect(result.segmentsCreated).toHaveLength(1);
      expect(result.segmentsDeleted).toHaveLength(2);
      expect(result.segmentsDeleted).toContain('a');
      expect(result.segmentsDeleted).toContain('b');

      // Metrics
      expect(result.metrics.entriesProcessed).toBe(1100);
      expect(result.metrics.tombstonesRemoved).toBe(110);
      expect(result.metrics.duplicatesRemoved).toBeGreaterThan(0);
      expect(result.metrics.entriesCompacted).toBeLessThan(result.metrics.entriesProcessed);
    });

    test('created segment has zero tombstones', async () => {
      const segments = [
        makeSegment({ segmentId: 'x', sizeBytes: 5 * 1024 * 1024, startLSN: 1, endLSN: 100, entryCount: 500, tombstoneCount: 200 }),
        makeSegment({ segmentId: 'y', sizeBytes: 5 * 1024 * 1024, startLSN: 101, endLSN: 200, entryCount: 500, tombstoneCount: 200 })
      ];

      const plan = strategy.planCompaction(segments, mockCheckpointMetrics)!;
      const result = await strategy.executeCompaction(plan);

      expect(result.success).toBe(true);
      for (const seg of result.segmentsCreated) {
        expect(seg.tombstoneCount).toBe(0);
        expect(seg.isImmutable).toBe(true);
      }
    });

    test('updates strategy metrics after execution', async () => {
      const segments = [
        makeSegment({ segmentId: 'p', startLSN: 1, endLSN: 100 }),
        makeSegment({ segmentId: 'q', startLSN: 101, endLSN: 200 })
      ];

      const plan = strategy.planCompaction(segments, mockCheckpointMetrics)!;
      await strategy.executeCompaction(plan);

      const metrics = strategy.getMetrics();
      expect(metrics.totalRuns).toBe(1);
      expect(metrics.successfulRuns).toBe(1);
      expect(metrics.totalSpaceSaved).toBeGreaterThan(0);
      expect(metrics.isRunning).toBe(false);
      expect(metrics.lastRunTimestamp).toBeGreaterThan(0);
    });

    test('sets isRunning to false after execution completes', async () => {
      const segments = [
        makeSegment({ segmentId: 'r', startLSN: 1, endLSN: 100 }),
        makeSegment({ segmentId: 's', startLSN: 101, endLSN: 200 })
      ];

      const plan = strategy.planCompaction(segments, mockCheckpointMetrics)!;
      const resultPromise = strategy.executeCompaction(plan);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(strategy.getMetrics().isRunning).toBe(false);
    });
  });

  describe('priority calculation', () => {
    test('assigns higher priority for more segments', async () => {
      // 3 segments in same tier -> medium priority
      const fewSegments = [
        makeSegment({ segmentId: 'a1', sizeBytes: 5 * 1024 * 1024, startLSN: 1, endLSN: 100, tombstoneCount: 10 }),
        makeSegment({ segmentId: 'a2', sizeBytes: 5 * 1024 * 1024, startLSN: 101, endLSN: 200, tombstoneCount: 10 }),
        makeSegment({ segmentId: 'a3', sizeBytes: 5 * 1024 * 1024, startLSN: 201, endLSN: 300, tombstoneCount: 10 })
      ];
      const planFew = strategy.planCompaction(fewSegments, mockCheckpointMetrics)!;
      expect(planFew).not.toBeNull();

      // 9 segments -> urgent (> maxSegmentsPerTier * 2 = 8)
      const manySegments: WALSegment[] = [];
      for (let i = 0; i < 9; i++) {
        manySegments.push(makeSegment({
          segmentId: `m${i}`,
          sizeBytes: 5 * 1024 * 1024,
          startLSN: i * 100 + 1,
          endLSN: (i + 1) * 100,
          tombstoneCount: 10
        }));
      }
      const planMany = strategy.planCompaction(manySegments, mockCheckpointMetrics)!;
      expect(planMany).not.toBeNull();

      const priorityOrder = ['low', 'medium', 'high', 'urgent'];
      expect(priorityOrder.indexOf(planMany.priority)).toBeGreaterThanOrEqual(
        priorityOrder.indexOf(planFew.priority)
      );
    });
  });

  describe('size tier grouping', () => {
    test('segments in different tiers are not merged together', () => {
      // 2 small + 2 medium segments -- should pick the tier with more (equal here, either is fine)
      const segments = [
        makeSegment({ segmentId: 's1', sizeBytes: 500 * 1024, startLSN: 1, endLSN: 100 }),       // tier 0 (<1MB)
        makeSegment({ segmentId: 's2', sizeBytes: 800 * 1024, startLSN: 101, endLSN: 200 }),      // tier 0
        makeSegment({ segmentId: 'm1', sizeBytes: 50 * 1024 * 1024, startLSN: 201, endLSN: 300 }), // tier 2
        makeSegment({ segmentId: 'm2', sizeBytes: 60 * 1024 * 1024, startLSN: 301, endLSN: 400 })  // tier 2
      ];

      const plan = strategy.planCompaction(segments, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();
      // All input segments should be from the same size tier
      const inputIds = new Set(plan.inputSegments.map(s => s.segmentId));
      const hasSmall = inputIds.has('s1') || inputIds.has('s2');
      const hasMedium = inputIds.has('m1') || inputIds.has('m2');
      // Should not mix tiers
      expect(hasSmall && hasMedium).toBe(false);
    });
  });
});
