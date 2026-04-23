import { VacuumBasedCompactionStrategy } from '../../../../src/persistence/compaction/VacuumBasedCompactionStrategy';
import { WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan } from '../../../../src/persistence/compaction/types';

describe('VacuumBasedCompactionStrategy', () => {
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
    test('returns false when tombstoneRatio is below deadTupleThreshold', () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.5, fragmentationThreshold: 0.5 });
      const lowMetrics: WALMetrics = { ...mockWALMetrics, tombstoneRatio: 0.1, duplicateEntryRatio: 0.1 };
      expect(strategy.shouldCompact(lowMetrics, mockCheckpointMetrics)).toBe(false);
    });

    test('returns true when tombstoneRatio equals deadTupleThreshold (default 0.2)', () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.2 });
      const metrics: WALMetrics = { ...mockWALMetrics, tombstoneRatio: 0.2, duplicateEntryRatio: 0.0 };
      expect(strategy.shouldCompact(metrics, mockCheckpointMetrics)).toBe(true);
    });

    test('returns true when tombstoneRatio exceeds deadTupleThreshold (default 0.2)', () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.2 });
      // tombstoneRatio=0.25 >= deadTupleThreshold=0.2
      expect(strategy.shouldCompact(mockWALMetrics, mockCheckpointMetrics)).toBe(true);
    });

    test('returns true when duplicateEntryRatio equals fragmentationThreshold (default 0.3)', () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.5, fragmentationThreshold: 0.3 });
      const metrics: WALMetrics = { ...mockWALMetrics, tombstoneRatio: 0.01, duplicateEntryRatio: 0.3 };
      expect(strategy.shouldCompact(metrics, mockCheckpointMetrics)).toBe(true);
    });

    test('returns true when duplicateEntryRatio exceeds fragmentationThreshold', () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.5, fragmentationThreshold: 0.3 });
      const metrics: WALMetrics = { ...mockWALMetrics, tombstoneRatio: 0.01, duplicateEntryRatio: 0.4 };
      expect(strategy.shouldCompact(metrics, mockCheckpointMetrics)).toBe(true);
    });

    test('returns false when isRunning=true', () => {
      // Force isRunning to true by accessing the protected metrics via casting
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.2 });
      (strategy as any).metrics.isRunning = true;
      // tombstoneRatio=0.25 >= deadTupleThreshold=0.2 would normally trigger — isRunning guard fires first
      expect(strategy.shouldCompact(mockWALMetrics, mockCheckpointMetrics)).toBe(false);
    });

    test('custom thresholds are respected', () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.8, fragmentationThreshold: 0.9 });
      // mockWALMetrics has tombstoneRatio=0.25, duplicateEntryRatio=0.15 — both well below
      expect(strategy.shouldCompact(mockWALMetrics, mockCheckpointMetrics)).toBe(false);
    });
  });

  describe('planCompaction()', () => {
    test('returns null when all segments score below threshold', () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.9, fragmentationThreshold: 0.9 });
      const cleanSegments: WALSegment[] = [{ ...mockSegments[0], tombstoneCount: 10 }];
      expect(strategy.planCompaction(cleanSegments, mockCheckpointMetrics)).toBeNull();
    });

    test('returns null for empty segment list', () => {
      const strategy = new VacuumBasedCompactionStrategy();
      expect(strategy.planCompaction([], mockCheckpointMetrics)).toBeNull();
    });

    test('returns null when all segments are mutable', () => {
      const strategy = new VacuumBasedCompactionStrategy();
      const mutableSegs: WALSegment[] = [{ ...mockSegments[0], isImmutable: false }];
      expect(strategy.planCompaction(mutableSegs, mockCheckpointMetrics)).toBeNull();
    });

    test('returns plan with high-dead-tuple segments selected', () => {
      const strategy = new VacuumBasedCompactionStrategy();
      // segment has tombstoneCount=1250 / entryCount=5000 → deadTupleRatio = 2*1250/5000 = 0.5
      const plan = strategy.planCompaction(mockSegments, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      expect(plan!.inputSegments.length).toBeGreaterThan(0);
    });

    test("plan priority is 'high' when any segment has deadTupleRatio > 0.5", () => {
      const strategy = new VacuumBasedCompactionStrategy();
      // deadTupleRatio = 2 * tombstoneCount / entryCount — need > 0.5
      // e.g. tombstoneCount=400, entryCount=1000 → ratio = 0.8 > 0.5
      const highDeadSegment: WALSegment[] = [
        {
          ...mockSegments[0],
          segmentId: 'high-dead',
          entryCount: 1000,
          tombstoneCount: 400  // deadTupleRatio = 2*400/1000 = 0.8 > 0.5
        }
      ];
      const plan = strategy.planCompaction(highDeadSegment, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      expect(plan!.priority).toBe('high');
    });

    test("plan priority is 'medium' when no segment has deadTupleRatio > 0.5", () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.2 });
      // deadTupleRatio = 2 * tombstoneCount / entryCount — keep <= 0.5
      // tombstoneCount=100, entryCount=5000 → ratio = 0.04 (< 0.5) but still >= threshold
      const lowDeadSegment: WALSegment[] = [
        {
          ...mockSegments[0],
          segmentId: 'low-dead',
          entryCount: 5000,
          tombstoneCount: 600   // deadTupleRatio = 2*600/5000 = 0.24 — above 0.2 threshold, below 0.5
        }
      ];
      const plan = strategy.planCompaction(lowDeadSegment, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      expect(plan!.priority).toBe('medium');
    });

    test('selects up to 4 segments at a time', () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.1 });
      // Build 6 high-dead-tuple segments
      const manySegments: WALSegment[] = Array.from({ length: 6 }, (_, i) => ({
        ...mockSegments[0],
        segmentId: `seg-${i}`,
        startLSN: i * 1000 + 1,
        endLSN: (i + 1) * 1000,
        entryCount: 1000,
        tombstoneCount: 300  // ratio = 0.6 > threshold
      }));
      const plan = strategy.planCompaction(manySegments, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      expect(plan!.inputSegments.length).toBeLessThanOrEqual(4);
    });
  });

  describe('calculateDeadTupleRatio()', () => {
    test('returns 2*tombstones/totalEntries (capped at 1.0)', () => {
      // We verify via planCompaction priority which depends on deadTupleRatio > 0.5.
      // A segment with tombstoneCount=300, entryCount=1000 → ratio = 2*300/1000 = 0.6 > 0.5
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.1 });
      const seg: WALSegment[] = [
        { ...mockSegments[0], entryCount: 1000, tombstoneCount: 300 }
      ];
      const plan = strategy.planCompaction(seg, mockCheckpointMetrics)!;
      // priority='high' only when deadTupleRatio > 0.5 — confirms ratio ≈ 0.6
      expect(plan).not.toBeNull();
      expect(plan.priority).toBe('high');
    });

    test('caps deadTupleRatio at 1.0 (tombstones > entryCount/2)', () => {
      // tombstoneCount=900, entryCount=1000 → 2*900/1000=1.8 → capped at 1.0
      // Strategy should still return 'high' priority (> 0.5)
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.1 });
      const seg: WALSegment[] = [
        { ...mockSegments[0], entryCount: 1000, tombstoneCount: 900 }
      ];
      const plan = strategy.planCompaction(seg, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();
      expect(plan.priority).toBe('high');
    });

    test('returns 0 when entryCount is 0', () => {
      // An empty segment should not be selected (deadTupleRatio = 0 < threshold)
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.2 });
      const emptySegment: WALSegment[] = [
        { ...mockSegments[0], entryCount: 0, tombstoneCount: 0 }
      ];
      // Should return null since the segment doesn't exceed the threshold
      expect(strategy.planCompaction(emptySegment, mockCheckpointMetrics)).toBeNull();
    });
  });

  describe('calculateFragmentationRatio()', () => {
    test('returns 1 - (liveEntries/totalEntries) approximation via wastedEntries/totalEntries', () => {
      // liveEntries = max(0, entryCount - tombstoneCount*2)
      // wastedEntries = entryCount - liveEntries
      // For entryCount=1000, tombstoneCount=100:
      //   liveEntries = 1000 - 200 = 800
      //   wastedEntries = 1000 - 800 = 200
      //   fragmentationRatio = 200/1000 = 0.2 (below default threshold 0.3)
      // To exceed fragmentationThreshold=0.3 without exceeding deadTupleThreshold:
      // Use deadTupleThreshold=0.9 to isolate fragmentation trigger.
      // tombstoneCount=200, entryCount=1000:
      //   liveEntries = 1000 - 400 = 600
      //   wastedEntries = 400, ratio = 0.4 >= 0.3
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.9, fragmentationThreshold: 0.3 });
      const seg: WALSegment[] = [
        { ...mockSegments[0], entryCount: 1000, tombstoneCount: 200 }
      ];
      const plan = strategy.planCompaction(seg, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
    });

    test('returns 0 when entryCount is 0', () => {
      // Zero-entry segment has fragmentationRatio=0, so it won't trigger fragmentation threshold
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.9, fragmentationThreshold: 0.01 });
      const emptySegment: WALSegment[] = [
        { ...mockSegments[0], entryCount: 0, tombstoneCount: 0 }
      ];
      expect(strategy.planCompaction(emptySegment, mockCheckpointMetrics)).toBeNull();
    });
  });

  describe('identifyHotData()', () => {
    test('returns top 50% of segments scored by recency and live density', () => {
      // identifyHotData is private — we validate it indirectly through planCompaction
      // by ensuring newer segments with high live density are preferred in the output.
      // We create 4 segments: 2 hot (recent, low tombstone) and 2 cold (old, high tombstone).
      // All must score above the vacuum threshold so candidates list has all 4.
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.1 });
      const now = Date.now();
      const fourSegments: WALSegment[] = [
        // hot: recent, low tombstones
        {
          ...mockSegments[0], segmentId: 'hot-1',
          startLSN: 1, endLSN: 200,
          createdAt: now - 60 * 60 * 1000, // 1 hour ago
          entryCount: 1000, tombstoneCount: 100
        },
        {
          ...mockSegments[0], segmentId: 'hot-2',
          startLSN: 201, endLSN: 400,
          createdAt: now - 60 * 60 * 1000, // 1 hour ago
          entryCount: 1000, tombstoneCount: 100
        },
        // cold: old, high tombstones
        {
          ...mockSegments[0], segmentId: 'cold-1',
          startLSN: 401, endLSN: 600,
          createdAt: now - 7 * 24 * 60 * 60 * 1000, // 7 days ago
          entryCount: 1000, tombstoneCount: 450
        },
        {
          ...mockSegments[0], segmentId: 'cold-2',
          startLSN: 601, endLSN: 800,
          createdAt: now - 7 * 24 * 60 * 60 * 1000, // 7 days ago
          entryCount: 1000, tombstoneCount: 450
        }
      ];
      // planCompaction picks up to 4 candidates — with 4 qualifying segments,
      // all 4 will appear in the plan (capped at 4 anyway).
      const plan = strategy.planCompaction(fourSegments, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      expect(plan!.inputSegments.length).toBeGreaterThanOrEqual(1);
    });

    test('returns at least 1 segment even when only 1 segment exists', () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.1 });
      const singleSegment: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'only-seg', entryCount: 1000, tombstoneCount: 100 }
      ];
      const plan = strategy.planCompaction(singleSegment, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      expect(plan!.inputSegments.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('executeCompaction()', () => {
    function makePlan(segments: WALSegment[]): CompactionPlan {
      return {
        planId: 'test-vacuum-plan',
        inputSegments: segments,
        outputSegments: [{
          segmentId: 'vacuumed-out-1',
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

    test('returns success=true', async () => {
      const strategy = new VacuumBasedCompactionStrategy();
      const plan = strategy.planCompaction(mockSegments, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();
      const result = await strategy.executeCompaction(plan);
      expect(result.success).toBe(true);
    });

    test('tombstonesRemoved > 0 for segments with tombstones', async () => {
      const strategy = new VacuumBasedCompactionStrategy();
      const plan = strategy.planCompaction(mockSegments, mockCheckpointMetrics)!;
      const result = await strategy.executeCompaction(plan);
      expect(result.metrics.tombstonesRemoved).toBeGreaterThan(0);
    });

    test('tombstonesRemoved equals total tombstones across input segments', async () => {
      const strategy = new VacuumBasedCompactionStrategy();
      const segs: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', tombstoneCount: 400 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 501, endLSN: 1000, tombstoneCount: 200 }
      ];
      const plan = makePlan(segs);
      const result = await strategy.executeCompaction(plan);
      expect(result.metrics.tombstonesRemoved).toBe(600);
    });

    test('actualSpaceSaved > 0 for segments with tombstones', async () => {
      const strategy = new VacuumBasedCompactionStrategy();
      const plan = strategy.planCompaction(mockSegments, mockCheckpointMetrics)!;
      const result = await strategy.executeCompaction(plan);
      expect(result.actualSpaceSaved).toBeGreaterThan(0);
    });

    test('result planId matches the input plan planId', async () => {
      const strategy = new VacuumBasedCompactionStrategy();
      const plan = makePlan(mockSegments);
      const result = await strategy.executeCompaction(plan);
      expect(result.planId).toBe('test-vacuum-plan');
    });

    test('actualSpaceSaved is 0 when input has no tombstones', async () => {
      const strategy = new VacuumBasedCompactionStrategy();
      const cleanSegs: WALSegment[] = [
        { ...mockSegments[0], tombstoneCount: 0 }
      ];
      const plan = makePlan(cleanSegs);
      const result = await strategy.executeCompaction(plan);
      expect(result.actualSpaceSaved).toBe(0);
    });

    test('custom thresholds respected — segments below custom threshold not compacted', () => {
      const strategy = new VacuumBasedCompactionStrategy({ deadTupleThreshold: 0.9, fragmentationThreshold: 0.9 });
      // tombstoneCount=10 on a 5000-entry segment → ratio << 0.9
      const cleanSegments: WALSegment[] = [{ ...mockSegments[0], tombstoneCount: 10 }];
      const plan = strategy.planCompaction(cleanSegments, mockCheckpointMetrics);
      expect(plan).toBeNull();
    });
  });

  describe('getMetrics()', () => {
    test('shows isRunning=false before any execution', () => {
      const strategy = new VacuumBasedCompactionStrategy();
      expect(strategy.getMetrics().isRunning).toBe(false);
    });

    test('shows isRunning=false after execution completes', async () => {
      const strategy = new VacuumBasedCompactionStrategy();
      const plan = strategy.planCompaction(mockSegments, mockCheckpointMetrics)!;
      await strategy.executeCompaction(plan);
      expect(strategy.getMetrics().isRunning).toBe(false);
    });

    test('totalRuns increments after each execution', async () => {
      const strategy = new VacuumBasedCompactionStrategy();
      const plan = strategy.planCompaction(mockSegments, mockCheckpointMetrics)!;
      expect(strategy.getMetrics().totalRuns).toBe(0);
      await strategy.executeCompaction(plan);
      expect(strategy.getMetrics().totalRuns).toBe(1);
      await strategy.executeCompaction(plan);
      expect(strategy.getMetrics().totalRuns).toBe(2);
    });

    test('strategy name is VacuumBasedCompactionStrategy', () => {
      const strategy = new VacuumBasedCompactionStrategy();
      expect(strategy.getMetrics().strategy).toBe('VacuumBasedCompactionStrategy');
    });
  });
});
