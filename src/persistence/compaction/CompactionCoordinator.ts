import { EventEmitter } from 'events';
import { CompactionStrategy, WALMetrics, CheckpointMetrics, WALSegment, CompactionPlan, CompactionResult, CompactionMetricsProvider } from './types';
import { CompactionStrategyFactory, CompactionStrategyType } from './CompactionStrategyFactory';

/**
 * Default stub metrics provider that returns hardcoded values.
 * Use this as a fallback when no real WAL/checkpoint system is wired in.
 */
export class StubMetricsProvider implements CompactionMetricsProvider {
  async getWALMetrics(): Promise<WALMetrics> {
    return {
      segmentCount: 5,
      totalSizeBytes: 500 * 1024 * 1024, // 500MB
      oldestSegmentAge: 48 * 60 * 60 * 1000, // 48 hours
      tombstoneRatio: 0.25, // 25%
      duplicateEntryRatio: 0.15 // 15%
    };
  }

  async getCheckpointMetrics(): Promise<CheckpointMetrics> {
    return {
      lastCheckpointLSN: 1000,
      lastCheckpointAge: 12 * 60 * 60 * 1000, // 12 hours
      segmentsSinceCheckpoint: 3
    };
  }

  async getWALSegments(): Promise<WALSegment[]> {
    return [
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
      },
      {
        segmentId: 'segment-002',
        filePath: '/data/wal/segment-002.wal',
        startLSN: 501,
        endLSN: 800,
        createdAt: Date.now() - 24 * 60 * 60 * 1000,
        sizeBytes: 75 * 1024 * 1024,
        entryCount: 3000,
        tombstoneCount: 600,
        isImmutable: true
      },
      {
        segmentId: 'segment-003',
        filePath: '/data/wal/segment-003.wal',
        startLSN: 801,
        endLSN: 1200,
        createdAt: Date.now() - 6 * 60 * 60 * 1000,
        sizeBytes: 120 * 1024 * 1024,
        entryCount: 4000,
        tombstoneCount: 400,
        isImmutable: true
      }
    ];
  }
}

export interface CompactionCoordinatorConfig {
  strategy: CompactionStrategyType | { type: CompactionStrategyType; config: Record<string, any> } | CompactionStrategy;
  walPath: string;
  checkpointPath: string;
  schedulingInterval?: number; // How often to check if compaction is needed (ms)
  maxConcurrentCompactions?: number;
  enableAutoScheduling?: boolean;
  metricsProvider?: CompactionMetricsProvider;
}

/**
 * Coordinates compaction across the cluster and integrates with existing WAL + checkpoint systems
 */
export class CompactionCoordinator extends EventEmitter {
  private strategy: ReturnType<typeof CompactionStrategyFactory.create>;
  private config: Required<CompactionCoordinatorConfig>;
  private metricsProvider: CompactionMetricsProvider;
  private schedulingTimer: NodeJS.Timeout | null = null;
  private runningCompactions = new Set<string>();
  private isStarted = false;

  constructor(config: CompactionCoordinatorConfig) {
    super();

    this.metricsProvider = config.metricsProvider ?? new StubMetricsProvider();

    this.config = {
      schedulingInterval: 60000, // 1 minute
      maxConcurrentCompactions: 1,
      enableAutoScheduling: true,
      metricsProvider: this.metricsProvider,
      ...config
    } as Required<CompactionCoordinatorConfig>;

    // Initialize strategy
    if (typeof config.strategy === 'string') {
      this.strategy = CompactionStrategyFactory.create(config.strategy as CompactionStrategyType);
    } else if (typeof config.strategy === 'object' && 'type' in config.strategy) {
      this.strategy = CompactionStrategyFactory.createFromConfig(config.strategy);
    } else {
      this.strategy = config.strategy as ReturnType<typeof CompactionStrategyFactory.create>;
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

  /**
   * Set or replace the metrics provider at runtime.
   */
  setMetricsProvider(provider: CompactionMetricsProvider): void {
    this.metricsProvider = provider;
  }

  private async gatherWALMetrics(): Promise<WALMetrics> {
    return this.metricsProvider.getWALMetrics();
  }

  private async gatherCheckpointMetrics(): Promise<CheckpointMetrics> {
    return this.metricsProvider.getCheckpointMetrics();
  }

  private async loadWALSegments(): Promise<WALSegment[]> {
    return this.metricsProvider.getWALSegments();
  }
}
