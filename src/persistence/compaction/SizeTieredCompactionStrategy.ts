import { CompactionStrategy, WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan, CompactionResult } from './types';

/**
 * Size-tiered compaction strategy (Cassandra-style)
 * 
 * This strategy focuses on reducing the number of segments by compacting
 * segments of similar sizes together. Good for write-heavy workloads.
 * 
 * STUB IMPLEMENTATION - Ready for future development
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
    // Don't compact if already running
    if (this.metrics.isRunning) {
      return false;
    }

    // Check if any size tier has more segments than the configured threshold.
    // We derive segment counts per tier from WAL metrics.  When called without
    // full segment data we fall back to a simple heuristic: if the overall
    // segment count exceeds maxSegmentsPerTier it is very likely that at least
    // one tier is over the limit.
    if (walMetrics.segmentCount > this.maxSegmentsPerTier) {
      return true;
    }

    // Also trigger on high tombstone or duplicate ratios (space can be reclaimed)
    if (walMetrics.tombstoneRatio > 0.3) {
      return true;
    }

    if (walMetrics.duplicateEntryRatio > 0.5) {
      return true;
    }

    return false;
  }

  planCompaction(segments: WALSegment[], checkpointMetrics: CheckpointMetrics): CompactionPlan | null {
    if (segments.length === 0) {
      return null;
    }

    // Only consider immutable segments
    const immutableSegments = segments.filter(s => s.isImmutable);
    if (immutableSegments.length < 2) {
      return null;
    }

    // Group segments by size tier
    const tierGroups = this.groupSegmentsByTier(immutableSegments);

    // Find the tier with the most segments
    let bestTier = -1;
    let bestTierSegments: WALSegment[] = [];
    for (const [tier, tierSegments] of tierGroups) {
      if (tierSegments.length > bestTierSegments.length) {
        bestTier = tier;
        bestTierSegments = tierSegments;
      }
    }

    // Need at least 2 segments in a tier to make compaction worthwhile
    if (bestTierSegments.length < 2) {
      return null;
    }

    // Sort by LSN to maintain ordering
    bestTierSegments.sort((a, b) => a.startLSN - b.startLSN);

    const totalSize = bestTierSegments.reduce((sum, s) => sum + s.sizeBytes, 0);
    const totalTombstones = bestTierSegments.reduce((sum, s) => sum + s.tombstoneCount, 0);
    const totalEntries = bestTierSegments.reduce((sum, s) => sum + s.entryCount, 0);
    const estimatedDuplicateRatio = 0.1;
    const tombstoneRatio = totalEntries > 0 ? totalTombstones / totalEntries : 0;
    const savingsRatio = tombstoneRatio + estimatedDuplicateRatio;
    const estimatedCompactedSize = Math.floor(totalSize * (1 - savingsRatio));

    const plan: CompactionPlan = {
      planId: `size-tiered-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      inputSegments: bestTierSegments,
      outputSegments: [{
        segmentId: `compacted-tier${bestTier}-${Date.now()}`,
        estimatedSize: estimatedCompactedSize,
        lsnRange: {
          start: Math.min(...bestTierSegments.map(s => s.startLSN)),
          end: Math.max(...bestTierSegments.map(s => s.endLSN))
        }
      }],
      estimatedSpaceSaved: totalSize - estimatedCompactedSize,
      estimatedDuration: this.estimateCompactionDuration(totalSize),
      priority: this.calculatePriority(bestTierSegments)
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

      // Estimate duplicates (10% of non-tombstone entries)
      const estimatedDuplicates = Math.floor((totalEntries - totalTombstones) * 0.1);

      // Calculate space savings from removing tombstones and duplicates
      const entriesRemoved = totalTombstones + estimatedDuplicates;
      const spaceSavedRatio = totalEntries > 0 ? entriesRemoved / totalEntries : 0;
      const actualSpaceSaved = Math.floor(totalSize * spaceSavedRatio);
      const estimatedOutputSize = totalSize - actualSpaceSaved;

      // Simulate processing time (1ms per MB, min 10ms, capped at 500ms)
      const processingTime = Math.max(10, Math.floor(totalSize / (1024 * 1024)));
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
          tombstoneCount: 0,
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

  private estimateCompactionDuration(totalSizeBytes: number): number {
    // Rough estimate: 10MB/second processing speed
    const processingSpeedBytesPerMs = 10 * 1024 * 1024 / 1000;
    return totalSizeBytes / processingSpeedBytesPerMs;
  }

  private calculatePriority(segments: WALSegment[]): 'low' | 'medium' | 'high' | 'urgent' {
    const totalTombstones = segments.reduce((sum, s) => sum + s.tombstoneCount, 0);
    const totalEntries = segments.reduce((sum, s) => sum + s.entryCount, 0);
    const tombstoneRatio = totalEntries > 0 ? totalTombstones / totalEntries : 0;

    // Priority based on tier saturation and tombstone ratio
    if (segments.length > this.maxSegmentsPerTier * 2 || tombstoneRatio > 0.7) {
      return 'urgent';
    }
    if (segments.length > this.maxSegmentsPerTier || tombstoneRatio > 0.5) {
      return 'high';
    }
    if (segments.length > this.maxSegmentsPerTier / 2 || tombstoneRatio > 0.3) {
      return 'medium';
    }
    return 'low';
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
