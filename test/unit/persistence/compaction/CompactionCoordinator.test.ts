import { CompactionCoordinator, CompactionCoordinatorConfig } from '../../../../src/persistence/compaction/CompactionCoordinator';
import { TimeBasedCompactionStrategy } from '../../../../src/persistence/compaction/TimeBasedCompactionStrategy';
import { WALMetrics, CheckpointMetrics } from '../../../../src/persistence/compaction/types';

describe('CompactionCoordinator', () => {
  let coordinator: CompactionCoordinator;
  let mockConfig: CompactionCoordinatorConfig;

  beforeEach(() => {
    mockConfig = {
      strategy: new TimeBasedCompactionStrategy(),
      walPath: '/test/wal',
      checkpointPath: '/test/checkpoint',
      schedulingInterval: 5000, // 5 seconds for testing
      maxConcurrentCompactions: 1,
      enableAutoScheduling: false // Disable for tests
    };
    
    coordinator = new CompactionCoordinator(mockConfig);
  });

  afterEach(async () => {
    if (coordinator.getStatus().isStarted) {
      await coordinator.stop();
    }
  });

  describe('constructor', () => {
    test('should initialize with strategy instance', () => {
      const config = { ...mockConfig, strategy: new TimeBasedCompactionStrategy() };
      const coord = new CompactionCoordinator(config);
      expect(coord).toBeInstanceOf(CompactionCoordinator);
    });

    test('should initialize with strategy type string', () => {
      const config = { ...mockConfig, strategy: 'time-based' as const };
      const coord = new CompactionCoordinator(config);
      expect(coord).toBeInstanceOf(CompactionCoordinator);
    });

    test('should initialize with strategy config object', () => {
      const config = {
        ...mockConfig,
        strategy: {
          type: 'time-based' as const,
          config: { maxSegmentAge: 12 * 60 * 60 * 1000 }
        }
      };
      const coord = new CompactionCoordinator(config);
      expect(coord).toBeInstanceOf(CompactionCoordinator);
    });
  });

  describe('lifecycle', () => {
    test('should start successfully', async () => {
      await coordinator.start();
      
      const status = coordinator.getStatus();
      expect(status.isStarted).toBe(true);
      expect(status.strategy).toBe('TimeBasedCompactionStrategy');
    });

    test('should stop successfully', async () => {
      await coordinator.start();
      await coordinator.stop();
      
      const status = coordinator.getStatus();
      expect(status.isStarted).toBe(false);
    });

    test('should not start twice', async () => {
      await coordinator.start();
      await coordinator.start(); // Should not throw
      
      const status = coordinator.getStatus();
      expect(status.isStarted).toBe(true);
    });

    test('should emit coordinator events', async () => {
      const startedEvents: any[] = [];
      const stoppedEvents: any[] = [];
      
      coordinator.on('coordinator:started', (event) => startedEvents.push(event));
      coordinator.on('coordinator:stopped', (event) => stoppedEvents.push(event));
      
      await coordinator.start();
      await coordinator.stop();
      
      expect(startedEvents).toHaveLength(1);
      expect(stoppedEvents).toHaveLength(1);
      expect(startedEvents[0]).toHaveProperty('strategy', 'TimeBasedCompactionStrategy');
    });
  });

  describe('triggerCompactionCheck', () => {
    beforeEach(async () => {
      await coordinator.start();
    });

    test('should return null when not started', async () => {
      await coordinator.stop();
      
      await expect(coordinator.triggerCompactionCheck()).rejects.toThrow('not started');
    });

    test('should handle case when no compaction needed', async () => {
      // Mock the strategy to return false for shouldCompact
      jest.spyOn(coordinator['strategy'], 'shouldCompact').mockReturnValue(false);
      
      const result = await coordinator.triggerCompactionCheck();
      expect(result).toBeNull();
    });

    test('should handle case when no compaction plan available', async () => {
      // Mock the strategy to return true for shouldCompact but null plan
      jest.spyOn(coordinator['strategy'], 'shouldCompact').mockReturnValue(true);
      jest.spyOn(coordinator['strategy'], 'planCompaction').mockReturnValue(null);
      
      const result = await coordinator.triggerCompactionCheck();
      expect(result).toBeNull();
    });

    test('should execute compaction when plan is available', async () => {
      // Mock strategy methods
      jest.spyOn(coordinator['strategy'], 'shouldCompact').mockReturnValue(true);
      jest.spyOn(coordinator['strategy'], 'planCompaction').mockReturnValue({
        planId: 'test-plan',
        inputSegments: [],
        outputSegments: [],
        estimatedSpaceSaved: 1000,
        estimatedDuration: 5000,
        priority: 'medium'
      });
      jest.spyOn(coordinator['strategy'], 'executeCompaction').mockResolvedValue({
        planId: 'test-plan',
        success: true,
        actualSpaceSaved: 1000,
        actualDuration: 4000,
        segmentsCreated: [],
        segmentsDeleted: [],
        metrics: {
          entriesProcessed: 100,
          entriesCompacted: 80,
          tombstonesRemoved: 20,
          duplicatesRemoved: 10
        }
      });
      
      const result = await coordinator.triggerCompactionCheck();
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.planId).toBe('test-plan');
    });
  });

  describe('getStatus', () => {
    test('should return correct status when stopped', () => {
      const status = coordinator.getStatus();
      
      expect(status.isStarted).toBe(false);
      expect(status.strategy).toBe('TimeBasedCompactionStrategy');
      expect(status.runningCompactions).toHaveLength(0);
      expect(status.strategyMetrics).toBeDefined();
    });

    test('should return correct status when started', async () => {
      await coordinator.start();
      const status = coordinator.getStatus();
      
      expect(status.isStarted).toBe(true);
      expect(status.strategy).toBe('TimeBasedCompactionStrategy');
    });
  });

  describe('switchStrategy', () => {
    beforeEach(async () => {
      await coordinator.start();
    });

    test('should switch to different strategy', async () => {
      const initialStatus = coordinator.getStatus();
      expect(initialStatus.strategy).toBe('TimeBasedCompactionStrategy');
      
      await coordinator.switchStrategy('size-tiered');
      
      const newStatus = coordinator.getStatus();
      expect(newStatus.strategy).toBe('SizeTieredCompactionStrategy');
    });

    test('should emit strategy change event', async () => {
      const changeEvents: any[] = [];
      coordinator.on('strategy:changed', (event) => changeEvents.push(event));
      
      await coordinator.switchStrategy('size-tiered', { bucketSize: 6 });
      
      expect(changeEvents).toHaveLength(1);
      expect(changeEvents[0]).toHaveProperty('oldStrategy', 'TimeBasedCompactionStrategy');
      expect(changeEvents[0]).toHaveProperty('newStrategy', 'SizeTieredCompactionStrategy');
      expect(changeEvents[0]).toHaveProperty('config', { bucketSize: 6 });
    });
  });

  describe('compaction events', () => {
    beforeEach(async () => {
      await coordinator.start();
    });

    test('should emit compaction events during execution', async () => {
      const startedEvents: any[] = [];
      const completedEvents: any[] = [];
      
      coordinator.on('compaction:started', (event) => startedEvents.push(event));
      coordinator.on('compaction:completed', (event) => completedEvents.push(event));
      
      // Mock strategy for successful compaction
      jest.spyOn(coordinator['strategy'], 'shouldCompact').mockReturnValue(true);
      jest.spyOn(coordinator['strategy'], 'planCompaction').mockReturnValue({
        planId: 'event-test-plan',
        inputSegments: [],
        outputSegments: [],
        estimatedSpaceSaved: 2000,
        estimatedDuration: 3000,
        priority: 'high'
      });
      jest.spyOn(coordinator['strategy'], 'executeCompaction').mockResolvedValue({
        planId: 'event-test-plan',
        success: true,
        actualSpaceSaved: 1800,
        actualDuration: 2800,
        segmentsCreated: [],
        segmentsDeleted: [],
        metrics: {
          entriesProcessed: 200,
          entriesCompacted: 180,
          tombstonesRemoved: 20,
          duplicatesRemoved: 5
        }
      });
      
      await coordinator.triggerCompactionCheck();
      
      expect(startedEvents).toHaveLength(1);
      expect(completedEvents).toHaveLength(1);
      
      expect(startedEvents[0]).toHaveProperty('planId', 'event-test-plan');
      expect(startedEvents[0]).toHaveProperty('strategy', 'TimeBasedCompactionStrategy');
      expect(completedEvents[0]).toHaveProperty('planId', 'event-test-plan');
      expect(completedEvents[0]).toHaveProperty('success', true);
    });
  });
});
