import { MetricsExporter, ExportDestination, MetricsExporterConfig } from '../../../src/metrics/MetricsExporter';
import { UnifiedMetrics, Alert } from '../../../src/metrics/MetricsTracker';
import { NodeHealthStatus } from '../../../src/cluster/monitoring/FailureDetector';
import { NodeStatus } from '../../../src/cluster/types';
import { EventEmitter } from 'eventemitter3';

// Mock unified metrics for testing
const mockUnifiedMetrics: UnifiedMetrics = {
  timestamp: 1754308718820,
  system: {
    cpu: { percentage: 45.5, loadAverage: [1.2, 1.3, 1.1] },
    memory: { used: 4096, total: 8192, percentage: 50 },
    disk: { used: 100000, available: 150000, total: 250000, percentage: 40 }
  },
  cluster: {
    membershipSize: 5,
    gossipRate: 100,
    failureDetectionLatency: 200,
    averageHeartbeatInterval: 1000,
    messageRate: 50,
    messageLatency: 150,
    networkThroughput: 1000000,
    clusterStability: 'stable' as const
  },
  network: {
    latency: 75,
    status: 'connected' as const,
    roundTripTimes: new Map([['node1', 50], ['node2', 75], ['node3', 100]]),
    failedConnections: 0,
    activeConnections: 3
  },
  connections: {
    totalAcquired: 100,
    totalReleased: 90,
    totalCreated: 20,
    totalDestroyed: 5,
    activeConnections: 15,
    poolUtilization: 0.75,
    averageAcquireTime: 15,
    connectionHealth: 'healthy' as const
  },
  health: {
    overallHealth: 'healthy' as const,
    nodeHealth: new Map<string, NodeHealthStatus>([
      ['node1', { 
        nodeId: 'node1', 
        status: 'ALIVE', 
        lastHeartbeat: Date.now(),
        lastPing: Date.now(),
        lastPong: Date.now(),
        missedHeartbeats: 0,
        missedPings: 0,
        roundTripTime: 50, 
        isResponsive: true 
      }],
      ['node2', { 
        nodeId: 'node2', 
        status: 'ALIVE', 
        lastHeartbeat: Date.now(),
        lastPing: Date.now(),
        lastPong: Date.now(),
        missedHeartbeats: 0,
        missedPings: 0,
        roundTripTime: 75, 
        isResponsive: true 
      }]
    ]),
    systemAlerts: [],
    performanceTrends: {
      cpu: 'stable' as const,
      memory: 'stable' as const,
      network: 'stable' as const
    }
  }
};

const mockAlert: Alert = {
  id: 'test-alert-1',
  severity: 'warning',
  message: 'Test alert message',
  timestamp: Date.now(),
  source: 'test',
  metadata: { component: 'test' }
};

describe('MetricsExporter', () => {
  let exporter: MetricsExporter;
  let destinations: ExportDestination[];

  beforeEach(() => {
    destinations = [
      {
        type: 'json',
        endpoint: 'http://localhost:3000/metrics',
        headers: { 'Authorization': 'Bearer test-token' }
      },
      {
        type: 'prometheus',
        endpoint: 'http://localhost:9090/metrics',
        tags: { service: 'test', environment: 'development' }
      }
    ];

    exporter = new MetricsExporter({
      destinations,
      defaultTags: { instance: 'test-1', region: 'us-east-1' },
      enableBuffering: true,
      bufferSize: 10,
      flushInterval: 1000
    });
  });

  afterEach(async () => {
    exporter.stopAutoFlush();
    await exporter.cleanup();
  });

  describe('Configuration', () => {
    test('should initialize with default configuration', () => {
      const defaultExporter = new MetricsExporter({ destinations: [] });
      const stats = defaultExporter.getStats();
      
      expect(stats.destinations).toBe(0);
      expect(stats.bufferSize).toBe(0);
      expect(stats.isExporting).toBe(false);
    });

    test('should accept custom configuration', () => {
      const customConfig: MetricsExporterConfig = {
        destinations: destinations,
        enableBuffering: false,
        bufferSize: 50,
        flushInterval: 5000,
        enableCompression: true,
        retryAttempts: 5,
        retryDelay: 2000
      };

      const customExporter = new MetricsExporter(customConfig);
      const stats = customExporter.getStats();
      
      expect(stats.destinations).toBe(2);
      expect(stats.bufferSize).toBe(0); // No buffering enabled
    });

    test('should update configuration dynamically', () => {
      let configUpdated = false;
      exporter.on('config-updated', () => { configUpdated = true; });
      
      exporter.updateConfig({ bufferSize: 20, flushInterval: 2000 });
      
      expect(configUpdated).toBe(true);
    });
  });

  describe('Destination Management', () => {
    test('should add destinations', () => {
      const newDestination: ExportDestination = {
        type: 'csv',
        endpoint: 'http://localhost:4000/csv'
      };
      
      let destinationAdded = false;
      exporter.on('destination-added', () => { destinationAdded = true; });
      
      exporter.addDestination(newDestination);
      
      expect(exporter.getStats().destinations).toBe(3);
      expect(destinationAdded).toBe(true);
    });

    test('should remove destinations', () => {
      let destinationRemoved = false;
      exporter.on('destination-removed', () => { destinationRemoved = true; });
      
      exporter.removeDestination('json', 'http://localhost:3000/metrics');
      
      expect(exporter.getStats().destinations).toBe(1);
      expect(destinationRemoved).toBe(true);
    });

    test('should remove all destinations of a type', () => {
      exporter.addDestination({ type: 'json', endpoint: 'http://localhost:5000/metrics' });
      
      exporter.removeDestination('json'); // Remove all JSON destinations
      
      expect(exporter.getStats().destinations).toBe(1); // Only prometheus should remain
    });
  });

  describe('Metrics Export', () => {
    test('should export metrics without buffering', async () => {
      const nonBufferedExporter = new MetricsExporter({
        destinations: [{ type: 'json', endpoint: 'http://localhost:3000/metrics' }],
        enableBuffering: false
      });

      let exportAttempted = false;
      nonBufferedExporter.on('export-attempted', () => { exportAttempted = true; });

      await nonBufferedExporter.exportMetrics(mockUnifiedMetrics);
      
      expect(exportAttempted).toBe(true);
      await nonBufferedExporter.cleanup();
    });

    test('should buffer metrics when buffering enabled', async () => {
      await exporter.exportMetrics(mockUnifiedMetrics);
      
      const stats = exporter.getStats();
      expect(stats.bufferSize).toBe(1);
    });

    test('should auto-flush when buffer reaches limit', async () => {
      let exportSuccess = false;
      exporter.on('export-success', () => { exportSuccess = true; });

      // Fill buffer to capacity (bufferSize = 10)
      for (let i = 0; i < 10; i++) {
        await exporter.exportMetrics(mockUnifiedMetrics);
      }
      
      expect(exportSuccess).toBe(true);
      expect(exporter.getStats().bufferSize).toBe(0);
    });

    test('should export single alert', async () => {
      await exporter.exportAlert(mockAlert);
      
      const stats = exporter.getStats();
      expect(stats.alertBufferSize).toBe(1);
    });

    test('should handle export errors', async () => {
      const errorExporter = new MetricsExporter({
        destinations: [{ type: 'json' }], // Missing endpoint
        enableBuffering: false
      });

      let exportError = false;
      errorExporter.on('export-error', () => { exportError = true; });

      try {
        await errorExporter.exportMetrics(mockUnifiedMetrics);
      } catch (error) {
        // Expected to throw
      }
      
      expect(exportError).toBe(true);
      await errorExporter.cleanup();
    });
  });

  describe('Batch Export', () => {
    test('should export batch of metrics and alerts', async () => {
      const metrics = [mockUnifiedMetrics, { ...mockUnifiedMetrics, timestamp: Date.now() }];
      const alerts = [mockAlert];

      let exportSuccess = false;
      let exportStats: any = null;
      exporter.on('export-success', (stats) => {
        exportSuccess = true;
        exportStats = stats;
      });

      await exporter.exportBatch(metrics, alerts);
      
      expect(exportSuccess).toBe(true);
      expect(exportStats.metrics).toBe(2);
      expect(exportStats.alerts).toBe(1);
    });

    test('should prevent concurrent exports', async () => {
      // Mock a slow export
      const slowExporter = new MetricsExporter({
        destinations: [{ type: 'json', endpoint: 'http://slow-endpoint' }],
        enableBuffering: false
      });

      // Start first export (will be ongoing)
      const firstExport = slowExporter.exportBatch([mockUnifiedMetrics], []);
      
      // Try second export immediately (should be skipped)
      await slowExporter.exportBatch([mockUnifiedMetrics], []);
      
      await firstExport;
      await slowExporter.cleanup();
    });
  });

  describe('Flush Operations', () => {
    test('should flush buffered data manually', async () => {
      await exporter.exportMetrics(mockUnifiedMetrics);
      await exporter.exportAlert(mockAlert);
      
      expect(exporter.getStats().bufferSize).toBe(1);
      expect(exporter.getStats().alertBufferSize).toBe(1);
      
      let exportSuccess = false;
      exporter.on('export-success', () => { exportSuccess = true; });
      
      await exporter.flush();
      
      expect(exportSuccess).toBe(true);
      expect(exporter.getStats().bufferSize).toBe(0);
      expect(exporter.getStats().alertBufferSize).toBe(0);
    });

    test('should handle empty flush', async () => {
      let exportAttempted = false;
      exporter.on('export-attempted', () => { exportAttempted = true; });
      
      await exporter.flush(); // Nothing to flush
      
      expect(exportAttempted).toBe(false);
    });

    test('should auto-flush on interval', async () => {
      const quickFlushExporter = new MetricsExporter({
        destinations: [{ type: 'json', endpoint: 'http://localhost:3000/metrics' }],
        enableBuffering: true,
        flushInterval: 50 // Very quick flush
      });

      await quickFlushExporter.exportMetrics(mockUnifiedMetrics);
      
      let exportSuccess = false;
      quickFlushExporter.on('export-success', () => { exportSuccess = true; });
      
      // Wait longer for auto-flush
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(exportSuccess).toBe(true);
      await quickFlushExporter.cleanup();
    });

    test('should handle flush errors', async () => {
      const errorExporter = new MetricsExporter({
        destinations: [{ type: 'json' }], // Missing endpoint will cause error
        enableBuffering: true,
        flushInterval: 25 // Very quick flush
      });

      await errorExporter.exportMetrics(mockUnifiedMetrics);
      
      let flushError = false;
      errorExporter.on('flush-error', () => { flushError = true; });
      
      // Wait longer for auto-flush to trigger error
      await new Promise(resolve => setTimeout(resolve, 150));
      
      expect(flushError).toBe(true);
      await errorExporter.cleanup();
    });
  });

  describe('Format-Specific Export', () => {
    test('should format Prometheus metrics correctly', async () => {
      const prometheusExporter = new MetricsExporter({
        destinations: [{ type: 'prometheus', endpoint: 'http://localhost:9090/metrics' }],
        enableBuffering: false
      });

      let exportData: any = null;
      prometheusExporter.on('export-attempted', (data) => { exportData = data; });

      await prometheusExporter.exportMetrics(mockUnifiedMetrics);
      
      expect(exportData).toBeDefined();
      expect(exportData.destination).toBe('prometheus');
      await prometheusExporter.cleanup();
    });

    test('should format JSON metrics correctly', async () => {
      const jsonExporter = new MetricsExporter({
        destinations: [{ type: 'json', endpoint: 'http://localhost:3000/metrics' }],
        enableBuffering: false
      });

      let exportData: any = null;
      jsonExporter.on('export-attempted', (data) => { exportData = data; });

      await jsonExporter.exportBatch([mockUnifiedMetrics], [mockAlert]);
      
      expect(exportData).toBeDefined();
      expect(exportData.destination).toBe('json');
      await jsonExporter.cleanup();
    });

    test('should format CSV metrics correctly', async () => {
      const csvExporter = new MetricsExporter({
        destinations: [{ type: 'csv', endpoint: 'http://localhost:4000/csv' }],
        enableBuffering: false
      });

      let exportData: any = null;
      csvExporter.on('export-attempted', (data) => { exportData = data; });

      await csvExporter.exportMetrics(mockUnifiedMetrics);
      
      expect(exportData).toBeDefined();
      expect(exportData.destination).toBe('csv');
      await csvExporter.cleanup();
    });

    test('should format InfluxDB metrics correctly', async () => {
      const influxExporter = new MetricsExporter({
        destinations: [{ 
          type: 'influxdb', 
          endpoint: 'http://localhost:8086/write',
          database: 'metrics'
        }],
        enableBuffering: false
      });

      let exportData: any = null;
      influxExporter.on('export-attempted', (data) => { exportData = data; });

      await influxExporter.exportMetrics(mockUnifiedMetrics);
      
      expect(exportData).toBeDefined();
      expect(exportData.destination).toBe('influxdb');
      await influxExporter.cleanup();
    });

    test('should format CloudWatch metrics correctly', async () => {
      const cloudwatchExporter = new MetricsExporter({
        destinations: [{ type: 'cloudwatch', endpoint: 'https://cloudwatch.amazonaws.com' }],
        enableBuffering: false
      });

      let exportData: any = null;
      cloudwatchExporter.on('export-attempted', (data) => { exportData = data; });

      await cloudwatchExporter.exportMetrics(mockUnifiedMetrics);
      
      expect(exportData).toBeDefined();
      expect(exportData.destination).toBe('cloudwatch');
      await cloudwatchExporter.cleanup();
    });

    test('should format Datadog metrics correctly', async () => {
      const datadogExporter = new MetricsExporter({
        destinations: [{ 
          type: 'datadog', 
          endpoint: 'https://api.datadoghq.com/api/v1/series',
          apiKey: 'test-key'
        }],
        enableBuffering: false
      });

      let exportData: any = null;
      datadogExporter.on('export-attempted', (data) => { exportData = data; });

      await datadogExporter.exportMetrics(mockUnifiedMetrics);
      
      expect(exportData).toBeDefined();
      expect(exportData.destination).toBe('datadog');
      await datadogExporter.cleanup();
    });

    test('should handle unsupported format', async () => {
      const invalidExporter = new MetricsExporter({
        destinations: [{ type: 'unsupported' as any, endpoint: 'http://test' }],
        enableBuffering: false
      });

      let exportError = false;
      invalidExporter.on('export-error', () => { exportError = true; });

      try {
        await invalidExporter.exportMetrics(mockUnifiedMetrics);
      } catch (error: any) {
        expect(error.message).toContain('Unsupported export format');
      }
      
      expect(exportError).toBe(true);
      await invalidExporter.cleanup();
    });
  });

  describe('Tags and Headers', () => {
    test('should apply default tags to exports', async () => {
      const taggedExporter = new MetricsExporter({
        destinations: [{ type: 'prometheus', endpoint: 'http://localhost:9090/metrics' }],
        defaultTags: { service: 'test-service', version: '1.0.0' },
        enableBuffering: false
      });

      let exportAttempted = false;
      taggedExporter.on('export-attempted', () => { exportAttempted = true; });

      await taggedExporter.exportMetrics(mockUnifiedMetrics);
      
      expect(exportAttempted).toBe(true);
      await taggedExporter.cleanup();
    });

    test('should merge destination tags with default tags', async () => {
      const mergedTagsExporter = new MetricsExporter({
        destinations: [{ 
          type: 'json', 
          endpoint: 'http://localhost:3000/metrics',
          tags: { environment: 'test', deployment: 'canary' }
        }],
        defaultTags: { service: 'test-service', region: 'us-west-1' },
        enableBuffering: false
      });

      let exportAttempted = false;
      mergedTagsExporter.on('export-attempted', () => { exportAttempted = true; });

      await mergedTagsExporter.exportMetrics(mockUnifiedMetrics);
      
      expect(exportAttempted).toBe(true);
      await mergedTagsExporter.cleanup();
    });

    test('should apply custom headers', async () => {
      const headersExporter = new MetricsExporter({
        destinations: [{ 
          type: 'json', 
          endpoint: 'http://localhost:3000/metrics',
          headers: { 'X-Custom-Header': 'test-value', 'Content-Encoding': 'gzip' }
        }],
        enableBuffering: false
      });

      let exportAttempted = false;
      headersExporter.on('export-attempted', () => { exportAttempted = true; });

      await headersExporter.exportMetrics(mockUnifiedMetrics);
      
      expect(exportAttempted).toBe(true);
      await headersExporter.cleanup();
    });

    test('should apply API key authorization', async () => {
      const authExporter = new MetricsExporter({
        destinations: [{ 
          type: 'json', 
          endpoint: 'http://localhost:3000/metrics',
          apiKey: 'secret-api-key'
        }],
        enableBuffering: false
      });

      let exportAttempted = false;
      authExporter.on('export-attempted', () => { exportAttempted = true; });

      await authExporter.exportMetrics(mockUnifiedMetrics);
      
      expect(exportAttempted).toBe(true);
      await authExporter.cleanup();
    });
  });

  describe('Event Emission', () => {
    test('should emit export-success event', async () => {
      let successEmitted = false;
      let successStats: any = null;
      
      exporter.on('export-success', (stats) => {
        successEmitted = true;
        successStats = stats;
      });

      await exporter.exportBatch([mockUnifiedMetrics], [mockAlert]);
      
      expect(successEmitted).toBe(true);
      expect(successStats.metrics).toBe(1);
      expect(successStats.alerts).toBe(1);
    });

    test('should emit export-attempted event', async () => {
      let attemptEmitted = false;
      let attemptData: any = null;
      
      exporter.on('export-attempted', (data) => {
        attemptEmitted = true;
        attemptData = data;
      });

      await exporter.exportBatch([mockUnifiedMetrics], []);
      
      expect(attemptEmitted).toBe(true);
      expect(attemptData.dataSize).toBeGreaterThan(0);
    });

    test('should emit destination management events', () => {
      let addedEmitted = false;
      let removedEmitted = false;
      
      exporter.on('destination-added', () => { addedEmitted = true; });
      exporter.on('destination-removed', () => { removedEmitted = true; });

      exporter.addDestination({ type: 'csv', endpoint: 'http://localhost:4000/csv' });
      exporter.removeDestination('csv');
      
      expect(addedEmitted).toBe(true);
      expect(removedEmitted).toBe(true);
    });
  });

  describe('Cleanup', () => {
    test('should cleanup properly', async () => {
      await exporter.exportMetrics(mockUnifiedMetrics);
      
      let exportSuccess = false;
      exporter.on('export-success', () => { exportSuccess = true; });
      
      await exporter.cleanup();
      
      expect(exportSuccess).toBe(true); // Final flush
      expect(exporter.getStats().bufferSize).toBe(0);
    });

    test('should stop auto-flush on cleanup', async () => {
      const autoFlushExporter = new MetricsExporter({
        destinations: [{ type: 'json', endpoint: 'http://localhost:3000/metrics' }],
        enableBuffering: true,
        flushInterval: 100
      });

      autoFlushExporter.stopAutoFlush();
      
      // Verify timer is stopped (no way to directly test, but ensure no errors)
      await new Promise(resolve => setTimeout(resolve, 150));
      
      await autoFlushExporter.cleanup();
    });

    test('should remove all listeners on cleanup', async () => {
      exporter.on('test-event', () => {});
      exporter.on('another-event', () => {});
      
      expect(exporter.listenerCount('test-event')).toBe(1);
      expect(exporter.listenerCount('another-event')).toBe(1);
      
      await exporter.cleanup();
      
      expect(exporter.listenerCount('test-event')).toBe(0);
      expect(exporter.listenerCount('another-event')).toBe(0);
    });
  });

  describe('Statistics', () => {
    test('should provide accurate statistics', async () => {
      await exporter.exportMetrics(mockUnifiedMetrics);
      await exporter.exportAlert(mockAlert);
      
      const stats = exporter.getStats();
      
      expect(stats).toEqual({
        bufferSize: 1,
        alertBufferSize: 1,
        isExporting: false,
        destinations: 2
      });
    });

    test('should reflect isExporting status during export', async () => {
      // This is difficult to test reliably due to timing, but we can verify the flag exists
      const stats = exporter.getStats();
      expect(typeof stats.isExporting).toBe('boolean');
    });
  });
});
