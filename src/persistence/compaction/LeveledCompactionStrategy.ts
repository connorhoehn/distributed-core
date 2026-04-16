import { CompactionStrategy, CompactionResult, WALSegment, CompactionPlan, WALMetrics, CheckpointMetrics } from './types';

/**
 * Leveled compaction strategy (LevelDB/RocksDB-style)
 *
 * This strategy organizes segments into levels with exponentially increasing
 * sizes. Level 0 contains the most recent, smallest segments. Each higher
 * level is levelSizeMultiplier times larger than the previous one.
 * When a level has too many segments or exceeds its target size, segments
 * are merged down into the next level along with any overlapping segments.
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

    // Level 0 has too many segments (using segmentCount as a proxy for L0)
    if (walMetrics.segmentCount > this.level0SegmentLimit) {
      return true;
    }

    // Total size exceeds the target for the first level
    // This indicates segments have accumulated beyond what L0 should hold
    if (walMetrics.totalSizeBytes > this.baseLevelSize) {
      return true;
    }

    // High tombstone ratio means key ranges are stale and need merging
    if (walMetrics.tombstoneRatio > 0.3) {
      return true;
    }

    return false;
  }

  planCompaction(segments: WALSegment[], checkpointMetrics: CheckpointMetrics): CompactionPlan | null {
    if (segments.length === 0) {
      return null;
    }

    // Assign segments to levels
    const levels = this.assignSegmentsToLevels(segments);

    // Find the level that needs compaction (check L0 first, then higher levels)
    let compactionLevel = -1;
    let compactionSegments: WALSegment[] = [];
    let targetLevelSegments: WALSegment[] = [];

    // Check level 0: too many segments triggers compaction into level 1
    const level0 = levels.get(0) || [];
    if (level0.length > this.level0SegmentLimit) {
      compactionLevel = 0;
      compactionSegments = level0;
      targetLevelSegments = levels.get(1) || [];
    } else {
      // Check higher levels: if a level exceeds its target size, compact into next level
      for (let level = 1; level < this.maxLevels - 1; level++) {
        const levelSegments = levels.get(level) || [];
        const levelTargetSize = this.getLevelTargetSize(level);
        const levelCurrentSize = levelSegments.reduce((sum, s) => sum + s.sizeBytes, 0);

        if (levelCurrentSize > levelTargetSize) {
          compactionLevel = level;
          compactionSegments = levelSegments;
          targetLevelSegments = levels.get(level + 1) || [];
          break;
        }
      }
    }

    if (compactionLevel === -1 || compactionSegments.length === 0) {
      // No level needs compaction; fall back to overlapping segment merge
      const overlapping = this.findOverlappingSegments(segments.filter(s => s.isImmutable));
      if (overlapping.length < 2) {
        return null;
      }
      compactionSegments = overlapping;
      targetLevelSegments = [];
    }

    // Collect all input segments: segments from the compaction level + overlapping from target level
    const overlappingInTarget = this.findOverlappingSegments([...compactionSegments, ...targetLevelSegments]);
    const inputSegments = this.deduplicateSegments([
      ...compactionSegments,
      ...targetLevelSegments.filter(s => overlappingInTarget.includes(s))
    ]).filter(s => s.isImmutable);

    if (inputSegments.length < 2) {
      return null;
    }

    // Sort by LSN to maintain ordering
    inputSegments.sort((a, b) => a.startLSN - b.startLSN);

    const totalSize = inputSegments.reduce((sum, s) => sum + s.sizeBytes, 0);
    const estimatedSavings = this.estimateSpaceSavings(inputSegments);
    const estimatedOutputSize = totalSize - estimatedSavings;

    const plan: CompactionPlan = {
      planId: `leveled-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      inputSegments,
      outputSegments: [{
        segmentId: `compacted-L${compactionLevel === -1 ? 0 : compactionLevel + 1}-${Date.now()}`,
        estimatedSize: estimatedOutputSize,
        lsnRange: {
          start: Math.min(...inputSegments.map(s => s.startLSN)),
          end: Math.max(...inputSegments.map(s => s.endLSN))
        }
      }],
      estimatedSpaceSaved: estimatedSavings,
      estimatedDuration: this.estimateCompactionDuration(totalSize),
      priority: this.calculatePriority(compactionLevel, inputSegments)
    };

    return this.validatePlan(plan, segments) ? plan : null;
  }

  async executeCompaction(plan: CompactionPlan): Promise<CompactionResult> {
    this.metrics.isRunning = true;
    const startTime = Date.now();

    try {
      const totalEntries = plan.inputSegments.reduce((sum, seg) => sum + seg.entryCount, 0);
      const totalTombstones = plan.inputSegments.reduce((sum, seg) => sum + seg.tombstoneCount, 0);
      const totalSize = plan.inputSegments.reduce((sum, seg) => sum + seg.sizeBytes, 0);

      // Estimate duplicates from overlapping key ranges (10% of non-tombstone entries)
      const estimatedDuplicates = Math.floor((totalEntries - totalTombstones) * 0.1);

      // Calculate space savings from removing tombstones and duplicates
      const entriesRemoved = totalTombstones + estimatedDuplicates;
      const spaceSavedRatio = totalEntries > 0 ? entriesRemoved / totalEntries : 0;
      const actualSpaceSaved = Math.floor(totalSize * spaceSavedRatio);

      const estimatedOutputSize = totalSize - actualSpaceSaved;

      // Simulate processing time (realistic but fast for testing)
      const processingTime = Math.max(10, Math.floor(totalSize / (1024 * 1024))); // 1ms per MB, min 10ms
      await new Promise(resolve => setTimeout(resolve, Math.min(processingTime, 500)));

      const result: CompactionResult = {
        planId: plan.planId,
        success: true,
        actualSpaceSaved,
        actualDuration: Date.now() - startTime,
        segmentsCreated: plan.outputSegments.map(seg => ({
          segmentId: seg.segmentId,
          filePath: `/compacted/${seg.segmentId}.wal`,
          startLSN: plan.inputSegments[0]?.startLSN || 0,
          endLSN: plan.inputSegments[plan.inputSegments.length - 1]?.endLSN || 0,
          createdAt: Date.now(),
          sizeBytes: Math.floor(estimatedOutputSize / plan.outputSegments.length),
          entryCount: totalEntries - entriesRemoved,
          tombstoneCount: 0, // Compaction removes all tombstones
          isImmutable: true
        })),
        segmentsDeleted: plan.inputSegments.map(seg => seg.segmentId),
        metrics: {
          entriesProcessed: totalEntries,
          entriesCompacted: totalEntries - entriesRemoved,
          tombstonesRemoved: totalTombstones,
          duplicatesRemoved: estimatedDuplicates
        }
      };

      this.updateMetrics(result);
      return result;
    } catch (error) {
      const result: CompactionResult = {
        planId: plan.planId,
        success: false,
        actualSpaceSaved: 0,
        actualDuration: Date.now() - startTime,
        segmentsCreated: [],
        segmentsDeleted: [],
        error: error as Error,
        metrics: {
          entriesProcessed: 0,
          entriesCompacted: 0,
          tombstonesRemoved: 0,
          duplicatesRemoved: 0
        }
      };

      this.updateMetrics(result);
      return result;
    } finally {
      this.metrics.isRunning = false;
    }
  }

  /**
   * Assign segments to levels based on their size.
   * Smallest/newest segments go to level 0, larger ones to higher levels.
   */
  private assignSegmentsToLevels(segments: WALSegment[]): Map<number, WALSegment[]> {
    const levels = new Map<number, WALSegment[]>();

    for (const segment of segments) {
      const level = this.calculateTargetLevel(segment);
      if (!levels.has(level)) {
        levels.set(level, []);
      }
      levels.get(level)!.push(segment);
    }

    return levels;
  }

  /**
   * Calculate the target size for a given level.
   * Level 1 = baseLevelSize, each subsequent level is levelSizeMultiplier times larger.
   */
  private getLevelTargetSize(level: number): number {
    if (level === 0) {
      // Level 0 is bounded by segment count, not size
      return Infinity;
    }
    let size = this.baseLevelSize;
    for (let i = 1; i < level; i++) {
      size *= this.levelSizeMultiplier;
    }
    return size;
  }

  /**
   * Calculate which level a segment should be assigned to based on its size
   */
  private calculateTargetLevel(segment: WALSegment): number {
    let level = 0;
    let levelSize = this.baseLevelSize;

    while (level < this.maxLevels - 1 && segment.sizeBytes > levelSize) {
      level++;
      levelSize *= this.levelSizeMultiplier;
    }

    return level;
  }

  /**
   * Check for overlapping segments that need compaction
   */
  private findOverlappingSegments(segments: WALSegment[]): WALSegment[] {
    const overlapping: WALSegment[] = [];

    // Sort by start LSN for overlap detection
    const sortedSegments = [...segments].sort((a, b) => a.startLSN - b.startLSN);

    for (let i = 1; i < sortedSegments.length; i++) {
      const current = sortedSegments[i];
      const previous = sortedSegments[i - 1];

      if (current.startLSN <= previous.endLSN) {
        if (!overlapping.includes(previous)) {
          overlapping.push(previous);
        }
        if (!overlapping.includes(current)) {
          overlapping.push(current);
        }
      }
    }

    return overlapping;
  }

  /**
   * Estimate space savings from compacting the given segments
   */
  private estimateSpaceSavings(segments: WALSegment[]): number {
    const totalSize = segments.reduce((sum, s) => sum + s.sizeBytes, 0);
    const totalEntries = segments.reduce((sum, s) => sum + s.entryCount, 0);
    const totalTombstones = segments.reduce((sum, s) => sum + s.tombstoneCount, 0);

    if (totalEntries === 0) {
      return 0;
    }

    // Savings come from tombstone removal + estimated duplicate removal
    const tombstoneRatio = totalTombstones / totalEntries;
    const estimatedDuplicateRatio = 0.1;
    const savingsRatio = Math.min(tombstoneRatio + estimatedDuplicateRatio, 0.9); // Cap at 90%

    return Math.floor(totalSize * savingsRatio);
  }

  /**
   * Estimate duration of compaction based on data size
   */
  private estimateCompactionDuration(totalSizeBytes: number): number {
    // Rough estimate: 10MB/second processing speed
    const processingSpeedBytesPerMs = 10 * 1024 * 1024 / 1000;
    return totalSizeBytes / processingSpeedBytesPerMs;
  }

  /**
   * Calculate compaction priority based on level and segment state
   */
  private calculatePriority(level: number, segments: WALSegment[]): 'low' | 'medium' | 'high' | 'urgent' {
    // Level 0 compactions are always high priority (blocks writes)
    if (level === 0) {
      return segments.length > this.level0SegmentLimit * 2 ? 'urgent' : 'high';
    }

    const totalTombstones = segments.reduce((sum, s) => sum + s.tombstoneCount, 0);
    const totalEntries = segments.reduce((sum, s) => sum + s.entryCount, 0);
    const tombstoneRatio = totalEntries > 0 ? totalTombstones / totalEntries : 0;

    if (tombstoneRatio > 0.7) {
      return 'urgent';
    }
    if (tombstoneRatio > 0.5 || level <= 1) {
      return 'high';
    }
    if (tombstoneRatio > 0.3) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Remove duplicate segments from an array (by segmentId)
   */
  private deduplicateSegments(segments: WALSegment[]): WALSegment[] {
    const seen = new Set<string>();
    return segments.filter(s => {
      if (seen.has(s.segmentId)) return false;
      seen.add(s.segmentId);
      return true;
    });
  }
}
