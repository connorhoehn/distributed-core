import { LeveledCompactionStrategy } from '../../../../src/persistence/compaction/LeveledCompactionStrategy';
import { WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan } from '../../../../src/persistence/compaction/types';

describe('LeveledCompactionStrategy', () => {
  let mockWALMetrics: WALMetrics;
  let mockCheckpointMetrics: CheckpointMetrics;
  let mockSegments: WALSegment[];

  beforeEach(() => {
    mockWALMetrics = {
      segmentCount: 5,
      totalSizeBytes: 500 * 1024 * 1024,
      oldestSegmentAge: 48 * 60 * 60 * 1000,
      tombstoneRatio: 0.25,
      duplicateEntryRatio: 0.15
    };

    mockCheckpointMetrics = {
      lastCheckpointLSN: 1000,
      lastCheckpointAge: 12 * 60 * 60 * 1000,
      segmentsSinceCheckpoint: 3
    };

    mockSegments = [
      {
        segmentId: 'segment-001',
        filePath: '/data/wal/segment-001.wal',
        startLSN: 1,
        endLSN: 500,
        createdAt: Date.now() - 48 * 60 * 60 * 1000,
        sizeBytes: 100 * 1024 * 1024,
        entryCount: 5000,
        tombstoneCount: 1250,
        isImmutable: true
      }
    ];
  });

  describe('shouldCompact()', () => {
    test('returns false when segmentCount is below level0SegmentLimit', () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 10 });
      const lowMetrics: WALMetrics = { ...mockWALMetrics, segmentCount: 3, totalSizeBytes: 1024 };
      expect(strategy.shouldCompact(lowMetrics, mockCheckpointMetrics)).toBe(false);
    });

    test('returns true when segmentCount equals level0SegmentLimit (default 4)', () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 4 });
      const metrics: WALMetrics = { ...mockWALMetrics, segmentCount: 4, totalSizeBytes: 1024 };
      expect(strategy.shouldCompact(metrics, mockCheckpointMetrics)).toBe(true);
    });

    test('returns true when segmentCount exceeds level0SegmentLimit (default 4)', () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 4 });
      // segmentCount=5 >= level0SegmentLimit=4
      expect(strategy.shouldCompact(mockWALMetrics, mockCheckpointMetrics)).toBe(true);
    });

    test('returns true when total size exceeds level-1 target spillover', () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 100 });
      // baseLevelSize=10MB, levelSizeMultiplier=10
      // level1Target = 10MB * 10^1 = 100MB
      // threshold = level1Target * levelSizeMultiplier = 100MB * 10 = 1000MB
      // Use totalSizeBytes > 1000MB to trigger spillover
      const largeMetrics: WALMetrics = {
        ...mockWALMetrics,
        segmentCount: 1,
        totalSizeBytes: 1100 * 1024 * 1024  // 1100MB > 1000MB
      };
      expect(strategy.shouldCompact(largeMetrics, mockCheckpointMetrics)).toBe(true);
    });

    test('returns false when isRunning=true', () => {
      // Force isRunning to true by accessing the protected metrics via casting
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 2 });
      (strategy as any).metrics.isRunning = true;
      // segmentCount=5 >= level0SegmentLimit=2 would normally trigger — but isRunning guard fires first
      expect(strategy.shouldCompact(mockWALMetrics, mockCheckpointMetrics)).toBe(false);
    });
  });

  describe('planCompaction()', () => {
    test('returns null for empty segment list', () => {
      const strategy = new LeveledCompactionStrategy();
      expect(strategy.planCompaction([], mockCheckpointMetrics)).toBeNull();
    });

    test('returns null for fewer than 2 immutable segments', () => {
      const strategy = new LeveledCompactionStrategy();
      // Only 1 segment — not enough to merge
      expect(strategy.planCompaction(mockSegments, mockCheckpointMetrics)).toBeNull();
    });

    test('returns null when segments are mutable (non-immutable)', () => {
      const strategy = new LeveledCompactionStrategy();
      const mutableSegments: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', isImmutable: false },
        { ...mockSegments[0], segmentId: 'seg-2', isImmutable: false }
      ];
      expect(strategy.planCompaction(mutableSegments, mockCheckpointMetrics)).toBeNull();
    });

    test('returns a valid plan when 2+ overlapping immutable segments exist', () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 2 });
      const twoSegments: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 500 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 400, endLSN: 900 }
      ];
      const plan = strategy.planCompaction(twoSegments, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      expect(plan!.planId).toBeDefined();
      expect(plan!.inputSegments.length).toBeGreaterThanOrEqual(2);
    });

    test('plan inputSegments are all immutable', () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 2 });
      const segments: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 500, isImmutable: true },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 400, endLSN: 900, isImmutable: true },
        { ...mockSegments[0], segmentId: 'seg-3', startLSN: 800, endLSN: 1200, isImmutable: false }
      ];
      const plan = strategy.planCompaction(segments, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      for (const seg of plan!.inputSegments) {
        expect(seg.isImmutable).toBe(true);
      }
    });

    test('plan has valid outputSegments with lsnRange', () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 2 });
      const twoSegments: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 500 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 400, endLSN: 900 }
      ];
      const plan = strategy.planCompaction(twoSegments, mockCheckpointMetrics)!;
      expect(plan.outputSegments.length).toBeGreaterThan(0);
      const out = plan.outputSegments[0];
      expect(out.lsnRange.start).toBeLessThan(out.lsnRange.end);
    });
  });

  describe('findOverlappingSegments() — interval merge behaviour', () => {
    test('groups two segments with overlapping LSN ranges', () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 2 });
      const overlapping: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 500 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 400, endLSN: 900 }
      ];
      const plan = strategy.planCompaction(overlapping, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();
      // Both overlapping segments must appear in the plan
      const ids = plan.inputSegments.map(s => s.segmentId);
      expect(ids).toContain('seg-1');
      expect(ids).toContain('seg-2');
    });

    test('does not merge non-overlapping segments into the same group', () => {
      // seg-1: [1,100], seg-2: [200,300] — no overlap → each forms its own 1-element group
      // planCompaction should skip single-element groups, so overall result depends on
      // level0SegmentLimit. With limit=2 both segments land in level-0 which is overloaded
      // (2 >= 2), so the fallback uses all levelSegments (both), not the overlapping groups.
      // Use a high level0SegmentLimit to ensure we exercise the overlapping-group path only.
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 10 });
      const nonOverlapping: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 100 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 200, endLSN: 300 }
      ];
      // No overlapping groups AND level not overloaded → null
      const plan = strategy.planCompaction(nonOverlapping, mockCheckpointMetrics);
      expect(plan).toBeNull();
    });

    test('merges a chain of three overlapping segments into one group', () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 2 });
      const chain: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 300 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 200, endLSN: 500 },
        { ...mockSegments[0], segmentId: 'seg-3', startLSN: 400, endLSN: 700 }
      ];
      const plan = strategy.planCompaction(chain, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();
      expect(plan.inputSegments.length).toBe(3);
    });

    test('a segment that overlaps an earlier-but-not-last member is still merged', () => {
      // seg-1:[1,900], seg-2:[800,1000], seg-3:[950,1100]
      // After sorting: seg-1 opens group with maxEnd=900, seg-2 overlaps (800<=900 → maxEnd=1000),
      // seg-3 overlaps (950<=1000 → all three in one group).
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 2 });
      const segments: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 900 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 800, endLSN: 1000 },
        { ...mockSegments[0], segmentId: 'seg-3', startLSN: 950, endLSN: 1100 }
      ];
      const plan = strategy.planCompaction(segments, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();
      expect(plan.inputSegments.length).toBe(3);
    });
  });

  describe('executeCompaction()', () => {
    function makePlan(segments: WALSegment[]): CompactionPlan {
      return {
        planId: 'test-leveled-plan',
        inputSegments: segments,
        outputSegments: [{
          segmentId: 'leveled-out-1',
          estimatedSize: 50 * 1024 * 1024,
          lsnRange: {
            start: Math.min(...segments.map(s => s.startLSN)),
            end: Math.max(...segments.map(s => s.endLSN))
          }
        }],
        estimatedSpaceSaved: 50 * 1024 * 1024,
        estimatedDuration: 100,
        priority: 'medium'
      };
    }

    test('returns success=true with a valid plan', async () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 2 });
      const twoSegments: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 500 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 400, endLSN: 900 }
      ];
      const plan = strategy.planCompaction(twoSegments, mockCheckpointMetrics)!;
      const result = await strategy.executeCompaction(plan);
      expect(result.success).toBe(true);
      expect(result.planId).toBe(plan.planId);
    });

    test('result includes tombstonesRemoved count', async () => {
      const strategy = new LeveledCompactionStrategy();
      const twoSegs: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 500, tombstoneCount: 500 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 400, endLSN: 900, tombstoneCount: 300 }
      ];
      const plan = makePlan(twoSegs);
      const result = await strategy.executeCompaction(plan);
      // 500 + 300 = 800 tombstones across both segments
      expect(result.metrics.tombstonesRemoved).toBe(800);
    });

    test('result.segmentsDeleted matches plan.inputSegments', async () => {
      const strategy = new LeveledCompactionStrategy();
      const twoSegs: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-alpha', startLSN: 1, endLSN: 500 },
        { ...mockSegments[0], segmentId: 'seg-beta', startLSN: 400, endLSN: 900 }
      ];
      const plan = makePlan(twoSegs);
      const result = await strategy.executeCompaction(plan);
      expect(result.segmentsDeleted).toEqual(['seg-alpha', 'seg-beta']);
    });

    test('tombstonesRemoved is 0 when input segments have no tombstones', async () => {
      const strategy = new LeveledCompactionStrategy();
      const cleanSegs: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 500, tombstoneCount: 0 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 400, endLSN: 900, tombstoneCount: 0 }
      ];
      const plan = makePlan(cleanSegs);
      const result = await strategy.executeCompaction(plan);
      expect(result.metrics.tombstonesRemoved).toBe(0);
    });
  });

  describe('custom config', () => {
    test('level0SegmentLimit is respected in shouldCompact', () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 6 });
      const fiveSegMetrics: WALMetrics = { ...mockWALMetrics, segmentCount: 5, totalSizeBytes: 1024 };
      expect(strategy.shouldCompact(fiveSegMetrics, mockCheckpointMetrics)).toBe(false);

      const sixSegMetrics: WALMetrics = { ...mockWALMetrics, segmentCount: 6, totalSizeBytes: 1024 };
      expect(strategy.shouldCompact(sixSegMetrics, mockCheckpointMetrics)).toBe(true);
    });

    test('maxLevels and levelSizeMultiplier are accepted without error', () => {
      const strategy = new LeveledCompactionStrategy({
        maxLevels: 8,
        levelSizeMultiplier: 12,
        level0SegmentLimit: 6
      });
      expect(strategy).toBeInstanceOf(LeveledCompactionStrategy);
    });
  });

  describe('getMetrics()', () => {
    test('shows isRunning=false before any execution', () => {
      const strategy = new LeveledCompactionStrategy();
      expect(strategy.getMetrics().isRunning).toBe(false);
    });

    test('shows isRunning=false after execution completes', async () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 2 });
      const twoSegs: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 500 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 400, endLSN: 900 }
      ];
      const plan = strategy.planCompaction(twoSegs, mockCheckpointMetrics)!;
      await strategy.executeCompaction(plan);
      expect(strategy.getMetrics().isRunning).toBe(false);
    });

    test('totalRuns increments after each execution', async () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 2 });
      const twoSegs: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 500 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 400, endLSN: 900 }
      ];
      const plan = strategy.planCompaction(twoSegs, mockCheckpointMetrics)!;
      expect(strategy.getMetrics().totalRuns).toBe(0);
      await strategy.executeCompaction(plan);
      expect(strategy.getMetrics().totalRuns).toBe(1);
      await strategy.executeCompaction(plan);
      expect(strategy.getMetrics().totalRuns).toBe(2);
    });

    test('strategy name is LeveledCompactionStrategy', () => {
      const strategy = new LeveledCompactionStrategy();
      expect(strategy.getMetrics().strategy).toBe('LeveledCompactionStrategy');
    });
  });
});
