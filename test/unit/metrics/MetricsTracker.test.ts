import { MetricsTracker, UnifiedMetrics, Alert, MetricsTrackerConfig } from '../../../src/metrics/MetricsTracker';
import { EventEmitter } from 'eventemitter3';

// Mock classes for testing
class MockDiagnosticTool {
  async collectPerformanceMetrics() {
    return {
      cpu: { percentage: 45.5, loadAverage: [1.2, 1.3, 1.1] },
      memory: { used: 4096, total: 8192, percentage: 50 },
      disk: { used: 100000, available: 150000, total: 250000, percentage: 40 }
    };
  }
}

class MockClusterIntrospection {
  async getPerformanceMetrics() {
    return {
      membershipSize: 5,
      gossipRate: 100,
      failureDetectionLatency: 200,
      averageHeartbeatInterval: 1000,
      messageRate: 50,
      messageLatency: 150,
      networkThroughput: 1000000
    };
  }
}

class MockFailureDetector {
  getAllNodeHealth() {
    return [
      { nodeId: 'node1', isResponsive: true, roundTripTime: 50, lastSeen: Date.now() },
      { nodeId: 'node2', isResponsive: true, roundTripTime: 75, lastSeen: Date.now() },
      { nodeId: 'node3', isResponsive: false, roundTripTime: 500, lastSeen: Date.now() - 30000 }
    ];
  }
}

class MockConnectionPool {
  getStats() {
    return {
      totalAcquired: 100,
      totalReleased: 90,
      totalCreated: 20,
      totalDestroyed: 5,
      activeConnections: 15,
      acquireTimes: [10, 15, 20, 12, 18]
    };
  }
}

describe('MetricsTracker', () => {
  let tracker: MetricsTracker;
  let mockDiagnosticTool: MockDiagnosticTool;
  let mockClusterIntrospection: MockClusterIntrospection;
  let mockFailureDetector: MockFailureDetector;
  let mockConnectionPool: MockConnectionPool;

  beforeEach(() => {
    tracker = new MetricsTracker({
      collectionInterval: 1000,
      retentionPeriod: 60000,
      enableTrends: true,
      enableAlerts: true,
      thresholds: {
        cpu: 80,
        memory: 85,
        disk: 90,
        networkLatency: 500,
        clusterStability: 0.8
      }
    });

    mockDiagnosticTool = new MockDiagnosticTool();
    mockClusterIntrospection = new MockClusterIntrospection();
    mockFailureDetector = new MockFailureDetector();
    mockConnectionPool = new MockConnectionPool();

    tracker.registerDiagnosticTool(mockDiagnosticTool);
    tracker.registerClusterIntrospection(mockClusterIntrospection);
    tracker.registerFailureDetector(mockFailureDetector);
    tracker.registerConnectionPool(mockConnectionPool);
  });

  afterEach(() => {
    tracker.stopCollection();
    tracker.removeAllListeners();
  });

  describe('Configuration', () => {
    test('should initialize with default configuration', () => {
      const defaultTracker = new MetricsTracker();
      const config = defaultTracker.getConfig();
      
      expect(config.collectionInterval).toBe(30000);
      expect(config.retentionPeriod).toBe(3600000);
      expect(config.enableTrends).toBe(true);
      expect(config.enableAlerts).toBe(true);
      expect(config.thresholds.cpu).toBe(85);
    });

    test('should accept custom configuration', () => {
      const customConfig: Partial<MetricsTrackerConfig> = {
        collectionInterval: 5000,
        retentionPeriod: 120000,
        thresholds: { cpu: 70, memory: 80, disk: 85, networkLatency: 300, clusterStability: 0.9 }
      };

      const customTracker = new MetricsTracker(customConfig);
      const config = customTracker.getConfig();
      
      expect(config.collectionInterval).toBe(5000);
      expect(config.retentionPeriod).toBe(120000);
      expect(config.thresholds.cpu).toBe(70);
    });

    it('should update configuration dynamically', () => {
      const newConfig = { collectionInterval: 2000, thresholds: { cpu: 90, memory: 95, disk: 98, networkLatency: 800, clusterStability: 0.7 } };
      
      let configUpdated = false;
      tracker.on('config-updated', () => { configUpdated = true; });
      
      tracker.updateConfig(newConfig);
      
      const config = tracker.getConfig();
      expect(config.collectionInterval).toBe(2000);
      expect(config.thresholds.cpu).toBe(90);
      expect(configUpdated).toBe(true);
    });
  });

  describe('Metric Source Registration', () => {
    it('should register all metric sources', () => {
      const newTracker = new MetricsTracker();
      
      newTracker.registerDiagnosticTool(mockDiagnosticTool);
      newTracker.registerClusterIntrospection(mockClusterIntrospection);
      newTracker.registerFailureDetector(mockFailureDetector);
      newTracker.registerConnectionPool(mockConnectionPool);
      
      expect(newTracker['diagnosticTool']).toBe(mockDiagnosticTool);
      expect(newTracker['clusterIntrospection']).toBe(mockClusterIntrospection);
      expect(newTracker['failureDetector']).toBe(mockFailureDetector);
      expect(newTracker['connectionPools']).toContain(mockConnectionPool);
    });

    it('should handle multiple connection pools', () => {
      const pool2 = new MockConnectionPool();
      const pool3 = new MockConnectionPool();
      
      tracker.registerConnectionPool(pool2);
      tracker.registerConnectionPool(pool3);
      
      expect(tracker['connectionPools']).toHaveLength(3); // Including initial one
    });
  });

  describe('Metrics Collection', () => {
    it('should collect unified metrics from all sources', async () => {
      const metrics = await tracker.collectMetrics();
      
      expect(metrics).toMatchObject({
        timestamp: expect.any(Number),
        system: {
          cpu: { percentage: 45.5 },
          memory: { percentage: 50 },
          disk: { percentage: 40 }
        },
        cluster: {
          membershipSize: 5,
          gossipRate: 100,
          messageLatency: 150,
          clusterStability: 'stable'
        },
        network: {
          latency: expect.any(Number),
          status: expect.any(String),
          activeConnections: expect.any(Number),
          failedConnections: expect.any(Number)
        },
        connections: {
          totalAcquired: 100,
          activeConnections: 15,
          poolUtilization: expect.any(Number)
        },
        health: {
          overallHealth: expect.stringMatching(/healthy|degraded|critical/),
          performanceTrends: {
            cpu: expect.stringMatching(/improving|stable|degrading/),
            memory: expect.stringMatching(/improving|stable|degrading/),
            network: expect.stringMatching(/improving|stable|degrading/)
          }
        }
      });
    });

    test('should emit metrics-collected event', async () => {
      let collectedMetrics: UnifiedMetrics | null = null;
      tracker.on('metrics-collected', (metrics: UnifiedMetrics) => {
        collectedMetrics = metrics;
      });
      
      await tracker.collectMetrics();
      
      expect(collectedMetrics).not.toBeNull();
      expect(collectedMetrics!.timestamp).toBeGreaterThan(0);
    });

    it('should store metrics in history', async () => {
      await tracker.collectMetrics();
      
      // Wait a small amount to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      
      await tracker.collectMetrics();
      
      const history = tracker.getMetricsHistory();
      expect(history).toHaveLength(2);
      expect(history[0].timestamp).toBeLessThan(history[1].timestamp);
    });

    it('should limit history based on retention period', async () => {
      // Create tracker with very short retention
      const shortTracker = new MetricsTracker({ retentionPeriod: 100 });
      shortTracker.registerDiagnosticTool(mockDiagnosticTool);
      
      await shortTracker.collectMetrics();
      await new Promise(resolve => setTimeout(resolve, 150)); // Wait longer than retention
      await shortTracker.collectMetrics();
      
      const history = shortTracker.getMetricsHistory();
      expect(history).toHaveLength(1); // Only recent one should remain
    });

    it('should handle missing metric sources gracefully', async () => {
      const isolatedTracker = new MetricsTracker();
      const metrics = await isolatedTracker.collectMetrics();
      
      expect(metrics.system.cpu.percentage).toBeGreaterThanOrEqual(0);
      expect(metrics.cluster.membershipSize).toBe(0);
      expect(metrics.network.activeConnections).toBe(0);
    });
  });

  describe('System Metrics Collection', () => {
    it('should collect system metrics from diagnostic tool', async () => {
      const metrics = await tracker.collectMetrics();
      
      expect(metrics.system).toEqual({
        cpu: { percentage: 45.5, loadAverage: [1.2, 1.3, 1.1] },
        memory: { used: 4096, total: 8192, percentage: 50 },
        disk: { used: 100000, available: 150000, total: 250000, percentage: 40 }
      });
    });

    it('should handle diagnostic tool errors', async () => {
      const errorTool = {
        async collectPerformanceMetrics() {
          throw new Error('Diagnostic tool failed');
        }
      };
      
      tracker.registerDiagnosticTool(errorTool);
      
      let errorEmitted = false;
      tracker.on('error', () => { errorEmitted = true; });
      
      const metrics = await tracker.collectMetrics();
      
      expect(errorEmitted).toBe(true);
      expect(metrics.system.cpu.percentage).toBeGreaterThanOrEqual(0); // Fallback
    });
  });

  describe('Cluster Metrics Collection', () => {
    it('should collect cluster metrics and calculate stability', async () => {
      const metrics = await tracker.collectMetrics();
      
      expect(metrics.cluster.membershipSize).toBe(5);
      expect(metrics.cluster.gossipRate).toBe(100);
      expect(metrics.cluster.messageLatency).toBe(150);
      expect(metrics.cluster.clusterStability).toBe('stable');
    });

    it('should determine unstable cluster correctly', async () => {
      const unstableIntrospection = {
        async getPerformanceMetrics() {
          return {
            membershipSize: 3,
            gossipRate: 0, // No gossip
            failureDetectionLatency: 10000, // Very high
            messageLatency: 5000, // Very high
            networkThroughput: 0
          };
        }
      };
      
      tracker.registerClusterIntrospection(unstableIntrospection);
      const metrics = await tracker.collectMetrics();
      
      expect(metrics.cluster.clusterStability).toBe('unstable');
    });
  });

  describe('Network Metrics Collection', () => {
    it('should calculate network metrics from failure detector', async () => {
      const metrics = await tracker.collectMetrics();
      
      expect(metrics.network.activeConnections).toBe(2); // 2 responsive nodes
      expect(metrics.network.failedConnections).toBe(1); // 1 unresponsive node
      expect(metrics.network.latency).toBeCloseTo(208.33); // Average of 50, 75, and 500
      expect(metrics.network.roundTripTimes.size).toBe(3);
      expect(metrics.network.status).toBe('degraded'); // Has failed connections
    });

    it('should handle empty failure detector', async () => {
      const emptyDetector = { getAllNodeHealth: () => [] };
      tracker.registerFailureDetector(emptyDetector);
      
      const metrics = await tracker.collectMetrics();
      
      expect(metrics.network.activeConnections).toBe(0);
      expect(metrics.network.failedConnections).toBe(0);
      expect(metrics.network.latency).toBe(0);
      expect(metrics.network.status).toBe('connected');
    });
  });

  describe('Connection Metrics Collection', () => {
    it('should aggregate connection pool metrics', async () => {
      const metrics = await tracker.collectMetrics();
      
      expect(metrics.connections.totalAcquired).toBe(100);
      expect(metrics.connections.activeConnections).toBe(15);
      expect(metrics.connections.poolUtilization).toBe(0.75); // 15/20
      expect(metrics.connections.averageAcquireTime).toBe(15); // Average of [10,15,20,12,18]
      expect(metrics.connections.connectionHealth).toBe('degraded'); // 75% utilization
    });

    it('should handle multiple connection pools', async () => {
      const pool2 = {
        getStats: () => ({
          totalAcquired: 50,
          totalReleased: 45,
          totalCreated: 10,
          totalDestroyed: 2,
          activeConnections: 8,
          acquireTimes: [5, 8, 12]
        })
      };
      
      tracker.registerConnectionPool(pool2);
      const metrics = await tracker.collectMetrics();
      
      expect(metrics.connections.totalAcquired).toBe(150); // 100 + 50
      expect(metrics.connections.activeConnections).toBe(23); // 15 + 8
    });

    it('should determine connection health levels', async () => {
      // Test critical health (>90% utilization)
      const criticalPool = {
        getStats: () => ({
          totalCreated: 10,
          activeConnections: 10, // 100% utilization
          totalAcquired: 0, totalReleased: 0, totalDestroyed: 0,
          acquireTimes: []
        })
      };
      
      const criticalTracker = new MetricsTracker();
      criticalTracker.registerConnectionPool(criticalPool);
      
      const metrics = await criticalTracker.collectMetrics();
      expect(metrics.connections.connectionHealth).toBe('critical');
    });
  });

  describe('Health Metrics and Overall Health', () => {
    it('should calculate overall health based on node health', async () => {
      const metrics = await tracker.collectMetrics();
      
      expect(metrics.health.overallHealth).toBe('degraded'); // 2/3 nodes healthy (66%)
      expect(metrics.health.nodeHealth.size).toBe(3);
      expect(metrics.health.performanceTrends).toEqual({
        cpu: 'stable',
        memory: 'stable', 
        network: 'stable'
      });
    });

    it('should determine critical health with many failed nodes', async () => {
      const unhealthyDetector = {
        getAllNodeHealth: () => [
          { nodeId: 'node1', isResponsive: false, roundTripTime: 1000 },
          { nodeId: 'node2', isResponsive: false, roundTripTime: 1000 },
          { nodeId: 'node3', isResponsive: true, roundTripTime: 100 }
        ]
      };
      
      tracker.registerFailureDetector(unhealthyDetector);
      const metrics = await tracker.collectMetrics();
      
      expect(metrics.health.overallHealth).toBe('critical'); // 1/3 nodes healthy (33%)
    });

    it('should calculate performance trends correctly', async () => {
      // Collect initial metrics
      await tracker.collectMetrics();
      
      // Mock degrading performance
      const degradingTool = {
        async collectPerformanceMetrics() {
          return {
            cpu: { percentage: 90 }, // Higher CPU
            memory: { used: 7000, total: 8192, percentage: 85 }, // Higher memory
            disk: { used: 100000, available: 150000, total: 250000, percentage: 40 }
          };
        }
      };
      
      tracker.registerDiagnosticTool(degradingTool);
      
      // Collect several more metrics to establish trend
      for (let i = 0; i < 4; i++) {
        await tracker.collectMetrics();
      }
      
      const metrics = await tracker.collectMetrics();
      expect(metrics.health.performanceTrends.cpu).toBe('degrading');
    });
  });

  describe('Alert System', () => {
    it('should generate alerts for threshold violations', async () => {
      const highUsageTool = {
        async collectPerformanceMetrics() {
          return {
            cpu: { percentage: 95 }, // Above 80% threshold
            memory: { used: 7500, total: 8192, percentage: 92 }, // Above 85% threshold
            disk: { used: 230000, available: 20000, total: 250000, percentage: 92 } // Above 90% threshold
          };
        }
      };
      
      tracker.registerDiagnosticTool(highUsageTool);
      
      const alerts: Alert[] = [];
      tracker.on('alert', (alert) => alerts.push(alert));
      
      await tracker.collectMetrics();
      
      expect(alerts).toHaveLength(3);
      expect(alerts.find(a => a.message.includes('CPU'))).toBeDefined();
      expect(alerts.find(a => a.message.includes('Memory'))).toBeDefined();
      expect(alerts.find(a => a.message.includes('Disk'))).toBeDefined();
    });

    it('should generate network latency alerts', async () => {
      const slowNetwork = {
        getAllNodeHealth: () => [
          { nodeId: 'node1', isResponsive: true, roundTripTime: 1500 } // Above 500ms threshold
        ]
      };
      
      tracker.registerFailureDetector(slowNetwork);
      
      const alerts: Alert[] = [];
      tracker.on('alert', (alert) => alerts.push(alert));
      
      await tracker.collectMetrics();
      
      const networkAlert = alerts.find(a => a.message.includes('latency'));
      expect(networkAlert).toBeDefined();
      expect(networkAlert?.severity).toBe('warning');
    });

    it('should call custom alert handlers', async () => {
      const alertHandler = jest.fn();
      const trackerWithHandler = new MetricsTracker({
        thresholds: { cpu: 20, memory: 85, disk: 90, networkLatency: 500, clusterStability: 0.8 }, // Low CPU threshold
        alertHandlers: [alertHandler]
      });
      
      trackerWithHandler.registerDiagnosticTool(mockDiagnosticTool);
      await trackerWithHandler.collectMetrics();
      
      expect(alertHandler).toHaveBeenCalled();
      expect(alertHandler.mock.calls[0][0]).toMatchObject({
        severity: 'warning',
        message: expect.stringContaining('CPU'),
        source: 'system'
      });
    });

    it('should limit stored alerts to 100', async () => {
      // Generate many alerts
      for (let i = 0; i < 150; i++) {
        tracker['alerts'].push({
          id: `test-${i}`,
          severity: 'info',
          message: 'Test alert',
          timestamp: Date.now(),
          source: 'test'
        });
      }
      
      await tracker.collectMetrics(); // Triggers cleanup
      
      const alerts = tracker.getRecentAlerts();
      expect(alerts.length).toBeLessThanOrEqual(100);
    });
  });

  describe('Collection Lifecycle', () => {
    it('should start and stop continuous collection', async () => {
      let collectionStarted = false;
      let collectionStopped = false;
      
      tracker.on('collection-started', () => { collectionStarted = true; });
      tracker.on('collection-stopped', () => { collectionStopped = true; });
      
      await tracker.startCollection();
      expect(collectionStarted).toBe(true);
      expect(tracker['isCollecting']).toBe(true);
      
      tracker.stopCollection();
      expect(collectionStopped).toBe(true);
      expect(tracker['isCollecting']).toBe(false);
    });

    it('should prevent multiple collection starts', async () => {
      await tracker.startCollection();
      const firstTimer = tracker['collectionTimer'];
      
      await tracker.startCollection(); // Second start
      const secondTimer = tracker['collectionTimer'];
      
      expect(firstTimer).toBe(secondTimer); // Should be same timer
    });

    it('should collect metrics automatically on interval', async () => {
      const quickTracker = new MetricsTracker({ collectionInterval: 100 });
      quickTracker.registerDiagnosticTool(mockDiagnosticTool);
      
      const collectedMetrics: UnifiedMetrics[] = [];
      quickTracker.on('metrics-collected', (metrics) => {
        collectedMetrics.push(metrics);
      });
      
      await quickTracker.startCollection();
      
      // Wait for multiple collection cycles
      await new Promise(resolve => setTimeout(resolve, 350));
      quickTracker.stopCollection();
      
      expect(collectedMetrics.length).toBeGreaterThan(2);
    });
  });

  describe('Public API Methods', () => {
    it('should return current metrics', async () => {
      expect(tracker.getCurrentMetrics()).toBeNull();
      
      await tracker.collectMetrics();
      const current = tracker.getCurrentMetrics();
      
      expect(current).not.toBeNull();
      expect(current?.timestamp).toBeGreaterThan(0);
    });

    it('should return metrics history with optional limit', async () => {
      await tracker.collectMetrics();
      await tracker.collectMetrics();
      await tracker.collectMetrics();
      
      const allHistory = tracker.getMetricsHistory();
      const limitedHistory = tracker.getMetricsHistory(2);
      
      expect(allHistory).toHaveLength(3);
      expect(limitedHistory).toHaveLength(2);
      expect(limitedHistory[0].timestamp).toBe(allHistory[1].timestamp);
    });

    it('should return recent alerts', async () => {
      tracker['alerts'] = [
        { id: '1', severity: 'info', message: 'Test 1', timestamp: Date.now(), source: 'test' },
        { id: '2', severity: 'warning', message: 'Test 2', timestamp: Date.now(), source: 'test' },
        { id: '3', severity: 'error', message: 'Test 3', timestamp: Date.now(), source: 'test' }
      ];
      
      const allAlerts = tracker.getRecentAlerts();
      const limitedAlerts = tracker.getRecentAlerts(2);
      
      expect(allAlerts).toHaveLength(3);
      expect(limitedAlerts).toHaveLength(2);
    });

    it('should return system summary', async () => {
      await tracker.collectMetrics();
      const summary = tracker.getSystemSummary();
      
      expect(summary).toMatchObject({
        timestamp: expect.any(Number),
        overallHealth: expect.stringMatching(/healthy|degraded|critical/),
        systemLoad: {
          cpu: expect.any(Number),
          memory: expect.any(Number),
          disk: expect.any(Number)
        },
        cluster: {
          nodes: expect.any(Number),
          stability: expect.stringMatching(/stable|degraded|unstable/),
          messageRate: expect.any(Number)
        },
        network: {
          status: expect.stringMatching(/connected|degraded|disconnected/),
          latency: expect.any(Number),
          activeConnections: expect.any(Number)
        },
        alerts: expect.any(Number)
      });
    });

    it('should reset metrics and alerts', async () => {
      await tracker.collectMetrics();
      tracker['alerts'] = [{ id: '1', severity: 'info', message: 'Test', timestamp: Date.now(), source: 'test' }];
      
      let resetEmitted = false;
      tracker.on('reset', () => { resetEmitted = true; });
      
      tracker.reset();
      
      expect(tracker.getMetricsHistory()).toHaveLength(0);
      expect(tracker.getRecentAlerts()).toHaveLength(0);
      expect(resetEmitted).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle collection errors gracefully', async () => {
      const errorTool = {
        async collectPerformanceMetrics() {
          throw new Error('Collection failed');
        }
      };
      
      tracker.registerDiagnosticTool(errorTool);
      
      const errors: Error[] = [];
      tracker.on('error', (error) => errors.push(error));
      
      const metrics = await tracker.collectMetrics();
      
      expect(errors.length).toBeGreaterThan(0);
      expect(metrics).toBeDefined(); // Should still return metrics with fallbacks
    });

    it('should emit errors during automatic collection', async () => {
      const errorTracker = new MetricsTracker({ collectionInterval: 50 });
      const errorTool = {
        async collectPerformanceMetrics() {
          throw new Error('Periodic collection failed');
        }
      };
      
      errorTracker.registerDiagnosticTool(errorTool);
      
      const errors: Error[] = [];
      errorTracker.on('error', (error) => errors.push(error));
      
      await errorTracker.startCollection();
      await new Promise(resolve => setTimeout(resolve, 150));
      errorTracker.stopCollection();
      
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
