import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CompactionStrategy, WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan, CompactionResult } from './types';
import { CompactionStrategyFactory, CompactionStrategyType } from './CompactionStrategyFactory';
import { WALReaderImpl } from '../wal/WALReader';
import { WALEntry } from '../wal/types';
import { CheckpointReaderImpl } from '../checkpoint/CheckpointReader';

export interface CompactionCoordinatorConfig {
  strategy: CompactionStrategy | CompactionStrategyType | { type: CompactionStrategyType; config: Record<string, any> };
  walPath: string;
  checkpointPath: string;
  schedulingInterval?: number; // How often to check if compaction is needed (ms)
  maxConcurrentCompactions?: number;
  enableAutoScheduling?: boolean;
}

/**
 * Coordinates compaction across the cluster and integrates with existing WAL + checkpoint systems
 */
export class CompactionCoordinator extends EventEmitter {
  private strategy: CompactionStrategy;
  private config: Required<CompactionCoordinatorConfig>;
  private schedulingTimer: NodeJS.Timeout | null = null;
  private runningCompactions = new Set<string>();
  private isStarted = false;

  constructor(config: CompactionCoordinatorConfig) {
    super();
    
    this.config = {
      schedulingInterval: 60000, // 1 minute
      maxConcurrentCompactions: 1,
      enableAutoScheduling: true,
      ...config
    } as Required<CompactionCoordinatorConfig>;

    // Initialize strategy
    if (typeof config.strategy === 'string') {
      this.strategy = CompactionStrategyFactory.create(config.strategy);
    } else if (typeof config.strategy === 'object' && 'type' in config.strategy) {
      this.strategy = CompactionStrategyFactory.createFromConfig(config.strategy);
    } else {
      this.strategy = config.strategy;
    }
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    this.isStarted = true;
    
    if (this.config.enableAutoScheduling) {
      this.startScheduling();
    }

    this.emit('coordinator:started', {
      strategy: this.strategy.constructor.name,
      config: this.config
    });
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    // Stop scheduling
    if (this.schedulingTimer) {
      clearInterval(this.schedulingTimer);
      this.schedulingTimer = null;
    }

    // Wait for running compactions to complete
    while (this.runningCompactions.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    this.isStarted = false;
    this.emit('coordinator:stopped');
  }

  /**
   * Manually trigger compaction check
   */
  async triggerCompactionCheck(): Promise<CompactionResult | null> {
    if (!this.isStarted) {
      throw new Error('CompactionCoordinator not started');
    }

    if (this.runningCompactions.size >= this.config.maxConcurrentCompactions) {
      return null; // Already at max concurrent compactions
    }

    // Load segments once; derive both metric objects from the cached data.
    const [segments, checkpointSnapshot] = await Promise.all([
      this.loadWALSegments(),
      new CheckpointReaderImpl({ checkpointPath: this.config.checkpointPath }).readLatest()
    ]);

    const walMetrics = this.deriveWALMetrics(segments);
    const checkpointMetrics = this.deriveCheckpointMetrics(checkpointSnapshot, segments);

    if (!this.strategy.shouldCompact(walMetrics, checkpointMetrics)) {
      return null; // No compaction needed
    }

    const plan = this.strategy.planCompaction(segments, checkpointMetrics);

    if (!plan) {
      return null; // No viable compaction plan
    }

    return await this.executeCompactionPlan(plan);
  }

  /**
   * Get current compaction status
   */
  getStatus(): {
    isStarted: boolean;
    strategy: string;
    runningCompactions: string[];
    strategyMetrics: any;
  } {
    return {
      isStarted: this.isStarted,
      strategy: this.strategy.constructor.name,
      runningCompactions: Array.from(this.runningCompactions),
      strategyMetrics: this.strategy.getMetrics()
    };
  }

  /**
   * Switch to a different compaction strategy
   */
  async switchStrategy(strategyType: CompactionStrategyType, config: Record<string, any> = {}): Promise<void> {
    // Wait for current compactions to finish
    while (this.runningCompactions.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const oldStrategy = this.strategy.constructor.name;
    this.strategy = CompactionStrategyFactory.create(strategyType, config);

    this.emit('strategy:changed', {
      oldStrategy,
      newStrategy: this.strategy.constructor.name,
      config
    });
  }

  private startScheduling(): void {
    this.schedulingTimer = setInterval(async () => {
      try {
        await this.triggerCompactionCheck();
      } catch (error) {
        this.emit('error', error);
      }
    }, this.config.schedulingInterval);
  }

  private async executeCompactionPlan(plan: CompactionPlan): Promise<CompactionResult> {
    this.runningCompactions.add(plan.planId);
    
    this.emit('compaction:started', {
      planId: plan.planId,
      strategy: this.strategy.constructor.name,
      inputSegments: plan.inputSegments.length,
      estimatedSpaceSaved: plan.estimatedSpaceSaved
    });

    try {
      // This is where the actual compaction work would be done
      // For now, we'll simulate it by calling the strategy's execute method
      const result = await this.performActualCompaction(plan);

      this.emit('compaction:completed', {
        planId: plan.planId,
        success: result.success,
        actualSpaceSaved: result.actualSpaceSaved,
        duration: result.actualDuration
      });

      return result;
    } catch (error) {
      this.emit('compaction:failed', {
        planId: plan.planId,
        error: error
      });
      throw error;
    } finally {
      this.runningCompactions.delete(plan.planId);
    }
  }

  private async performActualCompaction(plan: CompactionPlan): Promise<CompactionResult> {
    // Delegate the merge/deduplication logic to the strategy implementation.
    // The strategy reads from plan.inputSegments (metadata only at this layer)
    // and produces a CompactionResult with output segment descriptors.
    // Physical I/O (reading raw WAL entries and writing compacted segments) is
    // intentionally left to the strategy so each algorithm can optimise its
    // own I/O pattern (e.g. leveled merge, vacuum rebuild, time-based sweep).
    return await this.strategy.executeCompaction(plan);
  }

  private deriveWALMetrics(segments: WALSegment[]): WALMetrics {
    if (segments.length === 0) {
      return { segmentCount: 0, totalSizeBytes: 0, oldestSegmentAge: 0, tombstoneRatio: 0, duplicateEntryRatio: 0 };
    }
    const totalEntries = segments.reduce((s, seg) => s + seg.entryCount, 0);
    const totalTombstones = segments.reduce((s, seg) => s + seg.tombstoneCount, 0);
    const totalSizeBytes = segments.reduce((s, seg) => s + seg.sizeBytes, 0);
    const oldestCreatedAt = Math.min(...segments.map(seg => seg.createdAt));
    // Approximate duplicates: tombstones each imply one superseded live entry
    const duplicateEntries = totalTombstones;
    return {
      segmentCount: segments.length,
      totalSizeBytes,
      oldestSegmentAge: Date.now() - oldestCreatedAt,
      tombstoneRatio: totalEntries > 0 ? totalTombstones / totalEntries : 0,
      duplicateEntryRatio: totalEntries > 0 ? duplicateEntries / totalEntries : 0
    };
  }

  private deriveCheckpointMetrics(
    snapshot: { lsn: number; timestamp: number } | null,
    segments: WALSegment[]
  ): CheckpointMetrics {
    if (!snapshot) {
      return { lastCheckpointLSN: 0, lastCheckpointAge: Date.now(), segmentsSinceCheckpoint: 0 };
    }
    const segmentsSinceCheckpoint = segments.filter(seg => seg.endLSN > snapshot.lsn).length;
    return {
      lastCheckpointLSN: snapshot.lsn,
      lastCheckpointAge: Date.now() - snapshot.timestamp,
      segmentsSinceCheckpoint
    };
  }

  private async loadWALSegments(): Promise<WALSegment[]> {
    const walDir = this.config.walPath;

    let files: string[] = [];
    try {
      const entries = await fs.readdir(walDir);
      files = entries.filter(f => f.endsWith('.wal'));
    } catch {
      return [];
    }

    const results = await Promise.all(files.map(async (file): Promise<WALSegment | null> => {
      const filePath = path.join(walDir, file);
      try {
        const [stat, entries] = await Promise.all([
          fs.stat(filePath),
          (async () => {
            const reader = new WALReaderImpl(filePath);
            await reader.initialize();
            const data: WALEntry[] = await reader.readAll();
            await reader.close();
            return data;
          })()
        ]);

        if (entries.length === 0) return null;

        let startLSN = Infinity;
        let endLSN = -Infinity;
        let tombstoneCount = 0;
        for (const entry of entries) {
          const lsn = entry.logSequenceNumber;
          if (lsn < startLSN) startLSN = lsn;
          if (lsn > endLSN) endLSN = lsn;
          if (entry.data.operation === 'DELETE') tombstoneCount++;
        }

        return {
          segmentId: file.replace('.wal', ''),
          filePath,
          startLSN,
          endLSN,
          createdAt: stat.birthtimeMs || stat.mtimeMs,
          sizeBytes: stat.size,
          entryCount: entries.length,
          tombstoneCount,
          isImmutable: true
        };
      } catch {
        return null;
      }
    }));

    return (results.filter(Boolean) as WALSegment[]).sort((a, b) => a.startLSN - b.startLSN);
  }
}
