import { SizeTieredCompactionStrategy } from '../../../../src/persistence/compaction/SizeTieredCompactionStrategy';
import { WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan } from '../../../../src/persistence/compaction/types';

// Tier boundaries (default config):
//   Tier 0: sizeBytes <= 1 MB  (1,048,576)
//   Tier 1: sizeBytes <= 10 MB (10,485,760)
//   Tier 2: sizeBytes <= 100 MB
//   Tier 3 (overflow): anything larger

const MB = 1024 * 1024;

describe('SizeTieredCompactionStrategy', () => {
  let mockWALMetrics: WALMetrics;
  let mockCheckpointMetrics: CheckpointMetrics;

  // Returns an immutable WALSegment with the given sizeBytes and LSN range
  function makeSegment(
    id: string,
    sizeBytes: number,
    opts: Partial<WALSegment> = {}
  ): WALSegment {
    return {
      segmentId: id,
      filePath: `/data/wal/${id}.wal`,
      startLSN: opts.startLSN ?? 1,
      endLSN: opts.endLSN ?? 100,
      createdAt: Date.now() - 3600_000,
      sizeBytes,
      entryCount: opts.entryCount ?? 1000,
      tombstoneCount: opts.tombstoneCount ?? 100,
      isImmutable: opts.isImmutable ?? true,
      ...opts
    };
  }

  // Build a CompactionPlan directly for executeCompaction tests
  function makePlan(segments: WALSegment[]): CompactionPlan {
    return {
      planId: 'test-size-tiered-plan',
      inputSegments: segments,
      outputSegments: [{
        segmentId: 'size-tiered-T1-output',
        estimatedSize: 50 * MB,
        lsnRange: {
          start: Math.min(...segments.map(s => s.startLSN)),
          end: Math.max(...segments.map(s => s.endLSN))
        }
      }],
      estimatedSpaceSaved: 50 * MB,
      estimatedDuration: 100,
      priority: 'medium'
    };
  }

  beforeEach(() => {
    mockWALMetrics = {
      segmentCount: 5,
      totalSizeBytes: 500 * MB,
      oldestSegmentAge: 48 * 60 * 60 * 1000,
      tombstoneRatio: 0.25,
      duplicateEntryRatio: 0.15
    };

    mockCheckpointMetrics = {
      lastCheckpointLSN: 1000,
      lastCheckpointAge: 12 * 60 * 60 * 1000,
      segmentsSinceCheckpoint: 3
    };
  });

  // ---------------------------------------------------------------------------
  // shouldCompact()
  // ---------------------------------------------------------------------------
  describe('shouldCompact()', () => {
    test('returns false when segmentCount is below maxSegmentsPerTier and tombstoneRatio is low', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 4 });
      const low: WALMetrics = { ...mockWALMetrics, segmentCount: 1, tombstoneRatio: 0 };
      expect(strategy.shouldCompact(low, mockCheckpointMetrics)).toBe(false);
    });

    test('returns false when segmentCount is just under maxSegmentsPerTier', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 4 });
      const metrics: WALMetrics = { ...mockWALMetrics, segmentCount: 3, tombstoneRatio: 0 };
      expect(strategy.shouldCompact(metrics, mockCheckpointMetrics)).toBe(false);
    });

    test('returns true when segmentCount equals maxSegmentsPerTier (default 4)', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 4 });
      const metrics: WALMetrics = { ...mockWALMetrics, segmentCount: 4, tombstoneRatio: 0 };
      expect(strategy.shouldCompact(metrics, mockCheckpointMetrics)).toBe(true);
    });

    test('returns true when segmentCount exceeds maxSegmentsPerTier (default 4)', () => {
      const strategy = new SizeTieredCompactionStrategy();
      // mockWALMetrics has segmentCount=5 >= 4
      expect(strategy.shouldCompact(mockWALMetrics, mockCheckpointMetrics)).toBe(true);
    });

    test('returns true when tombstoneRatio exceeds 0.5', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 100 });
      const highChurn: WALMetrics = { ...mockWALMetrics, segmentCount: 1, tombstoneRatio: 0.6 };
      expect(strategy.shouldCompact(highChurn, mockCheckpointMetrics)).toBe(true);
    });

    test('returns false when tombstoneRatio is exactly 0.5 (boundary — not above)', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 100 });
      const boundary: WALMetrics = { ...mockWALMetrics, segmentCount: 1, tombstoneRatio: 0.5 };
      expect(strategy.shouldCompact(boundary, mockCheckpointMetrics)).toBe(false);
    });

    test('returns false when isRunning=true even if segmentCount would trigger', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 2 });
      (strategy as any).metrics.isRunning = true;
      // segmentCount=5 >= 2 would normally trigger
      expect(strategy.shouldCompact(mockWALMetrics, mockCheckpointMetrics)).toBe(false);
    });

    test('custom maxSegmentsPerTier is respected', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 8 });
      const sevenSeg: WALMetrics = { ...mockWALMetrics, segmentCount: 7, tombstoneRatio: 0 };
      expect(strategy.shouldCompact(sevenSeg, mockCheckpointMetrics)).toBe(false);

      const eightSeg: WALMetrics = { ...mockWALMetrics, segmentCount: 8, tombstoneRatio: 0 };
      expect(strategy.shouldCompact(eightSeg, mockCheckpointMetrics)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // planCompaction()
  // ---------------------------------------------------------------------------
  describe('planCompaction()', () => {
    test('returns null for an empty segment array', () => {
      const strategy = new SizeTieredCompactionStrategy();
      expect(strategy.planCompaction([], mockCheckpointMetrics)).toBeNull();
    });

    test('returns null when all segments are mutable', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 2 });
      const mutable = [
        makeSegment('s1', 512 * 1024, { isImmutable: false, startLSN: 1, endLSN: 50 }),
        makeSegment('s2', 512 * 1024, { isImmutable: false, startLSN: 51, endLSN: 100 })
      ];
      expect(strategy.planCompaction(mutable, mockCheckpointMetrics)).toBeNull();
    });

    test('returns null when no single tier accumulates >= maxSegmentsPerTier segments', () => {
      // Default maxSegmentsPerTier=4; provide only 3 tier-0 segments
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 4 });
      const segments = [
        makeSegment('s1', 100 * 1024, { startLSN: 1,  endLSN: 10 }),
        makeSegment('s2', 200 * 1024, { startLSN: 11, endLSN: 20 }),
        makeSegment('s3', 300 * 1024, { startLSN: 21, endLSN: 30 })
      ];
      expect(strategy.planCompaction(segments, mockCheckpointMetrics)).toBeNull();
    });

    test('returns a valid plan when one tier has >= maxSegmentsPerTier immutable segments', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 4 });
      // All in tier 0 (< 1 MB each)
      const segments = [
        makeSegment('s1', 100 * 1024, { startLSN: 1,  endLSN: 10 }),
        makeSegment('s2', 200 * 1024, { startLSN: 11, endLSN: 20 }),
        makeSegment('s3', 300 * 1024, { startLSN: 21, endLSN: 30 }),
        makeSegment('s4', 400 * 1024, { startLSN: 31, endLSN: 40 })
      ];
      const plan = strategy.planCompaction(segments, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      expect(plan!.planId).toBeDefined();
    });

    test('all inputSegments in the plan are immutable', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 4 });
      const segments = [
        makeSegment('s1', 100 * 1024, { startLSN: 1,  endLSN: 10 }),
        makeSegment('s2', 200 * 1024, { startLSN: 11, endLSN: 20 }),
        makeSegment('s3', 300 * 1024, { startLSN: 21, endLSN: 30 }),
        makeSegment('s4', 400 * 1024, { startLSN: 31, endLSN: 40 }),
        makeSegment('s5', 100 * 1024, { isImmutable: false, startLSN: 41, endLSN: 50 })
      ];
      const plan = strategy.planCompaction(segments, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();
      for (const seg of plan.inputSegments) {
        expect(seg.isImmutable).toBe(true);
      }
    });

    test('outputSegments[0].lsnRange covers min start and max end of inputSegments', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 4 });
      const segments = [
        makeSegment('s1', 100 * 1024, { startLSN: 1,   endLSN: 100 }),
        makeSegment('s2', 200 * 1024, { startLSN: 50,  endLSN: 200 }),
        makeSegment('s3', 300 * 1024, { startLSN: 150, endLSN: 300 }),
        makeSegment('s4', 400 * 1024, { startLSN: 250, endLSN: 400 })
      ];
      const plan = strategy.planCompaction(segments, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();
      const out = plan.outputSegments[0];
      expect(out.lsnRange.start).toBe(1);
      expect(out.lsnRange.end).toBe(400);
    });

    test('outputSegments[0].lsnRange.start < lsnRange.end', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 4 });
      const segments = [
        makeSegment('s1', 100 * 1024, { startLSN: 1,  endLSN: 100 }),
        makeSegment('s2', 200 * 1024, { startLSN: 50, endLSN: 200 }),
        makeSegment('s3', 300 * 1024, { startLSN: 101, endLSN: 300 }),
        makeSegment('s4', 400 * 1024, { startLSN: 201, endLSN: 400 })
      ];
      const plan = strategy.planCompaction(segments, mockCheckpointMetrics)!;
      const out = plan.outputSegments[0];
      expect(out.lsnRange.start).toBeLessThan(out.lsnRange.end);
    });

    test('outputSegments[0].segmentId contains "size-tiered"', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 4 });
      const segments = [
        makeSegment('s1', 100 * 1024, { startLSN: 1,  endLSN: 10 }),
        makeSegment('s2', 200 * 1024, { startLSN: 11, endLSN: 20 }),
        makeSegment('s3', 300 * 1024, { startLSN: 21, endLSN: 30 }),
        makeSegment('s4', 400 * 1024, { startLSN: 31, endLSN: 40 })
      ];
      const plan = strategy.planCompaction(segments, mockCheckpointMetrics)!;
      expect(plan.outputSegments[0].segmentId).toContain('size-tiered');
    });

    test('estimatedSpaceSaved is >= 0', () => {
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 4 });
      const segments = [
        makeSegment('s1', 100 * 1024, { startLSN: 1,  endLSN: 10 }),
        makeSegment('s2', 200 * 1024, { startLSN: 11, endLSN: 20 }),
        makeSegment('s3', 300 * 1024, { startLSN: 21, endLSN: 30 }),
        makeSegment('s4', 400 * 1024, { startLSN: 31, endLSN: 40 })
      ];
      const plan = strategy.planCompaction(segments, mockCheckpointMetrics)!;
      expect(plan.estimatedSpaceSaved).toBeGreaterThanOrEqual(0);
    });

    test('picks the tier with the most segments when multiple tiers qualify', () => {
      // tier 0 (< 1MB): 5 segments — wins
      // tier 1 (< 10MB): 4 segments — also qualifies but fewer
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 4 });
      const segments = [
        // tier 0 — 5 segments
        makeSegment('t0-1', 100 * 1024, { startLSN: 1,  endLSN: 10 }),
        makeSegment('t0-2', 200 * 1024, { startLSN: 11, endLSN: 20 }),
        makeSegment('t0-3', 300 * 1024, { startLSN: 21, endLSN: 30 }),
        makeSegment('t0-4', 400 * 1024, { startLSN: 31, endLSN: 40 }),
        makeSegment('t0-5', 500 * 1024, { startLSN: 41, endLSN: 50 }),
        // tier 1 — 4 segments
        makeSegment('t1-1', 2 * MB, { startLSN: 51, endLSN: 60 }),
        makeSegment('t1-2', 3 * MB, { startLSN: 61, endLSN: 70 }),
        makeSegment('t1-3', 4 * MB, { startLSN: 71, endLSN: 80 }),
        makeSegment('t1-4', 5 * MB, { startLSN: 81, endLSN: 90 })
      ];
      const plan = strategy.planCompaction(segments, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();
      // The chosen tier should be tier 0 (5 > 4)
      expect(plan.inputSegments.length).toBe(5);
      expect(plan.inputSegments.every(s => s.sizeBytes <= MB)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // executeCompaction()
  // ---------------------------------------------------------------------------
  describe('executeCompaction()', () => {
    const twoSegments: WALSegment[] = [
      {
        segmentId: 'seg-exec-1',
        filePath: '/data/wal/seg-exec-1.wal',
        startLSN: 1,
        endLSN: 500,
        createdAt: Date.now() - 3600_000,
        sizeBytes: 100 * MB,
        entryCount: 5000,
        tombstoneCount: 1000,
        isImmutable: true
      },
      {
        segmentId: 'seg-exec-2',
        filePath: '/data/wal/seg-exec-2.wal',
        startLSN: 400,
        endLSN: 900,
        createdAt: Date.now() - 1800_000,
        sizeBytes: 80 * MB,
        entryCount: 4000,
        tombstoneCount: 500,
        isImmutable: true
      }
    ];

    test('returns success=true for a valid plan', async () => {
      const strategy = new SizeTieredCompactionStrategy();
      const plan = makePlan(twoSegments);
      const result = await strategy.executeCompaction(plan);
      expect(result.success).toBe(true);
      expect(result.planId).toBe('test-size-tiered-plan');
    });

    test('tombstonesRemoved equals total tombstoneCount across all inputSegments', async () => {
      const strategy = new SizeTieredCompactionStrategy();
      const plan = makePlan(twoSegments);
      const result = await strategy.executeCompaction(plan);
      // 1000 + 500 = 1500 tombstones
      expect(result.metrics.tombstonesRemoved).toBe(1500);
    });

    test('segmentsDeleted equals plan.inputSegments map of segmentIds', async () => {
      const strategy = new SizeTieredCompactionStrategy();
      const plan = makePlan(twoSegments);
      const result = await strategy.executeCompaction(plan);
      expect(result.segmentsDeleted).toEqual(['seg-exec-1', 'seg-exec-2']);
    });

    test('succeeds with 0 tombstones (no tombstonesRemoved)', async () => {
      const strategy = new SizeTieredCompactionStrategy();
      const cleanSegments: WALSegment[] = [
        { ...twoSegments[0], segmentId: 'clean-1', tombstoneCount: 0 },
        { ...twoSegments[1], segmentId: 'clean-2', tombstoneCount: 0 }
      ];
      const plan = makePlan(cleanSegments);
      const result = await strategy.executeCompaction(plan);
      expect(result.success).toBe(true);
      expect(result.metrics.tombstonesRemoved).toBe(0);
    });

    test('segmentsCreated length equals plan.outputSegments.length', async () => {
      const strategy = new SizeTieredCompactionStrategy();
      const plan = makePlan(twoSegments);
      const result = await strategy.executeCompaction(plan);
      expect(result.segmentsCreated.length).toBe(plan.outputSegments.length);
    });

    test('isRunning is false after execution completes', async () => {
      const strategy = new SizeTieredCompactionStrategy();
      const plan = makePlan(twoSegments);
      await strategy.executeCompaction(plan);
      expect(strategy.getMetrics().isRunning).toBe(false);
    });

    test('totalRuns increments after each call', async () => {
      const strategy = new SizeTieredCompactionStrategy();
      const plan = makePlan(twoSegments);
      expect(strategy.getMetrics().totalRuns).toBe(0);
      await strategy.executeCompaction(plan);
      expect(strategy.getMetrics().totalRuns).toBe(1);
      await strategy.executeCompaction(plan);
      expect(strategy.getMetrics().totalRuns).toBe(2);
    });

    test('actualSpaceSaved is >= 0', async () => {
      const strategy = new SizeTieredCompactionStrategy();
      const plan = makePlan(twoSegments);
      const result = await strategy.executeCompaction(plan);
      expect(result.actualSpaceSaved).toBeGreaterThanOrEqual(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getMetrics()
  // ---------------------------------------------------------------------------
  describe('getMetrics()', () => {
    test('initial state has totalRuns=0, isRunning=false', () => {
      const strategy = new SizeTieredCompactionStrategy();
      const metrics = strategy.getMetrics();
      expect(metrics.totalRuns).toBe(0);
      expect(metrics.isRunning).toBe(false);
    });

    test('initial strategy name is SizeTieredCompactionStrategy', () => {
      const strategy = new SizeTieredCompactionStrategy();
      expect(strategy.getMetrics().strategy).toBe('SizeTieredCompactionStrategy');
    });

    test('totalRuns is 1 after one executeCompaction call', async () => {
      const strategy = new SizeTieredCompactionStrategy();
      const segs: WALSegment[] = [
        makeSegment('m1', MB, { startLSN: 1, endLSN: 100 }),
        makeSegment('m2', MB, { startLSN: 101, endLSN: 200 })
      ];
      await strategy.executeCompaction(makePlan(segs));
      expect(strategy.getMetrics().totalRuns).toBe(1);
    });

    test('getMetrics returns a snapshot (not a live reference)', () => {
      const strategy = new SizeTieredCompactionStrategy();
      const snap1 = strategy.getMetrics();
      (strategy as any).metrics.totalRuns = 99;
      const snap2 = strategy.getMetrics();
      // snap1 should be unaffected
      expect(snap1.totalRuns).toBe(0);
      expect(snap2.totalRuns).toBe(99);
    });
  });

  // ---------------------------------------------------------------------------
  // constructor config
  // ---------------------------------------------------------------------------
  describe('constructor config', () => {
    test('accepts custom sizeTiers, maxSegmentsPerTier, and minSegmentSize', () => {
      const strategy = new SizeTieredCompactionStrategy({
        sizeTiers: [2 * MB, 20 * MB, 200 * MB],
        maxSegmentsPerTier: 8,
        minSegmentSize: 2 * MB
      });
      expect(strategy).toBeInstanceOf(SizeTieredCompactionStrategy);
    });

    test('uses default values when no config is passed', () => {
      const strategy = new SizeTieredCompactionStrategy();
      // Default maxSegmentsPerTier=4; 4 segments in same tier should trigger a plan
      const segments = [
        makeSegment('d1', 100 * 1024, { startLSN: 1,  endLSN: 10 }),
        makeSegment('d2', 200 * 1024, { startLSN: 11, endLSN: 20 }),
        makeSegment('d3', 300 * 1024, { startLSN: 21, endLSN: 30 }),
        makeSegment('d4', 400 * 1024, { startLSN: 31, endLSN: 40 })
      ];
      const plan = strategy.planCompaction(segments, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
    });

    test('custom maxSegmentsPerTier changes the compaction threshold', () => {
      // With maxSegmentsPerTier=2 only 2 segments needed to form a qualifying tier
      const strategy = new SizeTieredCompactionStrategy({ maxSegmentsPerTier: 2 });
      const segments = [
        makeSegment('e1', 100 * 1024, { startLSN: 1,  endLSN: 10 }),
        makeSegment('e2', 200 * 1024, { startLSN: 11, endLSN: 20 })
      ];
      const plan = strategy.planCompaction(segments, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
    });
  });
});
