import { SizeTieredCompactionStrategy } from '../../../../src/persistence/compaction/SizeTieredCompactionStrategy';
import { VacuumBasedCompactionStrategy } from '../../../../src/persistence/compaction/VacuumBasedCompactionStrategy';
import { LeveledCompactionStrategy } from '../../../../src/persistence/compaction/LeveledCompactionStrategy';
import { WALMetrics, CheckpointMetrics, WALSegment } from '../../../../src/persistence/compaction/types';

describe('Compaction Strategies', () => {
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

  describe('SizeTieredCompactionStrategy', () => {
    test('should initialize with default configuration', () => {
      const strategy = new SizeTieredCompactionStrategy();
      expect(strategy).toBeInstanceOf(SizeTieredCompactionStrategy);
    });

    test('should accept custom configuration', () => {
      const strategy = new SizeTieredCompactionStrategy({
        sizeTiers: [2 * 1024 * 1024, 20 * 1024 * 1024, 200 * 1024 * 1024],
        maxSegmentsPerTier: 8,
        minSegmentSize: 2 * 1024 * 1024
      });
      expect(strategy).toBeInstanceOf(SizeTieredCompactionStrategy);
    });

    test('shouldCompact returns false when segment count is below threshold', () => {
      const strategy = new SizeTieredCompactionStrategy();
      const low = { ...mockWALMetrics, segmentCount: 1, tombstoneRatio: 0 };
      expect(strategy.shouldCompact(low, mockCheckpointMetrics)).toBe(false);
    });

    test('shouldCompact returns true when segment count reaches maxSegmentsPerTier', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 4 });
      const high = { ...mockWALMetrics, segmentCount: 4, tombstoneRatio: 0 };
      expect(strategy.shouldCompact(high, mockCheckpointMetrics)).toBe(true);
    });

    test('planCompaction returns null when no tier has enough segments', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 4 });
      // only 1 segment — can't form a tier
      expect(strategy.planCompaction([mockSegments[0]], mockCheckpointMetrics)).toBeNull();
    });

    test('should return initial metrics', () => {
      const strategy = new SizeTieredCompactionStrategy();
      const metrics = strategy.getMetrics();

      expect(metrics.totalRuns).toBe(0);
      expect(metrics.isRunning).toBe(false);
      expect(metrics.strategy).toBe('SizeTieredCompactionStrategy');
    });

    test('executeCompaction returns success for a valid plan', async () => {
      const strategy = new SizeTieredCompactionStrategy();
      const mockPlan = {
        planId: 'test-plan',
        inputSegments: mockSegments,
        outputSegments: [{
          segmentId: 'size-tiered-T1-output',
          estimatedSize: 500,
          lsnRange: { start: 1, end: 10 }
        }],
        estimatedSpaceSaved: 500,
        estimatedDuration: 100,
        priority: 'medium' as const
      };
      const result = await strategy.executeCompaction(mockPlan);
      expect(result.success).toBe(true);
      expect(result.planId).toBe('test-plan');
    });
  });

  describe('VacuumBasedCompactionStrategy', () => {
    test('should initialize with default configuration', () => {
      const strategy = new VacuumBasedCompactionStrategy();
      expect(strategy).toBeInstanceOf(VacuumBasedCompactionStrategy);
    });

    test('should accept custom configuration', () => {
      const strategy = new VacuumBasedCompactionStrategy({
        deadTupleThreshold: 0.15,
        fragmentationThreshold: 0.25,
        vacuumIntervalMs: 30 * 60 * 1000
      });
      expect(strategy).toBeInstanceOf(VacuumBasedCompactionStrategy);
    });

    test('should trigger compaction when tombstone ratio exceeds threshold', () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.2 });
      // tombstoneRatio=0.25 >= deadTupleThreshold=0.2
      expect(strategy.shouldCompact(mockWALMetrics, mockCheckpointMetrics)).toBe(true);
    });

    test('should not trigger compaction when metrics are below threshold', () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.5, fragmentationThreshold: 0.5 });
      const lowMetrics: WALMetrics = { ...mockWALMetrics, tombstoneRatio: 0.1, duplicateEntryRatio: 0.1 };
      expect(strategy.shouldCompact(lowMetrics, mockCheckpointMetrics)).toBe(false);
    });

    test('should plan compaction for segments with high dead-tuple ratio', () => {
      const strategy = new VacuumBasedCompactionStrategy();
      // segment has tombstoneCount=1250 / entryCount=5000 → deadTupleRatio=0.5 — well above threshold
      const plan = strategy.planCompaction(mockSegments, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      expect(plan!.inputSegments.length).toBeGreaterThan(0);
    });

    test('should return null plan when no segments exceed thresholds', () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.9, fragmentationThreshold: 0.9 });
      const cleanSegments: WALSegment[] = [{ ...mockSegments[0], tombstoneCount: 10 }];
      expect(strategy.planCompaction(cleanSegments, mockCheckpointMetrics)).toBeNull();
    });

    test('should return initial metrics', () => {
      const strategy = new VacuumBasedCompactionStrategy();
      const metrics = strategy.getMetrics();

      expect(metrics.totalRuns).toBe(0);
      expect(metrics.isRunning).toBe(false);
      expect(metrics.strategy).toBe('VacuumBasedCompactionStrategy');
    });

    test('should execute compaction and remove dead tuples', async () => {
      const strategy = new VacuumBasedCompactionStrategy();
      const plan = strategy.planCompaction(mockSegments, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();

      const result = await strategy.executeCompaction(plan);
      expect(result.success).toBe(true);
      expect(result.metrics.tombstonesRemoved).toBeGreaterThan(0);
      expect(result.actualSpaceSaved).toBeGreaterThan(0);
    });
  });

  describe('LeveledCompactionStrategy', () => {
    test('should initialize with default configuration', () => {
      const strategy = new LeveledCompactionStrategy();
      expect(strategy).toBeInstanceOf(LeveledCompactionStrategy);
    });

    test('should accept custom configuration', () => {
      const strategy = new LeveledCompactionStrategy({
        maxLevels: 8,
        levelSizeMultiplier: 12,
        level0SegmentLimit: 6
      });
      expect(strategy).toBeInstanceOf(LeveledCompactionStrategy);
    });

    test('should trigger compaction when segment count reaches level-0 limit', () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 4 });
      // segmentCount=5 >= level0SegmentLimit=4
      expect(strategy.shouldCompact(mockWALMetrics, mockCheckpointMetrics)).toBe(true);
    });

    test('should not trigger compaction below level-0 limit', () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 10 });
      const fewSegments: WALMetrics = { ...mockWALMetrics, segmentCount: 3, totalSizeBytes: 1024 };
      expect(strategy.shouldCompact(fewSegments, mockCheckpointMetrics)).toBe(false);
    });

    test('should return null plan when fewer than 2 immutable segments exist', () => {
      const strategy = new LeveledCompactionStrategy();
      // Only 1 segment — not enough to merge
      expect(strategy.planCompaction(mockSegments, mockCheckpointMetrics)).toBeNull();
    });

    test('should produce a plan when multiple immutable segments overlap', () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 2 });
      const twoSegments: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 500 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 400, endLSN: 900 }
      ];
      const plan = strategy.planCompaction(twoSegments, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      expect(plan!.inputSegments.length).toBeGreaterThanOrEqual(2);
    });

    test('should return initial metrics', () => {
      const strategy = new LeveledCompactionStrategy();
      const metrics = strategy.getMetrics();

      expect(metrics.totalRuns).toBe(0);
      expect(metrics.isRunning).toBe(false);
      expect(metrics.strategy).toBe('LeveledCompactionStrategy');
    });

    test('should execute compaction and produce a result', async () => {
      const strategy = new LeveledCompactionStrategy({ level0SegmentLimit: 2 });
      const twoSegments: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', startLSN: 1, endLSN: 500 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 400, endLSN: 900 }
      ];
      const plan = strategy.planCompaction(twoSegments, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();

      const result = await strategy.executeCompaction(plan);
      expect(result.success).toBe(true);
      expect(result.metrics.tombstonesRemoved).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Strategy consistency', () => {
    test('all strategies should have proper initial metrics structure', () => {
      const strategies = [
        new SizeTieredCompactionStrategy(),
        new VacuumBasedCompactionStrategy(),
        new LeveledCompactionStrategy()
      ];

      strategies.forEach(strategy => {
        const metrics = strategy.getMetrics();
        expect(metrics.totalRuns).toBe(0);
        expect(metrics.isRunning).toBe(false);
        expect(metrics.totalSpaceSaved).toBe(0);
        expect(metrics.strategy).toContain('CompactionStrategy');
      });
    });

    test('SizeTieredCompactionStrategy executes compaction successfully', async () => {
      const strategy = new SizeTieredCompactionStrategy();
      const mockPlan = {
        planId: 'test-plan',
        inputSegments: mockSegments,
        outputSegments: [{
          segmentId: 'size-tiered-T1-output',
          estimatedSize: 500,
          lsnRange: { start: 1, end: 10 }
        }],
        estimatedSpaceSaved: 500,
        estimatedDuration: 100,
        priority: 'medium' as const
      };
      // segmentCount=5 >= maxSegmentsPerTier=4 → shouldCompact returns true
      expect(strategy.shouldCompact(mockWALMetrics, mockCheckpointMetrics)).toBe(true);
      // Only 1 immutable segment — not enough to form a tier of 4 → null
      expect(strategy.planCompaction(mockSegments, mockCheckpointMetrics)).toBeNull();
      const result = await strategy.executeCompaction(mockPlan);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });
});
