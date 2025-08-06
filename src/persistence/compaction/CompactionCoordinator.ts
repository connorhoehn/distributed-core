import { EventEmitter } from 'events';
import { CompactionStrategy, WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan, CompactionResult } from './types';
import { CompactionStrategyFactory, CompactionStrategyType } from './CompactionStrategyFactory';

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

    const walMetrics = await this.gatherWALMetrics();
    const checkpointMetrics = await this.gatherCheckpointMetrics();

    if (!this.strategy.shouldCompact(walMetrics, checkpointMetrics)) {
      return null; // No compaction needed
    }

    const segments = await this.loadWALSegments();
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
    // STUB: This is where integration with existing WAL system would happen
    // For now, delegate to the strategy's execute method
    
    // TODO: Implement actual compaction logic that:
    // 1. Reads entries from input segments
    // 2. Applies deduplication and tombstone removal
    // 3. Writes compacted entries to new segments
    // 4. Atomically swaps old segments for new ones
    // 5. Updates segment metadata and indexes
    
    return await this.strategy.executeCompaction(plan);
  }

  // STUB: Integration points with existing WAL + checkpoint systems
  private async gatherWALMetrics(): Promise<WALMetrics> {
    // TODO: Integrate with existing WriteAheadLog system
    // This would collect metrics about current WAL state
    
    return {
      segmentCount: 5, // STUB
      totalSizeBytes: 500 * 1024 * 1024, // STUB: 500MB
      oldestSegmentAge: 48 * 60 * 60 * 1000, // STUB: 48 hours
      tombstoneRatio: 0.25, // STUB: 25%
      duplicateEntryRatio: 0.15 // STUB: 15%
    };
  }

  private async gatherCheckpointMetrics(): Promise<CheckpointMetrics> {
    // TODO: Integrate with existing checkpoint system
    // This would collect metrics about checkpoint state
    
    return {
      lastCheckpointLSN: 1000, // STUB
      lastCheckpointAge: 12 * 60 * 60 * 1000, // STUB: 12 hours
      segmentsSinceCheckpoint: 3 // STUB
    };
  }

  private async loadWALSegments(): Promise<WALSegment[]> {
    // TODO: Load actual WAL segment metadata
    // This would enumerate all WAL segments and their properties
    
    // STUB: Return mock segments
    return [
      {
        segmentId: 'segment-001',
        filePath: '/data/wal/segment-001.wal',
        startLSN: 1,
        endLSN: 500,
        createdAt: Date.now() - 48 * 60 * 60 * 1000, // 48 hours ago
        sizeBytes: 100 * 1024 * 1024, // 100MB
        entryCount: 5000,
        tombstoneCount: 1250, // 25%
        isImmutable: true
      },
      {
        segmentId: 'segment-002',
        filePath: '/data/wal/segment-002.wal',
        startLSN: 501,
        endLSN: 800,
        createdAt: Date.now() - 24 * 60 * 60 * 1000, // 24 hours ago
        sizeBytes: 75 * 1024 * 1024, // 75MB
        entryCount: 3000,
        tombstoneCount: 600, // 20%
        isImmutable: true
      },
      {
        segmentId: 'segment-003',
        filePath: '/data/wal/segment-003.wal',
        startLSN: 801,
        endLSN: 1200,
        createdAt: Date.now() - 6 * 60 * 60 * 1000, // 6 hours ago
        sizeBytes: 120 * 1024 * 1024, // 120MB
        entryCount: 4000,
        tombstoneCount: 400, // 10%
        isImmutable: true
      }
    ];
  }
}
