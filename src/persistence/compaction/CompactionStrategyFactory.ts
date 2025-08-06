import { CompactionStrategy } from './types';
import { TimeBasedCompactionStrategy } from './TimeBasedCompactionStrategy';
import { SizeTieredCompactionStrategy } from './SizeTieredCompactionStrategy';
import { VacuumBasedCompactionStrategy } from './VacuumBasedCompactionStrategy';
import { LeveledCompactionStrategy } from './LeveledCompactionStrategy';

export type CompactionStrategyType = 'time-based' | 'size-tiered' | 'vacuum-based' | 'leveled';

export interface CompactionStrategyConfig {
  type: CompactionStrategyType;
  config?: Record<string, any>;
}

/**
 * Factory for creating compaction strategies
 */
export class CompactionStrategyFactory {
  /**
   * Create a compaction strategy instance
   */
  static create(strategyType: CompactionStrategyType, config: Record<string, any> = {}): CompactionStrategy {
    switch (strategyType) {
      case 'time-based':
        return new TimeBasedCompactionStrategy(config);
      
      case 'size-tiered':
        return new SizeTieredCompactionStrategy(config);
      
      case 'vacuum-based':
        return new VacuumBasedCompactionStrategy(config);
      
      case 'leveled':
        return new LeveledCompactionStrategy(config);
      
      default:
        throw new Error(`Unknown compaction strategy type: ${strategyType}`);
    }
  }

  /**
   * Get available strategy types
   */
  static getAvailableStrategies(): CompactionStrategyType[] {
    return ['time-based', 'size-tiered', 'vacuum-based', 'leveled'];
  }

  /**
   * Get default configuration for a strategy type
   */
  static getDefaultConfig(strategyType: CompactionStrategyType): Record<string, any> {
    switch (strategyType) {
      case 'time-based':
        return {
          maxSegmentAge: 24 * 60 * 60 * 1000, // 24 hours
          maxSegmentSize: 100 * 1024 * 1024,   // 100MB
          tombstoneThreshold: 0.3,              // 30%
          checkpointLagThreshold: 2             // 2 checkpoints
        };
      
      case 'size-tiered':
        return {
          sizeTiers: [1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024], // 1MB, 10MB, 100MB
          maxSegmentsPerTier: 4,
          minSegmentSize: 1024 * 1024 // 1MB
        };
      
      case 'vacuum-based':
        return {
          deadTupleThreshold: 0.2,      // 20%
          fragmentationThreshold: 0.3,  // 30%
          vacuumIntervalMs: 60 * 60 * 1000 // 1 hour
        };
      
      case 'leveled':
        return {
          maxLevels: 7,
          levelSizeMultiplier: 10,
          level0SegmentLimit: 4,
          baseLevelSize: 10 * 1024 * 1024 // 10MB
        };
      
      default:
        return {};
    }
  }

  /**
   * Create strategy from configuration object
   */
  static createFromConfig(strategyConfig: CompactionStrategyConfig): CompactionStrategy {
    const defaultConfig = CompactionStrategyFactory.getDefaultConfig(strategyConfig.type);
    const mergedConfig = { ...defaultConfig, ...strategyConfig.config };
    return CompactionStrategyFactory.create(strategyConfig.type, mergedConfig);
  }

  /**
   * Get strategy recommendations based on workload characteristics
   */
  static recommendStrategy(workloadProfile: {
    writeHeavy?: boolean;
    readHeavy?: boolean;
    mixedWorkload?: boolean;
    lowLatencyReads?: boolean;
    highThroughputWrites?: boolean;
    storageEfficiencyPriority?: boolean;
  }): CompactionStrategyType {
    
    if (workloadProfile.writeHeavy && workloadProfile.highThroughputWrites) {
      return 'size-tiered'; // Optimized for write throughput
    }
    
    if (workloadProfile.readHeavy && workloadProfile.lowLatencyReads) {
      return 'vacuum-based'; // Optimized for read performance
    }
    
    if (workloadProfile.mixedWorkload) {
      return 'leveled'; // Balanced read/write performance
    }
    
    if (workloadProfile.storageEfficiencyPriority) {
      return 'time-based'; // Good space reclamation with age-based cleanup
    }
    
    // Default recommendation
    return 'time-based';
  }
}
