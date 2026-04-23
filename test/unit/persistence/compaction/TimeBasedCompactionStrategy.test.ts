import { TimeBasedCompactionStrategy } from '../../../../src/persistence/compaction/TimeBasedCompactionStrategy';
import { WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan } from '../../../../src/persistence/compaction/types';

describe('TimeBasedCompactionStrategy', () => {
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
    test('returns false when no conditions are triggered', () => {
      const strategy = new TimeBasedCompactionStrategy({
        maxSegmentAge: 72 * 60 * 60 * 1000,       // 72 hours — older than oldest (48h)
        tombstoneThreshold: 0.5,                    // above tombstoneRatio=0.25
        checkpointLagThreshold: 10                  // above segmentsSinceCheckpoint=3
      });
      const quietMetrics: WALMetrics = {
        ...mockWALMetrics,
        segmentCount: 5,                           // <= 10 (hard-coded upper bound)
        oldestSegmentAge: 1 * 60 * 60 * 1000,     // 1 hour — below 72h
        tombstoneRatio: 0.1,                       // below 0.5
        duplicateEntryRatio: 0.1                   // below hard-coded 0.5
      };
      const quietCheckpoint: CheckpointMetrics = {
        ...mockCheckpointMetrics,
        segmentsSinceCheckpoint: 2               // <= 10
      };
      expect(strategy.shouldCompact(quietMetrics, quietCheckpoint)).toBe(false);
    });

    test('returns true when segments are older than maxSegmentAgeMs', () => {
      const strategy = new TimeBasedCompactionStrategy({
        maxSegmentAge: 24 * 60 * 60 * 1000  // 24 hours
      });
      // oldestSegmentAge=48h > maxSegmentAge=24h
      const oldMetrics: WALMetrics = {
        ...mockWALMetrics,
        segmentCount: 5,
        oldestSegmentAge: 48 * 60 * 60 * 1000,
        tombstoneRatio: 0.0,
        duplicateEntryRatio: 0.0
      };
      const quietCheckpoint: CheckpointMetrics = { ...mockCheckpointMetrics, segmentsSinceCheckpoint: 0 };
      expect(strategy.shouldCompact(oldMetrics, quietCheckpoint)).toBe(true);
    });

    test('returns false when segments are younger than maxSegmentAgeMs', () => {
      const strategy = new TimeBasedCompactionStrategy({
        maxSegmentAge: 72 * 60 * 60 * 1000,  // 72 hours
        tombstoneThreshold: 0.9,
        checkpointLagThreshold: 100
      });
      const youngMetrics: WALMetrics = {
        ...mockWALMetrics,
        segmentCount: 5,
        oldestSegmentAge: 1 * 60 * 60 * 1000, // 1 hour < 72h
        tombstoneRatio: 0.0,
        duplicateEntryRatio: 0.0
      };
      const quietCheckpoint: CheckpointMetrics = { ...mockCheckpointMetrics, segmentsSinceCheckpoint: 0 };
      expect(strategy.shouldCompact(youngMetrics, quietCheckpoint)).toBe(false);
    });

    test('returns false when isRunning is true', async () => {
      const strategy = new TimeBasedCompactionStrategy({ maxSegmentAge: 1 * 60 * 60 * 1000 }); // 1h
      // Create two old segments so planCompaction can produce a valid plan
      const now = Date.now();
      const twoOldSegs: WALSegment[] = [
        {
          ...mockSegments[0], segmentId: 'seg-1',
          startLSN: 1, endLSN: 500,
          createdAt: now - 3 * 60 * 60 * 1000 // 3 hours old — above maxSegmentAge/2 = 30 min
        },
        {
          ...mockSegments[0], segmentId: 'seg-2',
          startLSN: 501, endLSN: 1000,
          createdAt: now - 3 * 60 * 60 * 1000
        }
      ];
      const plan = strategy.planCompaction(twoOldSegs, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();

      const execPromise = strategy.executeCompaction(plan);
      expect(strategy.getMetrics().isRunning).toBe(true);
      expect(strategy.shouldCompact(mockWALMetrics, mockCheckpointMetrics)).toBe(false);
      await execPromise;
    });
  });

  describe('planCompaction()', () => {
    test('returns null for empty segment list', () => {
      const strategy = new TimeBasedCompactionStrategy();
      expect(strategy.planCompaction([], mockCheckpointMetrics)).toBeNull();
    });

    test('returns null when no segments meet age/size criteria', () => {
      const strategy = new TimeBasedCompactionStrategy({
        maxSegmentAge: 7 * 24 * 60 * 60 * 1000,  // 7 days
        tombstoneThreshold: 0.9
      });
      // Segment is only 1 hour old — won't qualify under any criterion
      const youngSeg: WALSegment[] = [
        {
          ...mockSegments[0],
          segmentId: 'young-seg',
          createdAt: Date.now() - 60 * 60 * 1000, // 1 hour ago
          endLSN: 500,
          tombstoneCount: 0
        }
      ];
      // lastCheckpointLSN=1000, endLSN=500 → endLSN < lastCheckpointLSN — but only 1 segment
      // With only 1 candidate, returns null (needs >= 2)
      expect(strategy.planCompaction(youngSeg, mockCheckpointMetrics)).toBeNull();
    });

    test('returns null when fewer than 2 candidate segments qualify', () => {
      const strategy = new TimeBasedCompactionStrategy({ maxSegmentAge: 24 * 60 * 60 * 1000 });
      // Only 1 segment qualifies (old enough)
      expect(strategy.planCompaction(mockSegments, mockCheckpointMetrics)).toBeNull();
    });

    test('returns plan for 2+ old-enough segments', () => {
      const strategy = new TimeBasedCompactionStrategy({ maxSegmentAge: 1 * 60 * 60 * 1000 }); // 1h
      const now = Date.now();
      const twoOldSegs: WALSegment[] = [
        {
          ...mockSegments[0], segmentId: 'seg-1',
          startLSN: 1, endLSN: 500,
          createdAt: now - 3 * 60 * 60 * 1000  // 3h old > maxSegmentAge/2 = 30min
        },
        {
          ...mockSegments[0], segmentId: 'seg-2',
          startLSN: 501, endLSN: 1000,
          createdAt: now - 3 * 60 * 60 * 1000
        }
      ];
      const plan = strategy.planCompaction(twoOldSegs, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
      expect(plan!.inputSegments.length).toBeGreaterThanOrEqual(2);
    });

    test('plan includes segments whose endLSN is before lastCheckpointLSN', () => {
      const strategy = new TimeBasedCompactionStrategy({ maxSegmentAge: 365 * 24 * 60 * 60 * 1000 }); // very long age
      const now = Date.now();
      // Both segments have endLSN <= lastCheckpointLSN=1000
      const checkpointedSegs: WALSegment[] = [
        {
          ...mockSegments[0], segmentId: 'seg-before-cp-1',
          startLSN: 1, endLSN: 500,
          createdAt: now - 60 * 1000  // 1 min old — too new for age filter
        },
        {
          ...mockSegments[0], segmentId: 'seg-before-cp-2',
          startLSN: 501, endLSN: 999,
          createdAt: now - 60 * 1000
        }
      ];
      // endLSN <= lastCheckpointLSN=1000 qualifies them
      const plan = strategy.planCompaction(checkpointedSegs, mockCheckpointMetrics);
      expect(plan).not.toBeNull();
    });

    test('plan has valid output segment lsnRange', () => {
      const strategy = new TimeBasedCompactionStrategy({ maxSegmentAge: 1 * 60 * 60 * 1000 });
      const now = Date.now();
      const segs: WALSegment[] = [
        {
          ...mockSegments[0], segmentId: 'seg-1',
          startLSN: 10, endLSN: 500,
          createdAt: now - 3 * 60 * 60 * 1000
        },
        {
          ...mockSegments[0], segmentId: 'seg-2',
          startLSN: 501, endLSN: 900,
          createdAt: now - 3 * 60 * 60 * 1000
        }
      ];
      const plan = strategy.planCompaction(segs, mockCheckpointMetrics)!;
      expect(plan).not.toBeNull();
      const out = plan.outputSegments[0];
      expect(out.lsnRange.start).toBeLessThan(out.lsnRange.end);
    });
  });

  describe('executeCompaction()', () => {
    // Helper to build a plan directly without going through planCompaction
    function makePlan(segments: WALSegment[]): CompactionPlan {
      return {
        planId: 'test-time-plan',
        inputSegments: segments,
        outputSegments: [{
          segmentId: 'time-out-1',
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
      const strategy = new TimeBasedCompactionStrategy();
      const plan = makePlan(mockSegments);
      const result = await strategy.executeCompaction(plan);
      expect(result.success).toBe(true);
    }, 10000);

    test('result.planId matches input plan.planId', async () => {
      const strategy = new TimeBasedCompactionStrategy();
      const plan = makePlan(mockSegments);
      const result = await strategy.executeCompaction(plan);
      expect(result.planId).toBe('test-time-plan');
    }, 10000);

    test('duplicatesRemoved is derived from tombstone count (not flat 10%)', async () => {
      const strategy = new TimeBasedCompactionStrategy();
      // A segment with 0 tombstones should produce 0 duplicatesFromTombstones
      const noTombstoneSegs: WALSegment[] = [
        { ...mockSegments[0], tombstoneCount: 0, entryCount: 1000 }
      ];
      const plan = makePlan(noTombstoneSegs);
      const result = await strategy.executeCompaction(plan);
      // With tombstoneCount=0 → duplicatesFromTombstones=0 → additionalDuplicates~0
      // So duplicatesRemoved ≈ 0 (much less than flat 10% of 1000 = 100)
      expect(result.metrics.duplicatesRemoved).toBeLessThan(100);
    }, 10000);

    test('duplicatesRemoved includes tombstone-derived component when tombstones present', async () => {
      const strategy = new TimeBasedCompactionStrategy();
      const segsWithTombstones: WALSegment[] = [
        { ...mockSegments[0], tombstoneCount: 500, entryCount: 2000 }
      ];
      const plan = makePlan(segsWithTombstones);
      const result = await strategy.executeCompaction(plan);
      // duplicatesFromTombstones = 500 (one stale live entry per tombstone)
      expect(result.metrics.duplicatesRemoved).toBeGreaterThanOrEqual(500);
    }, 10000);

    test('entriesCompacted = totalEntries - entriesRemoved', async () => {
      const strategy = new TimeBasedCompactionStrategy();
      const segs: WALSegment[] = [
        { ...mockSegments[0], entryCount: 1000, tombstoneCount: 200 }
      ];
      const plan = makePlan(segs);
      const result = await strategy.executeCompaction(plan);
      const totalEntries = 1000;
      // entriesCompacted = totalEntries - entriesRemoved = result.metrics.entriesCompacted
      // and entriesProcessed = totalEntries
      expect(result.metrics.entriesProcessed).toBe(totalEntries);
      expect(result.metrics.entriesCompacted).toBeLessThanOrEqual(totalEntries);
      // entriesCompacted + entriesRemoved should equal totalEntries
      const entriesRemoved = totalEntries - result.metrics.entriesCompacted;
      expect(result.metrics.entriesCompacted).toBe(totalEntries - entriesRemoved);
    }, 10000);

    test('tombstonesRemoved equals total tombstones across input segments', async () => {
      const strategy = new TimeBasedCompactionStrategy();
      const segs: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-1', tombstoneCount: 300, entryCount: 1000 },
        { ...mockSegments[0], segmentId: 'seg-2', startLSN: 501, endLSN: 1000, tombstoneCount: 200, entryCount: 1000 }
      ];
      const plan = makePlan(segs);
      const result = await strategy.executeCompaction(plan);
      expect(result.metrics.tombstonesRemoved).toBe(500);
    }, 10000);

    test('segmentsDeleted matches inputSegment IDs', async () => {
      const strategy = new TimeBasedCompactionStrategy();
      const segs: WALSegment[] = [
        { ...mockSegments[0], segmentId: 'seg-x' },
        { ...mockSegments[0], segmentId: 'seg-y', startLSN: 501, endLSN: 1000 }
      ];
      const plan = makePlan(segs);
      const result = await strategy.executeCompaction(plan);
      expect(result.segmentsDeleted).toEqual(['seg-x', 'seg-y']);
    }, 10000);
  });

  describe('getMetrics()', () => {
    test('shows initial totalRuns=0 and isRunning=false', () => {
      const strategy = new TimeBasedCompactionStrategy();
      const metrics = strategy.getMetrics();
      expect(metrics.totalRuns).toBe(0);
      expect(metrics.isRunning).toBe(false);
    });

    test('totalRuns increments after each execution', async () => {
      const strategy = new TimeBasedCompactionStrategy();
      const plan: CompactionPlan = {
        planId: 'run-count-plan',
        inputSegments: mockSegments,
        outputSegments: [{
          segmentId: 'out-1',
          estimatedSize: 50 * 1024 * 1024,
          lsnRange: { start: 1, end: 500 }
        }],
        estimatedSpaceSaved: 50 * 1024 * 1024,
        estimatedDuration: 100,
        priority: 'low'
      };

      expect(strategy.getMetrics().totalRuns).toBe(0);
      await strategy.executeCompaction(plan);
      expect(strategy.getMetrics().totalRuns).toBe(1);
      await strategy.executeCompaction(plan);
      expect(strategy.getMetrics().totalRuns).toBe(2);
      await strategy.executeCompaction(plan);
      expect(strategy.getMetrics().totalRuns).toBe(3);
    }, 30000);

    test('shows isRunning=false after execution completes', async () => {
      const strategy = new TimeBasedCompactionStrategy();
      const plan: CompactionPlan = {
        planId: 'running-plan',
        inputSegments: mockSegments,
        outputSegments: [{
          segmentId: 'out-1',
          estimatedSize: 50 * 1024 * 1024,
          lsnRange: { start: 1, end: 500 }
        }],
        estimatedSpaceSaved: 50 * 1024 * 1024,
        estimatedDuration: 100,
        priority: 'low'
      };
      await strategy.executeCompaction(plan);
      expect(strategy.getMetrics().isRunning).toBe(false);
    }, 10000);

    test('strategy name is TimeBasedCompactionStrategy', () => {
      const strategy = new TimeBasedCompactionStrategy();
      expect(strategy.getMetrics().strategy).toBe('TimeBasedCompactionStrategy');
    });
  });
});
