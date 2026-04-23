import { CompactionStrategy, WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan, CompactionResult } from './types';

/**
 * Leveled compaction strategy (LevelDB/RocksDB-style)
 *
 * This strategy organizes segments into levels with exponentially increasing
 * sizes. Provides predictable performance for mixed read/write workloads.
 */
export class LeveledCompactionStrategy extends CompactionStrategy {
  private readonly maxLevels: number;
  private readonly levelSizeMultiplier: number;
  private readonly level0SegmentLimit: number;
  private readonly baseLevelSize: number;

  constructor(config: {
    maxLevels?: number;           // Maximum number of levels, default 7
    levelSizeMultiplier?: number; // Size multiplier between levels, default 10
    level0SegmentLimit?: number;  // Max segments in level 0, default 4
    baseLevelSize?: number;       // Size of level 1, default 10MB
  } = {}) {
    super(config);
    
    this.maxLevels = config.maxLevels || 7;
    this.levelSizeMultiplier = config.levelSizeMultiplier || 10;
    this.level0SegmentLimit = config.level0SegmentLimit || 4;
    this.baseLevelSize = config.baseLevelSize || 10 * 1024 * 1024; // 10MB
  }

  shouldCompact(walMetrics: WALMetrics, checkpointMetrics: CheckpointMetrics): boolean {
    if (this.metrics.isRunning) {
      return false;
    }

    // Trigger when level-0 file count reaches the limit
    if (walMetrics.segmentCount >= this.level0SegmentLimit) {
      return true;
    }

    // Also trigger if total size is growing beyond level-1 target (spillover)
    const level1Target = this.calculateLevelTargetSize(1);
    if (walMetrics.totalSizeBytes > level1Target * this.levelSizeMultiplier) {
      return true;
    }

    return false;
  }

  planCompaction(segments: WALSegment[], checkpointMetrics: CheckpointMetrics): CompactionPlan | null {
    if (segments.length === 0) {
      return null;
    }

    // Only compact immutable segments
    const immutableSegments = segments.filter(s => s.isImmutable);
    if (immutableSegments.length < 2) {
      return null;
    }

    // Organise segments into levels
    const levelGroups = this.organizeSegmentsByLevel(immutableSegments);

    // Find the first level that has overlapping segments and plan compaction there
    for (let level = 0; level < this.maxLevels; level++) {
      const levelSegments = levelGroups.get(level);
      if (!levelSegments || levelSegments.length < 2) {
        continue;
      }

      // Level-0 triggers compaction as soon as it reaches the segment limit
      const isLevel0Overloaded = level === 0 && levelSegments.length >= this.level0SegmentLimit;
      const overlappingGroups = this.findOverlappingSegments(levelSegments);

      if (!isLevel0Overloaded && overlappingGroups.length === 0) {
        continue;
      }

      // Prefer the largest overlapping group, fall back to all level-0 segments
      const inputSegments = overlappingGroups.length > 0
        ? overlappingGroups.reduce((best, group) =>
            group.length > best.length ? group : best
          )
        : levelSegments;

      if (inputSegments.length < 2) {
        continue;
      }

      const totalSize = inputSegments.reduce((sum, s) => sum + s.sizeBytes, 0);
      const totalEntries = inputSegments.reduce((sum, s) => sum + s.entryCount, 0);
      const totalTombstones = inputSegments.reduce((sum, s) => sum + s.tombstoneCount, 0);
      const estimatedRetainedRatio = totalEntries > 0
        ? (totalEntries - totalTombstones) / totalEntries
        : 1;
      const estimatedOutputSize = Math.floor(totalSize * estimatedRetainedRatio);

      const plan: CompactionPlan = {
        planId: `leveled-L${level}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        inputSegments,
        outputSegments: [{
          segmentId: `leveled-compacted-L${level + 1}-${Date.now()}`,
          estimatedSize: estimatedOutputSize,
          lsnRange: {
            start: Math.min(...inputSegments.map(s => s.startLSN)),
            end: Math.max(...inputSegments.map(s => s.endLSN))
          }
        }],
        estimatedSpaceSaved: totalSize - estimatedOutputSize,
        estimatedDuration: Math.max(100, Math.floor(totalSize / (10 * 1024 * 1024))),
        priority: level === 0 && levelSegments.length >= this.level0SegmentLimit ? 'high' : 'medium'
      };

      return this.validatePlan(plan, segments) ? plan : null;
    }

    return null;
  }

  async executeCompaction(plan: CompactionPlan): Promise<CompactionResult> {
    this.metrics.isRunning = true;
    const startTime = Date.now();

    try {
      const totalEntries = plan.inputSegments.reduce((sum, s) => sum + s.entryCount, 0);
      const totalTombstones = plan.inputSegments.reduce((sum, s) => sum + s.tombstoneCount, 0);
      const totalSize = plan.inputSegments.reduce((sum, s) => sum + s.sizeBytes, 0);

      // Merge overlapping segments: drop all tombstones and keep the latest
      // entry per key (approximated by removing tombstones only here since WAL
      // entries don't carry an explicit key separate from entityId).
      const entriesAfterTombstoneRemoval = totalEntries - totalTombstones;

      // Deduplication: within each merged group, each (entityId) that appears
      // more than once contributes duplicates.  We approximate: for every
      // tombstone removed there was at least one preceding live entry for that
      // entity (i.e. one implicit duplicate).  This is a conservative lower bound
      // — the time-based strategy uses a flat 10%; here we tie it to actual
      // tombstone data so the figure varies per workload.
      const duplicatesRemoved = totalTombstones; // one superseded live entry per tombstone
      const retainedEntries = Math.max(0, entriesAfterTombstoneRemoval - duplicatesRemoved);
      const entriesRemoved = totalEntries - retainedEntries;
      const spaceSavedRatio = totalEntries > 0 ? entriesRemoved / totalEntries : 0;
      const actualSpaceSaved = Math.floor(totalSize * spaceSavedRatio);
      const estimatedOutputSize = totalSize - actualSpaceSaved;

      const result: CompactionResult = {
        planId: plan.planId,
        success: true,
        actualSpaceSaved,
        actualDuration: Date.now() - startTime,
        segmentsCreated: plan.outputSegments.map(seg => ({
          segmentId: seg.segmentId,
          filePath: `/compacted/${seg.segmentId}.wal`,
          startLSN: seg.lsnRange.start,
          endLSN: seg.lsnRange.end,
          createdAt: Date.now(),
          sizeBytes: Math.floor(estimatedOutputSize / plan.outputSegments.length),
          entryCount: retainedEntries,
          tombstoneCount: 0,
          isImmutable: true
        })),
        segmentsDeleted: plan.inputSegments.map(s => s.segmentId),
        metrics: {
          entriesProcessed: totalEntries,
          entriesCompacted: retainedEntries,
          tombstonesRemoved: totalTombstones,
          duplicatesRemoved
        }
      };

      this.updateMetrics(result);
      return result;
    } catch (error) {
      const result = this.errorResult(plan.planId, error, startTime);

      this.updateMetrics(result);
      return result;
    } finally {
      this.metrics.isRunning = false;
    }
  }

  private assignSegmentToLevel(segment: WALSegment): number {
    // Level 0: freshly flushed segments smaller than the base level size.
    // Segments grow into higher levels as they accumulate data.
    let level = 0;
    let levelSize = this.baseLevelSize;

    while (level < this.maxLevels - 1 && segment.sizeBytes > levelSize) {
      level++;
      levelSize *= this.levelSizeMultiplier;
    }

    return level;
  }

  private organizeSegmentsByLevel(segments: WALSegment[]): Map<number, WALSegment[]> {
    const levelGroups = new Map<number, WALSegment[]>();
    
    for (const segment of segments) {
      const level = this.assignSegmentToLevel(segment);
      if (!levelGroups.has(level)) {
        levelGroups.set(level, []);
      }
      levelGroups.get(level)!.push(segment);
    }
    
    return levelGroups;
  }

  private calculateLevelTargetSize(level: number): number {
    if (level === 0) {
      return this.baseLevelSize * this.level0SegmentLimit;
    }
    return this.baseLevelSize * Math.pow(this.levelSizeMultiplier, level);
  }

  private findOverlappingSegments(segments: WALSegment[]): WALSegment[][] {
    // Sort by startLSN so we can detect overlapping LSN ranges in one pass.
    const sorted = [...segments].sort((a, b) => a.startLSN - b.startLSN);
    const groups: WALSegment[][] = [];
    let currentGroup: WALSegment[] = [];
    // Track the maximum endLSN seen so far in the current group so that a
    // segment that only overlaps with an earlier (not the last) member is
    // still captured.
    let groupMaxEndLSN = -1;

    for (const segment of sorted) {
      if (currentGroup.length === 0) {
        currentGroup.push(segment);
        groupMaxEndLSN = segment.endLSN;
      } else if (segment.startLSN <= groupMaxEndLSN) {
        // LSN ranges overlap — merge into current group
        currentGroup.push(segment);
        groupMaxEndLSN = Math.max(groupMaxEndLSN, segment.endLSN);
      } else {
        // No overlap — close the current group and start a new one
        if (currentGroup.length > 1) {
          groups.push(currentGroup);
        }
        currentGroup = [segment];
        groupMaxEndLSN = segment.endLSN;
      }
    }

    if (currentGroup.length > 1) {
      groups.push(currentGroup);
    }

    return groups;
  }
}
