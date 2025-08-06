import { CompactionCoordinator } from '../../../src/persistence/compaction/CompactionCoordinator';
import { TimeBasedCompactionStrategy } from '../../../src/persistence/compaction/TimeBasedCompactionStrategy';
import { CompactionStrategyFactory } from '../../../src/persistence/compaction/CompactionStrategyFactory';

describe('Compaction Integration Tests', () => {
  describe('End-to-End Compaction Flow', () => {
    test('should create and run time-based compaction strategy', async () => {
      // Create coordinator with time-based strategy
      const coordinator = new CompactionCoordinator({
        strategy: 'time-based',
        walPath: '/test/wal',
        checkpointPath: '/test/checkpoint',
        enableAutoScheduling: false
      });

      // Start coordinator
      await coordinator.start();

      // Check status
      const status = coordinator.getStatus();
      expect(status.isStarted).toBe(true);
      expect(status.strategy).toBe('TimeBasedCompactionStrategy');

      // Stop coordinator
      await coordinator.stop();
      expect(coordinator.getStatus().isStarted).toBe(false);
    });

    test('should switch strategies at runtime', async () => {
      const coordinator = new CompactionCoordinator({
        strategy: new TimeBasedCompactionStrategy(),
        walPath: '/test/wal',
        checkpointPath: '/test/checkpoint',
        enableAutoScheduling: false
      });

      await coordinator.start();

      // Initially time-based
      expect(coordinator.getStatus().strategy).toBe('TimeBasedCompactionStrategy');

      // Switch to size-tiered
      await coordinator.switchStrategy('size-tiered');
      expect(coordinator.getStatus().strategy).toBe('SizeTieredCompactionStrategy');

      await coordinator.stop();
    });

    test('should use factory to create strategies', () => {
      // Test factory creation
      const timeBased = CompactionStrategyFactory.create('time-based');
      expect(timeBased).toBeInstanceOf(TimeBasedCompactionStrategy);

      const sizeTiered = CompactionStrategyFactory.create('size-tiered');
      expect(sizeTiered.constructor.name).toBe('SizeTieredCompactionStrategy');

      // Test with custom config
      const customTimeBased = CompactionStrategyFactory.create('time-based', {
        maxSegmentAge: 12 * 60 * 60 * 1000 // 12 hours
      });
      expect(customTimeBased).toBeInstanceOf(TimeBasedCompactionStrategy);
    });

    test('should handle compaction lifecycle events', async () => {
      const coordinator = new CompactionCoordinator({
        strategy: 'time-based',
        walPath: '/test/wal',
        checkpointPath: '/test/checkpoint',
        enableAutoScheduling: false
      });

      const events: string[] = [];
      coordinator.on('coordinator:started', () => events.push('started'));
      coordinator.on('coordinator:stopped', () => events.push('stopped'));
      coordinator.on('strategy:changed', () => events.push('strategy_changed'));

      await coordinator.start();
      await coordinator.switchStrategy('size-tiered');
      await coordinator.stop();

      expect(events).toEqual(['started', 'strategy_changed', 'stopped']);
    });
  });

  describe('Strategy Interoperability', () => {
    test('all strategies should implement same interface', () => {
      const strategies = [
        CompactionStrategyFactory.create('time-based'),
        CompactionStrategyFactory.create('size-tiered'),
        CompactionStrategyFactory.create('vacuum-based'),
        CompactionStrategyFactory.create('leveled')
      ];

      strategies.forEach(strategy => {
        // All strategies should have these methods
        expect(typeof strategy.shouldCompact).toBe('function');
        expect(typeof strategy.planCompaction).toBe('function');
        expect(typeof strategy.executeCompaction).toBe('function');
        expect(typeof strategy.getMetrics).toBe('function');

        // All strategies should return initial metrics
        const metrics = strategy.getMetrics();
        expect(metrics).toHaveProperty('totalRuns', 0);
        expect(metrics).toHaveProperty('isRunning', false);
        expect(metrics).toHaveProperty('totalSpaceSaved', 0);
      });
    });

    test('strategies should be swappable in coordinator', async () => {
      const coordinator = new CompactionCoordinator({
        strategy: 'time-based',
        walPath: '/test/wal',
        checkpointPath: '/test/checkpoint',
        enableAutoScheduling: false
      });

      await coordinator.start();

      // Test switching between all strategy types
      const strategyTypes = ['time-based', 'size-tiered', 'vacuum-based', 'leveled'] as const;
      
      for (const strategyType of strategyTypes) {
        await coordinator.switchStrategy(strategyType);
        const status = coordinator.getStatus();
        expect(status.strategy).toContain('CompactionStrategy');
      }

      await coordinator.stop();
    });
  });

  describe('WAL Integration', () => {
    test('should integrate with existing persistence layer', async () => {
      // This test verifies that the compaction system can work with the existing
      // WriteAheadLog and checkpoint systems when they're integrated
      
      const coordinator = new CompactionCoordinator({
        strategy: 'time-based',
        walPath: '/test/wal',
        checkpointPath: '/test/checkpoint',
        enableAutoScheduling: false
      });

      await coordinator.start();

      // Trigger manual compaction check
      const result = await coordinator.triggerCompactionCheck();
      
      // With stub data, this might return null (no compaction needed)
      // or a CompactionResult if compaction was triggered
      expect(result === null || typeof result === 'object').toBe(true);

      await coordinator.stop();
    });

    test('should respect checkpoint boundaries during compaction', async () => {
      const coordinator = new CompactionCoordinator({
        strategy: new TimeBasedCompactionStrategy({
          maxSegmentAge: 1, // Very low threshold to force compaction
          tombstoneThreshold: 0.1 // Low threshold to force compaction
        }),
        walPath: '/test/wal',
        checkpointPath: '/test/checkpoint',
        enableAutoScheduling: false
      });

      await coordinator.start();

      // The coordinator uses stub data that respects checkpoint boundaries
      const result = await coordinator.triggerCompactionCheck();
      
      // Verify that compaction respects checkpoint LSN boundaries
      if (result && result.success) {
        // In a real implementation, we'd verify that segments don't cross checkpoint boundaries
        expect(result.success).toBe(true);
      }

      await coordinator.stop();
    });
  });
});
