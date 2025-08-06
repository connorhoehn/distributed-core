import { CompactionStrategy, WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan, CompactionResult } from './types';

/**
 * Time-based compaction strategy implementation
 * 
 * This strategy compacts WAL segments based on:
 * - Age of segments (older than configured threshold)
 * - Checkpoint boundaries (segments older than last checkpoint)
 * - Size and efficiency thresholds
 */
export class TimeBasedCompactionStrategy extends CompactionStrategy {
  private readonly maxSegmentAge: number;
  private readonly maxSegmentSize: number;
  private readonly tombstoneThreshold: number;
  private readonly checkpointLagThreshold: number;

  constructor(config: {
    maxSegmentAge?: number;      // milliseconds, default 24 hours
    maxSegmentSize?: number;     // bytes, default 100MB
    tombstoneThreshold?: number; // ratio 0-1, default 0.3
    checkpointLagThreshold?: number; // number of checkpoints, default 2
  } = {}) {
    super(config);
    
    this.maxSegmentAge = config.maxSegmentAge || 24 * 60 * 60 * 1000; // 24 hours
    this.maxSegmentSize = config.maxSegmentSize || 100 * 1024 * 1024; // 100MB
    this.tombstoneThreshold = config.tombstoneThreshold || 0.3; // 30%
    this.checkpointLagThreshold = config.checkpointLagThreshold || 2;
  }

  shouldCompact(walMetrics: WALMetrics, checkpointMetrics: CheckpointMetrics): boolean {
    // Don't compact if already running
    if (this.metrics.isRunning) {
      return false;
    }

    // Compact if we have too many segments
    if (walMetrics.segmentCount > 10) {
      return true;
    }

    // Compact if oldest segment is too old
    if (walMetrics.oldestSegmentAge > this.maxSegmentAge) {
      return true;
    }

    // Compact if we have too many segments since last checkpoint
    if (checkpointMetrics.segmentsSinceCheckpoint > this.checkpointLagThreshold) {
      return true;
    }

    // Compact if we have a high tombstone ratio
    if (walMetrics.tombstoneRatio > this.tombstoneThreshold) {
      return true;
    }

    // Compact if duplicate ratio is high (indicates many updates to same entities)
    if (walMetrics.duplicateEntryRatio > 0.5) {
      return true;
    }

    return false;
  }

  planCompaction(segments: WALSegment[], checkpointMetrics: CheckpointMetrics): CompactionPlan | null {
    if (segments.length === 0) {
      return null;
    }

    const now = Date.now();
    const candidateSegments = segments.filter(segment => {
      // Only compact immutable segments
      if (!segment.isImmutable) {
        return false;
      }

      // Prefer older segments
      const age = now - segment.createdAt;
      if (age > this.maxSegmentAge / 2) { // At least 12 hours old by default
        return true;
      }

      // Include segments older than last checkpoint
      if (segment.endLSN <= checkpointMetrics.lastCheckpointLSN) {
        return true;
      }

      // Include segments with high tombstone ratio
      const tombstoneRatio = segment.entryCount > 0 ? segment.tombstoneCount / segment.entryCount : 0;
      if (tombstoneRatio > this.tombstoneThreshold) {
        return true;
      }

      return false;
    });

    if (candidateSegments.length < 2) {
      // Need at least 2 segments to make compaction worthwhile
      return null;
    }

    // Sort by LSN to maintain ordering
    candidateSegments.sort((a, b) => a.startLSN - b.startLSN);

    // Group segments that can be compacted together
    const compactionGroups = this.groupSegmentsForCompaction(candidateSegments);
    
    if (compactionGroups.length === 0) {
      return null;
    }

    // Pick the group with highest benefit
    const bestGroup = compactionGroups.reduce((best, current) => {
      const bestBenefit = this.calculateBenefit(best);
      const currentBenefit = this.calculateBenefit(current);
      return currentBenefit > bestBenefit ? current : best;
    });

    const totalSize = bestGroup.reduce((sum, s) => sum + s.sizeBytes, 0);
    const estimatedCompactedSize = totalSize * (1 - this.estimateCompressionRatio(bestGroup));

    const plan: CompactionPlan = {
      planId: `time-based-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      inputSegments: bestGroup,
      outputSegments: [{
        segmentId: `compacted-${Date.now()}`,
        estimatedSize: estimatedCompactedSize,
        lsnRange: {
          start: Math.min(...bestGroup.map(s => s.startLSN)),
          end: Math.max(...bestGroup.map(s => s.endLSN))
        }
      }],
      estimatedSpaceSaved: totalSize - estimatedCompactedSize,
      estimatedDuration: this.estimateCompactionDuration(totalSize),
      priority: this.calculatePriority(bestGroup, checkpointMetrics)
    };

    return this.validatePlan(plan, segments) ? plan : null;
  }

    async executeCompaction(plan: CompactionPlan): Promise<CompactionResult> {
    // SIMPLIFIED COMPACTION: This simulates the core compaction logic
    // In a production system, this would integrate with actual WAL file I/O
    
    this.metrics.isRunning = true;
    const startTime = Date.now();

    try {
      // Calculate realistic space savings based on tombstone removal and deduplication
      const totalEntries = plan.inputSegments.reduce((sum, seg) => sum + seg.entryCount, 0);
      const totalTombstones = plan.inputSegments.reduce((sum, seg) => sum + seg.tombstoneCount, 0);
      const totalSize = plan.inputSegments.reduce((sum, seg) => sum + seg.sizeBytes, 0);
      
      // Estimate duplicates (10% of non-tombstone entries)
      const estimatedDuplicates = Math.floor((totalEntries - totalTombstones) * 0.1);
      
      // Calculate space savings: remove tombstones and duplicates
      const entriesRemoved = totalTombstones + estimatedDuplicates;
      const spaceSavedRatio = entriesRemoved / totalEntries;
      const actualSpaceSaved = Math.floor(totalSize * spaceSavedRatio);
      
      // Estimate output size
      const estimatedOutputSize = totalSize - actualSpaceSaved;
      
      // Simulate processing time (realistic but fast for testing)
      const processingTime = Math.max(10, Math.floor(totalSize / (1024 * 1024))); // 1ms per MB, min 10ms
      await new Promise(resolve => setTimeout(resolve, Math.min(processingTime, 500)));

      const result: CompactionResult = {
        planId: plan.planId,
        success: true,
        actualSpaceSaved: actualSpaceSaved,
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

  private groupSegmentsForCompaction(segments: WALSegment[]): WALSegment[][] {
    const groups: WALSegment[][] = [];
    
    // Simple strategy: group consecutive segments up to a size limit
    let currentGroup: WALSegment[] = [];
    let currentGroupSize = 0;
    const maxGroupSize = this.maxSegmentSize * 4; // Compact up to 4 max-sized segments together

    for (const segment of segments) {
      if (currentGroupSize + segment.sizeBytes > maxGroupSize && currentGroup.length > 0) {
        // Start new group
        groups.push(currentGroup);
        currentGroup = [segment];
        currentGroupSize = segment.sizeBytes;
      } else {
        currentGroup.push(segment);
        currentGroupSize += segment.sizeBytes;
      }
    }

    if (currentGroup.length > 1) { // Only include groups with multiple segments
      groups.push(currentGroup);
    }

    return groups;
  }

  private estimateCompressionRatio(segments: WALSegment[]): number {
    // Estimate how much space we can save through compaction
    const totalTombstones = segments.reduce((sum, s) => sum + s.tombstoneCount, 0);
    const totalEntries = segments.reduce((sum, s) => sum + s.entryCount, 0);
    
    const tombstoneRatio = totalEntries > 0 ? totalTombstones / totalEntries : 0;
    const estimatedDuplicateRatio = 0.2; // Conservative estimate
    
    return tombstoneRatio + estimatedDuplicateRatio;
  }

  private estimateCompactionDuration(totalSizeBytes: number): number {
    // Rough estimate: 10MB/second processing speed
    const processingSpeedBytesPerMs = 10 * 1024 * 1024 / 1000;
    return totalSizeBytes / processingSpeedBytesPerMs;
  }

  private calculatePriority(segments: WALSegment[], checkpointMetrics: CheckpointMetrics): 'low' | 'medium' | 'high' | 'urgent' {
    const now = Date.now();
    const oldestAge = Math.max(...segments.map(s => now - s.createdAt));
    const totalTombstones = segments.reduce((sum, s) => sum + s.tombstoneCount, 0);
    const totalEntries = segments.reduce((sum, s) => sum + s.entryCount, 0);
    const tombstoneRatio = totalEntries > 0 ? totalTombstones / totalEntries : 0;

    // Urgent: Very old segments or very high tombstone ratio
    if (oldestAge > this.maxSegmentAge * 2 || tombstoneRatio > 0.7) {
      return 'urgent';
    }

    // High: Old segments or high tombstone ratio
    if (oldestAge > this.maxSegmentAge || tombstoneRatio > 0.5) {
      return 'high';
    }

    // Medium: Moderately old or moderate tombstones
    if (oldestAge > this.maxSegmentAge / 2 || tombstoneRatio > 0.3) {
      return 'medium';
    }

    return 'low';
  }
}
