/**
 * Core compaction strategy interfaces and types
 */

export interface WALMetrics {
  segmentCount: number;
  totalSizeBytes: number;
  oldestSegmentAge: number;
  tombstoneRatio: number;
  duplicateEntryRatio: number;
}

export interface CheckpointMetrics {
  lastCheckpointLSN: number;
  lastCheckpointAge: number;
  segmentsSinceCheckpoint: number;
}

export interface WALSegment {
  segmentId: string;
  filePath: string;
  startLSN: number;
  endLSN: number;
  createdAt: number;
  sizeBytes: number;
  entryCount: number;
  tombstoneCount: number;
  isImmutable: boolean;
}

export interface CompactionPlan {
  planId: string;
  inputSegments: WALSegment[];
  outputSegments: {
    segmentId: string;
    estimatedSize: number;
    lsnRange: { start: number; end: number };
  }[];
  estimatedSpaceSaved: number;
  estimatedDuration: number;
  priority: 'low' | 'medium' | 'high' | 'urgent';
}

export interface CompactionResult {
  planId: string;
  success: boolean;
  actualSpaceSaved: number;
  actualDuration: number;
  segmentsCreated: WALSegment[];
  segmentsDeleted: string[];
  error?: Error;
  metrics: {
    entriesProcessed: number;
    entriesCompacted: number;
    tombstonesRemoved: number;
    duplicatesRemoved: number;
  };
}

export interface CompactionMetrics {
  strategy: string;
  totalRuns: number;
  successfulRuns: number;
  totalSpaceSaved: number;
  totalDuration: number;
  averageSpaceSaved: number;
  averageDuration: number;
  lastRunTimestamp: number;
  isRunning: boolean;
}

/**
 * Abstract base class for compaction strategies
 */
export abstract class CompactionStrategy {
  protected config: Record<string, any>;
  protected metrics: CompactionMetrics;

  constructor(config: Record<string, any> = {}) {
    this.config = config;
    this.metrics = {
      strategy: this.constructor.name,
      totalRuns: 0,
      successfulRuns: 0,
      totalSpaceSaved: 0,
      totalDuration: 0,
      averageSpaceSaved: 0,
      averageDuration: 0,
      lastRunTimestamp: 0,
      isRunning: false
    };
  }

  /**
   * Determine if compaction should run based on current metrics
   */
  abstract shouldCompact(walMetrics: WALMetrics, checkpointMetrics: CheckpointMetrics): boolean;

  /**
   * Create a compaction plan for the given segments and checkpoints
   */
  abstract planCompaction(segments: WALSegment[], checkpointMetrics: CheckpointMetrics): CompactionPlan | null;

  /**
   * Execute the compaction plan (implemented by CompactionCoordinator)
   */
  abstract executeCompaction(plan: CompactionPlan): Promise<CompactionResult>;

  /**
   * Get current strategy metrics
   */
  getMetrics(): CompactionMetrics {
    return { ...this.metrics };
  }

  /**
   * Update metrics after compaction run
   */
  protected updateMetrics(result: CompactionResult): void {
    this.metrics.totalRuns++;
    if (result.success) {
      this.metrics.successfulRuns++;
      this.metrics.totalSpaceSaved += result.actualSpaceSaved;
    }
    this.metrics.totalDuration += result.actualDuration;
    this.metrics.averageSpaceSaved = this.metrics.totalSpaceSaved / Math.max(this.metrics.successfulRuns, 1);
    this.metrics.averageDuration = this.metrics.totalDuration / this.metrics.totalRuns;
    this.metrics.lastRunTimestamp = Date.now();
    this.metrics.isRunning = false;
  }

  /**
   * Validate that a compaction plan is safe to execute
   */
  protected validatePlan(plan: CompactionPlan, segments: WALSegment[]): boolean {
    // Ensure all input segments exist
    const segmentIds = new Set(segments.map(s => s.segmentId));
    for (const inputSegment of plan.inputSegments) {
      if (!segmentIds.has(inputSegment.segmentId)) {
        return false;
      }
    }

    // Ensure segments are immutable (can't compact active segments)
    for (const inputSegment of plan.inputSegments) {
      if (!inputSegment.isImmutable) {
        return false;
      }
    }

    // Ensure LSN ranges are valid
    for (const outputSegment of plan.outputSegments) {
      if (outputSegment.lsnRange.start >= outputSegment.lsnRange.end) {
        return false;
      }
    }

    return true;
  }

  /**
   * Calculate benefit score for a potential compaction
   */
  protected calculateBenefit(segments: WALSegment[]): number {
    const totalSize = segments.reduce((sum, s) => sum + s.sizeBytes, 0);
    const totalTombstones = segments.reduce((sum, s) => sum + s.tombstoneCount, 0);
    const totalEntries = segments.reduce((sum, s) => sum + s.entryCount, 0);
    
    const tombstoneRatio = totalEntries > 0 ? totalTombstones / totalEntries : 0;
    const ageWeight = Math.min(Date.now() - Math.min(...segments.map(s => s.createdAt)), 86400000) / 86400000; // 0-1 based on age up to 24h
    
    return tombstoneRatio * 0.7 + ageWeight * 0.3; // Weighted score
  }
}
