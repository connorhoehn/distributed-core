import { CompactionStrategy, WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan, CompactionResult } from './types';

/**
 * Vacuum-based compaction strategy (PostgreSQL-style)
 *
 * This strategy focuses on optimizing read performance by rebuilding segments
 * to remove dead tuples and optimize layout. Good for read-heavy workloads.
 *
 * Like PostgreSQL's VACUUM, it:
 * - Identifies "dead tuples" (entries superseded by newer versions or tombstones)
 * - Calculates fragmentation ratio based on segment age and overlap
 * - Identifies hot data that should be kept together
 * - Triggers when dead tuple ratio or fragmentation exceeds thresholds
 */
export class VacuumBasedCompactionStrategy extends CompactionStrategy {
  private readonly deadTupleThreshold: number;
  private readonly fragmentationThreshold: number;
  private readonly vacuumIntervalMs: number;
  private readonly hotDataWindowMs: number;

  constructor(config: {
    deadTupleThreshold?: number;      // Ratio 0-1, default 0.2 (20% dead)
    fragmentationThreshold?: number;  // Ratio 0-1, default 0.3 (30% fragmented)
    vacuumIntervalMs?: number;        // Min time between vacuums, default 1 hour
    hotDataWindowMs?: number;         // Window for "hot" data, default 1 hour
  } = {}) {
    super(config);

    this.deadTupleThreshold = config.deadTupleThreshold || 0.2;
    this.fragmentationThreshold = config.fragmentationThreshold || 0.3;
    this.vacuumIntervalMs = config.vacuumIntervalMs || 60 * 60 * 1000; // 1 hour
    this.hotDataWindowMs = config.hotDataWindowMs || 60 * 60 * 1000; // 1 hour
  }

  shouldCompact(walMetrics: WALMetrics, checkpointMetrics: CheckpointMetrics): boolean {
    if (this.metrics.isRunning) {
      return false;
    }

    // Respect minimum vacuum interval
    const timeSinceLastRun = Date.now() - this.metrics.lastRunTimestamp;
    if (timeSinceLastRun < this.vacuumIntervalMs) {
      return false;
    }

    // Trigger when dead tuple ratio exceeds threshold.
    // tombstoneRatio is a proxy for dead tuples at the WAL level — tombstones
    // mark deleted/superseded entries.  duplicateEntryRatio captures updates
    // that produce superseded versions of the same key.
    const estimatedDeadTupleRatio = walMetrics.tombstoneRatio + walMetrics.duplicateEntryRatio;
    if (estimatedDeadTupleRatio > this.deadTupleThreshold) {
      return true;
    }

    // Trigger when fragmentation is high.
    // We estimate fragmentation from segment count relative to total size:
    // many small, old segments indicate scattered live data.
    const avgSegmentAge = walMetrics.oldestSegmentAge / 2; // rough average
    const ageFactor = Math.min(avgSegmentAge / (24 * 60 * 60 * 1000), 1); // 0-1 over 24h
    const segmentScatter = Math.min(walMetrics.segmentCount / 20, 1); // 0-1, 20 segs = max
    const estimatedFragmentation = ageFactor * 0.5 + segmentScatter * 0.5;
    if (estimatedFragmentation > this.fragmentationThreshold) {
      return true;
    }

    return false;
  }

  planCompaction(segments: WALSegment[], checkpointMetrics: CheckpointMetrics): CompactionPlan | null {
    if (segments.length === 0) {
      return null;
    }

    // Identify segments exceeding dead tuple or fragmentation thresholds
    const candidates = segments.filter(segment => {
      if (!segment.isImmutable) {
        return false;
      }
      const deadRatio = this.calculateDeadTupleRatio(segment);
      const fragRatio = this.calculateFragmentationRatio(segment);
      return deadRatio >= this.deadTupleThreshold || fragRatio >= this.fragmentationThreshold;
    });

    if (candidates.length === 0) {
      return null;
    }

    // Prioritize segments with highest combined dead-tuple + fragmentation score
    candidates.sort((a, b) => {
      const scoreA = this.calculateDeadTupleRatio(a) + this.calculateFragmentationRatio(a);
      const scoreB = this.calculateDeadTupleRatio(b) + this.calculateFragmentationRatio(b);
      return scoreB - scoreA;
    });

    // Separate hot data — these get their own optimized output segment
    const hotSegments = this.identifyHotData(candidates);
    const coldSegments = candidates.filter(s => !hotSegments.includes(s));

    // Build output segments: one for cold data (if any), one for hot data (if any)
    const outputSegments: CompactionPlan['outputSegments'] = [];

    if (coldSegments.length > 0) {
      const coldSize = coldSegments.reduce((sum, s) => sum + s.sizeBytes, 0);
      const coldDeadRatio = coldSegments.reduce((sum, s) => sum + s.sizeBytes * this.calculateDeadTupleRatio(s), 0) / coldSize;
      outputSegments.push({
        segmentId: `vacuum-cold-${Date.now()}`,
        estimatedSize: Math.floor(coldSize * (1 - coldDeadRatio)),
        lsnRange: {
          start: Math.min(...coldSegments.map(s => s.startLSN)),
          end: Math.max(...coldSegments.map(s => s.endLSN))
        }
      });
    }

    if (hotSegments.length > 0) {
      const hotSize = hotSegments.reduce((sum, s) => sum + s.sizeBytes, 0);
      const hotDeadRatio = hotSegments.reduce((sum, s) => sum + s.sizeBytes * this.calculateDeadTupleRatio(s), 0) / hotSize;
      outputSegments.push({
        segmentId: `vacuum-hot-${Date.now()}`,
        estimatedSize: Math.floor(hotSize * (1 - hotDeadRatio)),
        lsnRange: {
          start: Math.min(...hotSegments.map(s => s.startLSN)),
          end: Math.max(...hotSegments.map(s => s.endLSN))
        }
      });
    }

    const totalInputSize = candidates.reduce((sum, s) => sum + s.sizeBytes, 0);
    const totalOutputSize = outputSegments.reduce((sum, s) => sum + s.estimatedSize, 0);

    const plan: CompactionPlan = {
      planId: `vacuum-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      inputSegments: candidates,
      outputSegments,
      estimatedSpaceSaved: totalInputSize - totalOutputSize,
      estimatedDuration: this.estimateVacuumDuration(totalInputSize),
      priority: this.calculateVacuumPriority(candidates)
    };

    return this.validatePlan(plan, segments) ? plan : null;
  }

  async executeCompaction(plan: CompactionPlan): Promise<CompactionResult> {
    this.metrics.isRunning = true;
    const startTime = Date.now();

    try {
      // Calculate realistic metrics based on input segments
      const totalEntries = plan.inputSegments.reduce((sum, seg) => sum + seg.entryCount, 0);
      const totalTombstones = plan.inputSegments.reduce((sum, seg) => sum + seg.tombstoneCount, 0);
      const totalSize = plan.inputSegments.reduce((sum, seg) => sum + seg.sizeBytes, 0);

      // Dead tuples = tombstones + estimated superseded entries (duplicates)
      const estimatedDuplicates = Math.floor((totalEntries - totalTombstones) * 0.1);
      const deadTuples = totalTombstones + estimatedDuplicates;

      // Space saved by removing dead tuples
      const spaceSavedRatio = totalEntries > 0 ? deadTuples / totalEntries : 0;
      const actualSpaceSaved = Math.floor(totalSize * spaceSavedRatio);
      const outputSize = totalSize - actualSpaceSaved;

      // Simulate vacuum processing time (1ms per MB, min 10ms, capped at 500ms)
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
          startLSN: seg.lsnRange.start,
          endLSN: seg.lsnRange.end,
          createdAt: Date.now(),
          sizeBytes: Math.floor(outputSize / plan.outputSegments.length),
          entryCount: totalEntries - deadTuples,
          tombstoneCount: 0, // Vacuum removes all dead tuples
          isImmutable: true
        })),
        segmentsDeleted: plan.inputSegments.map(seg => seg.segmentId),
        metrics: {
          entriesProcessed: totalEntries,
          entriesCompacted: totalEntries - deadTuples,
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
   * Calculate dead tuple ratio for a segment.
   * Dead tuples are entries superseded by newer versions (tombstones) plus
   * an estimate of duplicate/updated entries based on the segment's age and
   * density.  Older segments with many entries are more likely to contain
   * superseded data.
   */
  calculateDeadTupleRatio(segment: WALSegment): number {
    if (segment.entryCount === 0) {
      return 0;
    }

    // Base: tombstones directly mark dead data
    const tombstoneRatio = segment.tombstoneCount / segment.entryCount;

    // Estimate additional superseded entries based on segment age.
    // Older segments are more likely to have entries that have been updated
    // in newer segments.
    const ageMs = Date.now() - segment.createdAt;
    const ageFactor = Math.min(ageMs / (24 * 60 * 60 * 1000), 1); // 0-1 over 24h
    const estimatedSupersededRatio = ageFactor * 0.15; // Up to 15% additional dead tuples from age

    return Math.min(tombstoneRatio + estimatedSupersededRatio, 1);
  }

  /**
   * Calculate fragmentation ratio for a segment.
   * Fragmentation measures how scattered live data is within the segment.
   * We estimate this from:
   * - Segment age (older segments accumulate fragmentation as entries are deleted)
   * - Tombstone density (high tombstone count = holes in the data)
   * - LSN range density (wide LSN range with few entries = sparse/fragmented)
   */
  calculateFragmentationRatio(segment: WALSegment): number {
    if (segment.entryCount === 0) {
      return 0;
    }

    // Age-based fragmentation: older segments tend to be more fragmented
    const ageMs = Date.now() - segment.createdAt;
    const ageFactor = Math.min(ageMs / (48 * 60 * 60 * 1000), 1); // 0-1 over 48h

    // Tombstone-based fragmentation: tombstones create "holes"
    const tombstoneRatio = segment.tombstoneCount / segment.entryCount;

    // LSN density: wide LSN range with few entries = sparse data
    const lsnRange = segment.endLSN - segment.startLSN;
    const lsnDensity = lsnRange > 0 ? segment.entryCount / lsnRange : 1;
    const sparsityFactor = 1 - Math.min(lsnDensity, 1); // Lower density = higher fragmentation

    // Weighted combination
    return Math.min(
      ageFactor * 0.3 + tombstoneRatio * 0.4 + sparsityFactor * 0.3,
      1
    );
  }

  /**
   * Identify hot data segments — recently created segments that are likely
   * still being actively read.  These should be kept together in an optimized
   * layout for better read performance.
   */
  identifyHotData(segments: WALSegment[]): WALSegment[] {
    const now = Date.now();
    return segments.filter(s => (now - s.createdAt) < this.hotDataWindowMs);
  }

  /**
   * Estimate vacuum duration based on total input size.
   * Vacuum is slightly slower than simple compaction due to dead-tuple
   * analysis overhead.
   */
  private estimateVacuumDuration(totalSizeBytes: number): number {
    // ~8 MB/s processing (slightly slower than simple merge due to analysis)
    const processingSpeedBytesPerMs = 8 * 1024 * 1024 / 1000;
    return totalSizeBytes / processingSpeedBytesPerMs;
  }

  /**
   * Calculate vacuum priority based on dead tuple and fragmentation severity.
   */
  private calculateVacuumPriority(segments: WALSegment[]): 'low' | 'medium' | 'high' | 'urgent' {
    const totalEntries = segments.reduce((sum, s) => sum + s.entryCount, 0);
    const totalTombstones = segments.reduce((sum, s) => sum + s.tombstoneCount, 0);
    const avgDeadRatio = totalEntries > 0 ? totalTombstones / totalEntries : 0;

    const avgFragmentation = segments.length > 0
      ? segments.reduce((sum, s) => sum + this.calculateFragmentationRatio(s), 0) / segments.length
      : 0;

    const combinedScore = avgDeadRatio * 0.6 + avgFragmentation * 0.4;

    if (combinedScore > 0.7) {
      return 'urgent';
    }
    if (combinedScore > 0.5) {
      return 'high';
    }
    if (combinedScore > 0.3) {
      return 'medium';
    }
    return 'low';
  }
}
