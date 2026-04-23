import { MetricsTracker, UnifiedMetrics, Alert } from '../../../src/monitoring/metrics/MetricsTracker';
import { MetricsExporter } from '../../../src/monitoring/metrics/MetricsExporter';

// Mock implementations for integration testing
class MockDiagnosticTool {
  private cpuUsage = 45.5;
  private memoryUsage = 50;
  private diskUsage = 40;

  async collectPerformanceMetrics() {
    return {
      cpu: { percentage: this.cpuUsage, loadAverage: [1.2, 1.3, 1.1] },
      memory: { used: 4096, total: 8192, percentage: this.memoryUsage },
      disk: { used: 100000, available: 150000, total: 250000, percentage: this.diskUsage }
    };
  }

  // Helper methods for simulating load changes
  setCpuUsage(usage: number) { this.cpuUsage = usage; }
  setMemoryUsage(usage: number) { this.memoryUsage = usage; }
  setDiskUsage(usage: number) { this.diskUsage = usage; }
}

class MockClusterIntrospection {
  private membershipSize = 5;
  private gossipRate = 100;
  private messageLatency = 150;

  async getPerformanceMetrics() {
    return {
      membershipSize: this.membershipSize,
      gossipRate: this.gossipRate,
      failureDetectionLatency: 200,
      averageHeartbeatInterval: 1000,
      messageRate: 50,
      messageLatency: this.messageLatency,
      networkThroughput: 1000000
    };
  }

  // Helper methods for simulating cluster changes
  setMembershipSize(size: number) { this.membershipSize = size; }
  setGossipRate(rate: number) { this.gossipRate = rate; }
  setMessageLatency(latency: number) { this.messageLatency = latency; }
}

class MockFailureDetector {
  private nodeHealthData = [
    { nodeId: 'node1', isResponsive: true, roundTripTime: 50, lastSeen: Date.now() },
    { nodeId: 'node2', isResponsive: true, roundTripTime: 75, lastSeen: Date.now() },
    { nodeId: 'node3', isResponsive: true, roundTripTime: 100, lastSeen: Date.now() }
  ];

  getAllNodeHealth() {
    return this.nodeHealthData;
  }

  // Helper methods for simulating network changes
  setNodeHealth(nodeId: string, isResponsive: boolean, roundTripTime: number) {
    const node = this.nodeHealthData.find(n => n.nodeId === nodeId);
    if (node) {
      node.isResponsive = isResponsive;
      node.roundTripTime = roundTripTime;
      node.lastSeen = isResponsive ? Date.now() : Date.now() - 60000;
    }
  }

  addNode(nodeId: string, isResponsive: boolean = true, roundTripTime: number = 50) {
    this.nodeHealthData.push({
      nodeId,
      isResponsive,
      roundTripTime,
      lastSeen: Date.now()
    });
  }

  removeNode(nodeId: string) {
    this.nodeHealthData = this.nodeHealthData.filter(n => n.nodeId !== nodeId);
  }
}

class MockConnectionPool {
  private stats = {
    totalAcquired: 100,
    totalReleased: 90,
    totalCreated: 20,
    totalDestroyed: 5,
    activeConnections: 15,
    acquireTimes: [10, 15, 20, 12, 18]
  };

  getStats() {
    return { ...this.stats };
  }

  // Helper methods for simulating connection changes
  setActiveConnections(count: number) { this.stats.activeConnections = count; }
  setTotalCreated(count: number) { this.stats.totalCreated = count; }
  addAcquisition(time: number) {
    this.stats.totalAcquired++;
    this.stats.acquireTimes.push(time);
    if (this.stats.acquireTimes.length > 10) {
      this.stats.acquireTimes.shift(); // Keep only recent times
    }
  }
}

// Mock export destination that captures exported data
class MockExportDestination {
  public exportedData: any[] = [];
  public exportedAlerts: Alert[] = [];

  reset() {
    this.exportedData = [];
    this.exportedAlerts = [];
  }

  captureExport(data: any, isAlert: boolean = false) {
    if (isAlert) {
      this.exportedAlerts.push(data);
    } else {
      this.exportedData.push(data);
    }
  }
}

describe('Metrics System Integration Tests', () => {
  let tracker: MetricsTracker;
  let exporter: MetricsExporter;
  let mockDiagnosticTool: MockDiagnosticTool;
  let mockClusterIntrospection: MockClusterIntrospection;
  let mockFailureDetector: MockFailureDetector;
  let mockConnectionPool: MockConnectionPool;
  let mockDestination: MockExportDestination;

  beforeEach(() => {
    // Create mock components
    mockDiagnosticTool = new MockDiagnosticTool();
    mockClusterIntrospection = new MockClusterIntrospection();
    mockFailureDetector = new MockFailureDetector();
    mockConnectionPool = new MockConnectionPool();
    mockDestination = new MockExportDestination();

    // Create metrics tracker with fast collection for testing
    tracker = new MetricsTracker({
      collectionInterval: 100, // Fast for testing
      retentionPeriod: 60000,
      enableTrends: true,
      enableAlerts: true,
      thresholds: {
        cpu: 80,
        memory: 85,
        disk: 90,
        networkLatency: 200,
        clusterStability: 0.8
      }
    });

    // Create metrics exporter with mock destination
    exporter = new MetricsExporter({
      destinations: [
        { type: 'json', endpoint: 'http://localhost:3000/metrics' },
        { type: 'prometheus', endpoint: 'http://localhost:9090/metrics' }
      ],
      enableBuffering: false, // Disable buffering for immediate export in tests
      defaultTags: { service: 'integration-test', environment: 'test' }
    });

    // Register metric sources
    tracker.registerDiagnosticTool(mockDiagnosticTool);
    tracker.registerClusterIntrospection(mockClusterIntrospection);
    tracker.registerFailureDetector(mockFailureDetector);
    tracker.registerConnectionPool(mockConnectionPool);

    // Mock the actual export to capture data
    (exporter as any).sendToEndpoint = async (data: string, destination: any, contentType: string) => {
      mockDestination.captureExport({
        data,
        destination: destination.type,
        contentType,
        timestamp: Date.now()
      });
      // Still emit the export-attempted event
      exporter.emit('export-attempted', {
        destination: destination.type,
        endpoint: destination.endpoint,
        dataSize: data.length
      });
      // Simulate successful response without actual HTTP call
      return Promise.resolve();
    };
  });

  afterEach(async () => {
    tracker.stopCollection();
    tracker.removeAllListeners();
    await exporter.cleanup();
    mockDestination.reset();
  });

  describe('End-to-End Metrics Flow', () => {
    test('should collect, process, and export metrics successfully', async () => {
      // Set up event tracking
      const collectedMetrics: UnifiedMetrics[] = [];
      const exportedBatches: any[] = [];
      const alerts: Alert[] = [];

      tracker.on('metrics-collected', (metrics) => collectedMetrics.push(metrics));
      tracker.on('alert', (alert) => alerts.push(alert));
      exporter.on('export-success', (stats) => exportedBatches.push(stats));

      // Collect initial metrics
      const metrics = await tracker.collectMetrics();
      
      // Export the metrics
      await exporter.exportMetrics(metrics);

      // Verify metrics collection
      expect(collectedMetrics).toHaveLength(1);
      expect(collectedMetrics[0]).toMatchObject({
        timestamp: expect.any(Number),
        system: { cpu: { percentage: 45.5 } },
        cluster: { membershipSize: 5 },
        network: { activeConnections: 3 },
        connections: { totalAcquired: 100 }
      });

      // Verify export
      expect(mockDestination.exportedData).toHaveLength(2); // JSON + Prometheus
      expect(mockDestination.exportedData[0].destination).toBe('json');
      expect(mockDestination.exportedData[1].destination).toBe('prometheus');
    });

    test('should handle high-load scenario with multiple rapid collections', async () => {
      const collectedMetrics: UnifiedMetrics[] = [];
      tracker.on('metrics-collected', (metrics) => collectedMetrics.push(metrics));

      // Simulate rapid metrics collection (5 collections in quick succession)
      const promises: Promise<UnifiedMetrics>[] = [];
      for (let i = 0; i < 5; i++) {
        promises.push(tracker.collectMetrics());
        await new Promise(resolve => setTimeout(resolve, 10)); // Small delay between collections
      }

      const results = await Promise.all(promises);

      // Verify all collections succeeded
      expect(results).toHaveLength(5);
      expect(collectedMetrics).toHaveLength(5);

      // Verify timestamps are increasing
      for (let i = 1; i < results.length; i++) {
        expect(results[i].timestamp).toBeGreaterThan(results[i-1].timestamp);
      }

      // Export all metrics
      for (const metrics of results) {
        await exporter.exportMetrics(metrics);
      }

      // Verify export buffer auto-flush (buffer size is 5)
      expect(mockDestination.exportedData.length).toBeGreaterThan(0);
    });

    test('should detect and respond to system degradation', async () => {
      const alerts: Alert[] = [];
      tracker.on('alert', (alert) => alerts.push(alert));

      // Start with normal metrics
      await tracker.collectMetrics();
      expect(alerts).toHaveLength(0);

      // Simulate system degradation
      mockDiagnosticTool.setCpuUsage(95); // Above 80% threshold
      mockDiagnosticTool.setMemoryUsage(90); // Above 85% threshold
      mockFailureDetector.setNodeHealth('node1', false, 1000); // Node failure
      mockFailureDetector.setNodeHealth('node2', false, 1000); // Another node failure

      const degradedMetrics = await tracker.collectMetrics();

      // Should generate alerts for high CPU, memory, and cluster instability
      expect(alerts.length).toBeGreaterThan(0);
      
      // Verify specific alerts
      const cpuAlert = alerts.find(a => a.message.includes('CPU'));
      const memoryAlert = alerts.find(a => a.message.includes('Memory'));
      
      expect(cpuAlert).toBeDefined();
      expect(memoryAlert).toBeDefined();
      expect(cpuAlert?.severity).toBe('warning');
      expect(memoryAlert?.severity).toBe('warning');

      // Verify system health reflects degradation
      expect(degradedMetrics.health.overallHealth).toBe('critical'); // Only 1/3 nodes healthy

      // Export metrics with alerts
      await exporter.exportBatch([degradedMetrics], alerts);
      expect(mockDestination.exportedData.length).toBeGreaterThan(0);
    });

    test('should track performance trends over time', async () => {
      const metricsHistory: UnifiedMetrics[] = [];

      // Collect baseline metrics
      let metrics = await tracker.collectMetrics();
      metricsHistory.push(metrics);

      // Simulate gradual performance degradation
      for (let i = 1; i <= 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
        
        // Gradually increase CPU usage
        mockDiagnosticTool.setCpuUsage(45.5 + (i * 10));
        
        metrics = await tracker.collectMetrics();
        metricsHistory.push(metrics);
      }

      // Verify trend detection
      const finalMetrics = metricsHistory[metricsHistory.length - 1];
      expect(finalMetrics.health.performanceTrends.cpu).toBe('degrading');

      // Verify metrics history is maintained
      const history = tracker.getMetricsHistory();
      expect(history.length).toBe(6); // 1 baseline + 5 degradation steps

      // Export entire history
      await exporter.exportBatch(history, []);
      expect(mockDestination.exportedData.length).toBeGreaterThan(0);
    });
  });

  describe('Multi-Format Export Integration', () => {
    test('should export to multiple formats simultaneously', async () => {
      const metrics = await tracker.collectMetrics();
      await exporter.exportMetrics(metrics);

      expect(mockDestination.exportedData).toHaveLength(2);
      
      // Verify JSON export
      const jsonExport = mockDestination.exportedData.find(d => d.destination === 'json');
      expect(jsonExport).toBeDefined();
      expect(jsonExport.contentType).toBe('application/json');
      expect(() => JSON.parse(jsonExport.data)).not.toThrow();

      // Verify Prometheus export
      const prometheusExport = mockDestination.exportedData.find(d => d.destination === 'prometheus');
      expect(prometheusExport).toBeDefined();
      expect(prometheusExport.contentType).toBe('text/plain');
      expect(prometheusExport.data).toContain('# HELP');
      expect(prometheusExport.data).toContain('# TYPE');
    });

    test('should apply tags and headers correctly in exports', async () => {
      const metrics = await tracker.collectMetrics();
      await exporter.exportMetrics(metrics);

      const jsonExport = mockDestination.exportedData.find(d => d.destination === 'json');
      const exportedData = JSON.parse(jsonExport.data);
      
      // Verify default tags are applied
      expect(exportedData.metadata.tags).toMatchObject({
        service: 'integration-test',
        environment: 'test'
      });

      // Verify metrics data structure
      expect(exportedData.metrics).toHaveLength(1);
      expect(exportedData.metrics[0]).toMatchObject({
        timestamp: expect.any(Number),
        system: expect.any(Object),
        cluster: expect.any(Object),
        network: expect.any(Object),
        connections: expect.any(Object),
        health: expect.any(Object)
      });
    });

    test('should handle export failures gracefully', async () => {
      // Create exporter with invalid destination
      const faultyExporter = new MetricsExporter({
        destinations: [{ type: 'json' }], // Missing endpoint
        enableBuffering: false
      });

      const exportErrors: Error[] = [];
      faultyExporter.on('export-error', (error) => exportErrors.push(error));

      const metrics = await tracker.collectMetrics();
      
      try {
        await faultyExporter.exportMetrics(metrics);
      } catch (error) {
        // Expected to fail
      }

      expect(exportErrors.length).toBeGreaterThan(0);
      expect(exportErrors[0].message).toContain('No endpoint specified');

      await faultyExporter.cleanup();
    });
  });

  describe('Real-time Monitoring Integration', () => {
    test('should provide real-time monitoring capabilities', async () => {
      const metricsStream: UnifiedMetrics[] = [];
      const alertStream: Alert[] = [];

      // Set up real-time event handlers
      tracker.on('metrics-collected', (metrics) => {
        metricsStream.push(metrics);
        // Auto-export each metric as it's collected
        exporter.exportMetrics(metrics);
      });

      tracker.on('alert', (alert) => {
        alertStream.push(alert);
        exporter.exportAlert(alert);
      });

      // Start continuous collection
      await tracker.startCollection();

      // Wait for several collection cycles
      await new Promise(resolve => setTimeout(resolve, 350));

      // Stop collection
      tracker.stopCollection();

      // Verify continuous monitoring worked
      expect(metricsStream.length).toBeGreaterThan(2);
      expect(mockDestination.exportedData.length).toBeGreaterThan(0);

      // Verify each metric has unique timestamp
      for (let i = 1; i < metricsStream.length; i++) {
        expect(metricsStream[i].timestamp).toBeGreaterThan(metricsStream[i-1].timestamp);
      }
    });

    test('should handle dynamic cluster membership changes', async () => {
      const membershipChanges: UnifiedMetrics[] = [];
      tracker.on('metrics-collected', (metrics) => membershipChanges.push(metrics));

      // Initial state - 3 nodes
      let metrics = await tracker.collectMetrics();
      expect(metrics.network.activeConnections).toBe(3);

      // Add a new node
      mockFailureDetector.addNode('node4', true, 60);
      metrics = await tracker.collectMetrics();
      expect(metrics.network.activeConnections).toBe(4);

      // Remove a node
      mockFailureDetector.removeNode('node2');
      metrics = await tracker.collectMetrics();
      expect(metrics.network.activeConnections).toBe(3);

      // Node failure
      mockFailureDetector.setNodeHealth('node1', false, 2000);
      metrics = await tracker.collectMetrics();
      expect(metrics.network.activeConnections).toBe(2);
      expect(metrics.network.failedConnections).toBe(1);

      // Export all membership change metrics
      await exporter.exportBatch(membershipChanges, []);
      expect(mockDestination.exportedData.length).toBeGreaterThan(0);
    });

    test('should integrate with dashboard APIs', async () => {
      // Simulate dashboard API integration
      const dashboardAPI = {
        getCurrentStatus: () => tracker.getSystemSummary(),
        getMetrics: (limit?: number) => tracker.getMetricsHistory(limit),
        getAlerts: (limit?: number) => tracker.getRecentAlerts(limit),
        getHealth: () => {
          const current = tracker.getCurrentMetrics();
          return current ? current.health : null;
        }
      };

      // Collect some metrics
      await tracker.collectMetrics();
      await tracker.collectMetrics();
      await tracker.collectMetrics();

      // Test dashboard API responses
      const status = dashboardAPI.getCurrentStatus();
      expect(status).toMatchObject({
        timestamp: expect.any(Number),
        overallHealth: expect.stringMatching(/healthy|degraded|critical/),
        systemLoad: expect.any(Object),
        cluster: expect.any(Object),
        network: expect.any(Object),
        alerts: expect.any(Number)
      });

      const metrics = dashboardAPI.getMetrics(2);
      expect(metrics).toHaveLength(2);

      const health = dashboardAPI.getHealth();
      expect(health).toMatchObject({
        overallHealth: expect.stringMatching(/healthy|degraded|critical/),
        performanceTrends: expect.any(Object)
      });

      // Export dashboard data
      await exporter.exportBatch(metrics, []);
      expect(mockDestination.exportedData.length).toBeGreaterThan(0);
    });
  });

  describe('Performance and Scalability', () => {
    test('should handle high-frequency metrics collection efficiently', async () => {
      const startTime = Date.now();
      const numCollections = 20;
      const results: UnifiedMetrics[] = [];

      // Rapid successive collections
      for (let i = 0; i < numCollections; i++) {
        const metrics = await tracker.collectMetrics();
        results.push(metrics);
        
        // Immediately export each metric
        await exporter.exportMetrics(metrics);
      }

      const endTime = Date.now();
      const totalTime = endTime - startTime;

      // Performance assertions
      expect(results).toHaveLength(numCollections);
      expect(totalTime).toBeLessThan(5000); // Should complete in under 5 seconds
      expect(mockDestination.exportedData.length).toBeGreaterThan(0);

      // Verify no data loss
      expect(tracker.getMetricsHistory().length).toBe(numCollections);
    });

    test('should efficiently manage memory with metric retention', async () => {
      // Create tracker with short retention for testing
      const shortRetentionTracker = new MetricsTracker({ 
        retentionPeriod: 500, // 500ms retention
        collectionInterval: 100
      });
      shortRetentionTracker.registerDiagnosticTool(mockDiagnosticTool);

      // Collect many metrics rapidly
      for (let i = 0; i < 10; i++) {
        await shortRetentionTracker.collectMetrics();
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Wait for retention cleanup
      await new Promise(resolve => setTimeout(resolve, 600));
      
      // Collect one more to trigger cleanup
      await shortRetentionTracker.collectMetrics();

      // Verify old metrics were cleaned up
      const history = shortRetentionTracker.getMetricsHistory();
      expect(history.length).toBeLessThan(10); // Some metrics should be cleaned up

      shortRetentionTracker.stopCollection();
    });

    test('should handle concurrent export destinations efficiently', async () => {
      // Create exporter with multiple destinations
      const multiDestinationExporter = new MetricsExporter({
        destinations: [
          { type: 'json', endpoint: 'http://localhost:3000/json' },
          { type: 'prometheus', endpoint: 'http://localhost:9090/metrics' },
          { type: 'csv', endpoint: 'http://localhost:4000/csv' },
          { type: 'influxdb', endpoint: 'http://localhost:8086/write' }
        ],
        enableBuffering: false
      });

      // Mock export tracking
      let exportAttempts = 0;
      multiDestinationExporter.on('export-attempted', () => exportAttempts++);

      const metrics = await tracker.collectMetrics();
      const startTime = Date.now();
      
      await multiDestinationExporter.exportMetrics(metrics);
      
      const endTime = Date.now();
      const exportTime = endTime - startTime;

      // Verify all destinations were attempted
      expect(exportAttempts).toBe(4); // 4 destinations
      expect(exportTime).toBeLessThan(1000); // Should be fast since it's mocked

      await multiDestinationExporter.cleanup();
    });
  });

  describe('Error Recovery and Resilience', () => {
    test('should recover from metric source failures', async () => {
      const errors: Error[] = [];
      tracker.on('error', (error) => errors.push(error));

      // Normal collection
      let metrics = await tracker.collectMetrics();
      expect(metrics.system.cpu.percentage).toBe(45.5);

      // Simulate diagnostic tool failure
      const failingTool = {
        async collectPerformanceMetrics() {
          throw new Error('Diagnostic tool crashed');
        }
      };
      tracker.registerDiagnosticTool(failingTool);

      // Collection should still work with fallback values
      metrics = await tracker.collectMetrics();
      expect(errors.length).toBeGreaterThan(0);
      expect(metrics).toBeDefined();
      expect(metrics.system.cpu.percentage).toBeGreaterThanOrEqual(0); // Fallback value

      // Export should still work
      await exporter.exportMetrics(metrics);
      expect(mockDestination.exportedData.length).toBeGreaterThan(0);
    });

    test('should maintain service during partial export failures', async () => {
      // Create exporter with mixed valid/invalid destinations
      const mixedExporter = new MetricsExporter({
        destinations: [
          { type: 'json', endpoint: 'http://localhost:3000/metrics' }, // Valid
          { type: 'prometheus' }, // Invalid - missing endpoint
          { type: 'csv', endpoint: 'http://localhost:4000/csv' } // Valid
        ],
        enableBuffering: false
      });

      const exportErrors: Error[] = [];
      const exportAttempts: any[] = [];
      
      mixedExporter.on('export-error', (error) => exportErrors.push(error));
      mixedExporter.on('export-attempted', (data) => exportAttempts.push(data));

      const metrics = await tracker.collectMetrics();
      
      try {
        await mixedExporter.exportMetrics(metrics);
      } catch (error) {
        // Some exports may fail, but service should continue
      }

      // Should have some successful exports and some errors
      expect(exportAttempts.length).toBeGreaterThan(0); // Some succeeded
      expect(exportErrors.length).toBeGreaterThan(0); // Some failed

      await mixedExporter.cleanup();
    });

    test('should handle system resource constraints gracefully', async () => {
      // Simulate resource constraints by rapid operations
      const promises: Promise<any>[] = [];
      
      // Start multiple concurrent operations
      for (let i = 0; i < 10; i++) {
        promises.push(tracker.collectMetrics());
        promises.push(exporter.exportMetrics(await tracker.collectMetrics()));
      }

      // All operations should complete without throwing
      const results = await Promise.allSettled(promises);
      
      // Most operations should succeed
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThan(results.length * 0.8); // At least 80% success

      // System should still be responsive
      const finalMetrics = await tracker.collectMetrics();
      expect(finalMetrics).toBeDefined();
    });
  });
});
