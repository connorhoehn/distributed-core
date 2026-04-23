import { CompactionStrategy, WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan, CompactionResult } from './types';

/**
 * Size-tiered compaction strategy (Cassandra-style)
 *
 * This strategy focuses on reducing the number of segments by compacting
 * segments of similar sizes together. Good for write-heavy workloads.
 */
export class SizeTieredCompactionStrategy extends CompactionStrategy {
  private readonly sizeTiers: number[];
  private readonly maxSegmentsPerTier: number;
  private readonly minSegmentSize: number;

  constructor(config: {
    sizeTiers?: number[];        // Size buckets in bytes, default [1MB, 10MB, 100MB]
    maxSegmentsPerTier?: number; // Max segments before compaction, default 4
    minSegmentSize?: number;     // Min segment size to compact, default 1MB
  } = {}) {
    super(config);

    this.sizeTiers = config.sizeTiers || [1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024];
    this.maxSegmentsPerTier = config.maxSegmentsPerTier || 4;
    this.minSegmentSize = config.minSegmentSize || 1024 * 1024;
  }

  shouldCompact(walMetrics: WALMetrics, checkpointMetrics: CheckpointMetrics): boolean {
    if (this.metrics.isRunning) {
      return false;
    }

    // Trigger when total segment count reaches the per-tier maximum
    if (walMetrics.segmentCount >= this.maxSegmentsPerTier) {
      return true;
    }

    // High churn (many tombstones) warrants compaction regardless of tier state
    if (walMetrics.tombstoneRatio > 0.5) {
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
    if (immutableSegments.length === 0) {
      return null;
    }

    // Group immutable segments by size tier
    const tierGroups = this.groupSegmentsByTier(immutableSegments);

    // Find all tiers that have enough segments to warrant compaction
    let candidateTier: number | null = null;
    let maxCount = 0;

    for (const [tier, tierSegments] of tierGroups) {
      if (tierSegments.length >= this.maxSegmentsPerTier) {
        // Pick the tier with the most segments; break ties by lowest tier index
        if (tierSegments.length > maxCount || (tierSegments.length === maxCount && candidateTier !== null && tier < candidateTier)) {
          maxCount = tierSegments.length;
          candidateTier = tier;
        }
      }
    }

    if (candidateTier === null) {
      return null;
    }

    const inputSegments = tierGroups.get(candidateTier)!;

    const totalSize = inputSegments.reduce((s, seg) => s + seg.sizeBytes, 0);
    const totalEntries = inputSegments.reduce((s, seg) => s + seg.entryCount, 0);
    const totalTombstones = inputSegments.reduce((s, seg) => s + seg.tombstoneCount, 0);
    const estimatedRetainedRatio = totalEntries > 0 ? (totalEntries - totalTombstones) / totalEntries : 1;
    const estimatedOutputSize = Math.floor(totalSize * estimatedRetainedRatio);

    const now = Date.now();
    const plan: CompactionPlan = {
      planId: `size-tiered-T${candidateTier}-${now}-${Math.random().toString(36).substr(2, 9)}`,
      inputSegments,
      outputSegments: [{
        segmentId: `size-tiered-T${candidateTier + 1}-${now}`,
        estimatedSize: estimatedOutputSize,
        lsnRange: {
          start: Math.min(...inputSegments.map(s => s.startLSN)),
          end: Math.max(...inputSegments.map(s => s.endLSN))
        }
      }],
      estimatedSpaceSaved: totalSize - estimatedOutputSize,
      estimatedDuration: Math.max(50, Math.floor(totalSize / (15 * 1024 * 1024))), // ~15 MB/s
      priority: 'medium'
    };

    return this.validatePlan(plan, segments) ? plan : null;
  }

  async executeCompaction(plan: CompactionPlan): Promise<CompactionResult> {
    this.metrics.isRunning = true;
    const startTime = Date.now();

    try {
      const totalEntries = plan.inputSegments.reduce((sum, s) => sum + s.entryCount, 0);
      const totalTombstones = plan.inputSegments.reduce((sum, s) => sum + s.tombstoneCount, 0);
      const totalSize = plan.inputSegments.reduce((sum, s) => sum + s.sizeBytes, 0);

      const duplicatesRemoved = totalTombstones;
      const retainedEntries = Math.max(0, totalEntries - totalTombstones - duplicatesRemoved);
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

  private getSizeTier(segmentSize: number): number {
    for (let i = 0; i < this.sizeTiers.length; i++) {
      if (segmentSize <= this.sizeTiers[i]) {
        return i;
      }
    }
    return this.sizeTiers.length; // Largest tier
  }

  private groupSegmentsByTier(segments: WALSegment[]): Map<number, WALSegment[]> {
    const tierGroups = new Map<number, WALSegment[]>();

    for (const segment of segments) {
      const tier = this.getSizeTier(segment.sizeBytes);
      if (!tierGroups.has(tier)) {
        tierGroups.set(tier, []);
      }
      tierGroups.get(tier)!.push(segment);
    }

    return tierGroups;
  }
}
