import { DiagnosticTool } from '../../../src/diagnostics/DiagnosticTool';

describe('DiagnosticTool Unit Tests', () => {
  let diagnosticTool: DiagnosticTool;

  beforeEach(() => {
    diagnosticTool = new DiagnosticTool();
  });

  describe('Construction and Initialization', () => {
    it('should create a new DiagnosticTool instance', () => {
      expect(diagnosticTool).toBeInstanceOf(DiagnosticTool);
    });

    it('should initialize with default configuration', () => {
      expect(diagnosticTool).toBeDefined();
      expect(typeof diagnosticTool.getStatus).toBe('function');
      expect(diagnosticTool.getStatus()).toBe('initialized');
    });

    it('should accept custom configuration', () => {
      const config = {
        enablePerformanceMetrics: true,
        enableHealthChecks: true,
        reportingInterval: 5000,
        enableLogging: true
      };
      
      const customTool = new DiagnosticTool(config);
      expect(customTool).toBeInstanceOf(DiagnosticTool);
    });
  });

  describe('Health Checks', () => {
    it('should perform basic system health check', async () => {
      const healthReport = await diagnosticTool.checkSystemHealth();
      
      expect(healthReport).toHaveProperty('status');
      expect(healthReport).toHaveProperty('timestamp');
      expect(healthReport).toHaveProperty('checks');
      expect(['healthy', 'degraded', 'unhealthy']).toContain(healthReport.status);
    });

    it('should check memory usage', async () => {
      const memoryCheck = await diagnosticTool.checkMemoryUsage();
      
      expect(memoryCheck).toHaveProperty('used');
      expect(memoryCheck).toHaveProperty('total');
      expect(memoryCheck).toHaveProperty('percentage');
      expect(memoryCheck.percentage).toBeGreaterThanOrEqual(0);
      expect(memoryCheck.percentage).toBeLessThanOrEqual(100);
    });

    it('should check CPU usage', async () => {
      const cpuCheck = await diagnosticTool.checkCpuUsage();
      
      expect(cpuCheck).toHaveProperty('percentage');
      expect(cpuCheck).toHaveProperty('loadAverage');
      expect(cpuCheck.percentage).toBeGreaterThanOrEqual(0);
      expect(cpuCheck.percentage).toBeLessThanOrEqual(100);
    });

    it('should check network connectivity', async () => {
      const networkCheck = await diagnosticTool.checkNetworkConnectivity();
      
      expect(networkCheck).toHaveProperty('status');
      expect(networkCheck).toHaveProperty('latency');
      expect(['connected', 'disconnected', 'degraded']).toContain(networkCheck.status);
    });

    it('should check disk space', async () => {
      const diskCheck = await diagnosticTool.checkDiskSpace();
      
      expect(diskCheck).toHaveProperty('used');
      expect(diskCheck).toHaveProperty('available');
      expect(diskCheck).toHaveProperty('total');
      expect(diskCheck).toHaveProperty('percentage');
      expect(diskCheck.percentage).toBeGreaterThanOrEqual(0);
      expect(diskCheck.percentage).toBeLessThanOrEqual(100);
    });
  });

  describe('Performance Metrics', () => {
    it('should collect performance metrics', async () => {
      const metrics = await diagnosticTool.collectPerformanceMetrics();
      
      expect(metrics).toHaveProperty('timestamp');
      expect(metrics).toHaveProperty('cpu');
      expect(metrics).toHaveProperty('memory');
      expect(metrics).toHaveProperty('network');
      expect(metrics).toHaveProperty('disk');
    });

    it('should track metrics over time', async () => {
      await diagnosticTool.startMetricsCollection();
      
      // Wait a short time for metrics to be collected
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const history = diagnosticTool.getMetricsHistory();
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThan(0);
      
      await diagnosticTool.stopMetricsCollection();
    });

    it('should calculate performance trends', async () => {
      await diagnosticTool.startMetricsCollection();
      
      // Simulate some time passing
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const trends = diagnosticTool.calculateTrends();
      expect(trends).toHaveProperty('cpu');
      expect(trends).toHaveProperty('memory');
      expect(trends.cpu).toHaveProperty('direction');
      expect(['increasing', 'decreasing', 'stable']).toContain(trends.cpu.direction);
      
      await diagnosticTool.stopMetricsCollection();
    });

    it('should detect performance anomalies', async () => {
      const anomalies = await diagnosticTool.detectAnomalies();
      
      expect(Array.isArray(anomalies)).toBe(true);
      anomalies.forEach(anomaly => {
        expect(anomaly).toHaveProperty('type');
        expect(anomaly).toHaveProperty('severity');
        expect(anomaly).toHaveProperty('description');
        expect(anomaly).toHaveProperty('timestamp');
      });
    });
  });

  describe('Cluster Diagnostics', () => {
    it('should diagnose cluster membership issues', async () => {
      const clusterNodes = ['node-1', 'node-2', 'node-3'];
      const membershipDiag = await diagnosticTool.diagnoseClusterMembership(clusterNodes);
      
      expect(membershipDiag).toHaveProperty('status');
      expect(membershipDiag).toHaveProperty('nodes');
      expect(membershipDiag).toHaveProperty('issues');
      expect(Array.isArray(membershipDiag.issues)).toBe(true);
    });

    it('should diagnose network partitions', async () => {
      const nodeConnections = {
        'node-1': ['node-2'],
        'node-2': ['node-1', 'node-3'],
        'node-3': ['node-2']
      };
      
      const partitionDiag = await diagnosticTool.diagnoseNetworkPartitions(nodeConnections);
      
      expect(partitionDiag).toHaveProperty('hasPartition');
      expect(partitionDiag).toHaveProperty('partitions');
      expect(Array.isArray(partitionDiag.partitions)).toBe(true);
    });

    it('should diagnose consensus issues', async () => {
      const consensusState = {
        term: 5,
        leader: 'node-2',
        followers: ['node-1', 'node-3'],
        uncommittedEntries: 10
      };
      
      const consensusDiag = await diagnosticTool.diagnoseConsensusIssues(consensusState);
      
      expect(consensusDiag).toHaveProperty('status');
      expect(consensusDiag).toHaveProperty('issues');
      expect(['healthy', 'degraded', 'failed']).toContain(consensusDiag.status);
    });

    it('should analyze cluster topology', async () => {
      const nodes = ['node-1', 'node-2', 'node-3', 'node-4'];
      const topology = await diagnosticTool.analyzeClusterTopology(nodes);
      
      expect(topology).toHaveProperty('nodeCount');
      expect(topology).toHaveProperty('connectivity');
      expect(topology).toHaveProperty('redundancy');
      expect(topology).toHaveProperty('recommendations');
      expect(topology.nodeCount).toBe(4);
    });
  });

  describe('Message Flow Analysis', () => {
    it('should trace message flow', async () => {
      const messageId = 'msg-123';
      const trace = await diagnosticTool.traceMessageFlow(messageId);
      
      expect(trace).toHaveProperty('messageId');
      expect(trace).toHaveProperty('path');
      expect(trace).toHaveProperty('timing');
      expect(trace).toHaveProperty('status');
      expect(Array.isArray(trace.path)).toBe(true);
    });

    it('should analyze message throughput', async () => {
      const throughputAnalysis = await diagnosticTool.analyzeMessageThroughput();
      
      expect(throughputAnalysis).toHaveProperty('messagesPerSecond');
      expect(throughputAnalysis).toHaveProperty('averageLatency');
      expect(throughputAnalysis).toHaveProperty('errorRate');
      expect(throughputAnalysis.messagesPerSecond).toBeGreaterThanOrEqual(0);
    });

    it('should detect message bottlenecks', async () => {
      const bottlenecks = await diagnosticTool.detectMessageBottlenecks();
      
      expect(Array.isArray(bottlenecks)).toBe(true);
      bottlenecks.forEach(bottleneck => {
        expect(bottleneck).toHaveProperty('location');
        expect(bottleneck).toHaveProperty('type');
        expect(bottleneck).toHaveProperty('severity');
        expect(bottleneck).toHaveProperty('suggestion');
      });
    });

    it('should analyze gossip protocol efficiency', async () => {
      const gossipAnalysis = await diagnosticTool.analyzeGossipEfficiency();
      
      expect(gossipAnalysis).toHaveProperty('convergenceTime');
      expect(gossipAnalysis).toHaveProperty('messageOverhead');
      expect(gossipAnalysis).toHaveProperty('replicationFactor');
      expect(gossipAnalysis).toHaveProperty('efficiency');
      expect(gossipAnalysis.efficiency).toBeGreaterThanOrEqual(0);
      expect(gossipAnalysis.efficiency).toBeLessThanOrEqual(1);
    });
  });

  describe('System Profiling', () => {
    it('should profile system performance', async () => {
      const profile = await diagnosticTool.profileSystemPerformance(5000); // 5 second profile
      
      expect(profile).toHaveProperty('duration');
      expect(profile).toHaveProperty('cpuProfile');
      expect(profile).toHaveProperty('memoryProfile');
      expect(profile).toHaveProperty('networkProfile');
      expect(profile.duration).toBeGreaterThan(0);
    });

    it('should identify performance hotspots', async () => {
      const hotspots = await diagnosticTool.identifyPerformanceHotspots();
      
      expect(Array.isArray(hotspots)).toBe(true);
      hotspots.forEach(hotspot => {
        expect(hotspot).toHaveProperty('component');
        expect(hotspot).toHaveProperty('metric');
        expect(hotspot).toHaveProperty('value');
        expect(hotspot).toHaveProperty('threshold');
        expect(hotspot).toHaveProperty('recommendation');
      });
    });

    it('should generate optimization suggestions', async () => {
      const suggestions = await diagnosticTool.generateOptimizationSuggestions();
      
      expect(Array.isArray(suggestions)).toBe(true);
      suggestions.forEach(suggestion => {
        expect(suggestion).toHaveProperty('category');
        expect(suggestion).toHaveProperty('priority');
        expect(suggestion).toHaveProperty('description');
        expect(suggestion).toHaveProperty('expectedImpact');
        expect(['low', 'medium', 'high', 'critical']).toContain(suggestion.priority);
      });
    });
  });

  describe('Reporting and Export', () => {
    it('should generate comprehensive diagnostic report', async () => {
      const report = await diagnosticTool.generateDiagnosticReport();
      
      expect(report).toHaveProperty('timestamp');
      expect(report).toHaveProperty('summary');
      expect(report).toHaveProperty('systemHealth');
      expect(report).toHaveProperty('performance');
      expect(report).toHaveProperty('cluster');
      expect(report).toHaveProperty('recommendations');
    });

    it('should export report in JSON format', async () => {
      const jsonReport = await diagnosticTool.exportReport('json');
      
      expect(typeof jsonReport).toBe('string');
      expect(() => JSON.parse(jsonReport)).not.toThrow();
      
      const parsedReport = JSON.parse(jsonReport);
      expect(parsedReport).toHaveProperty('version');
      expect(parsedReport).toHaveProperty('data');
    });

    it('should export report in CSV format', async () => {
      const csvReport = await diagnosticTool.exportReport('csv');
      
      expect(typeof csvReport).toBe('string');
      expect(csvReport).toContain(','); // Should contain CSV delimiters
      expect(csvReport.split('\n').length).toBeGreaterThan(1); // Should have headers and data
    });

    it('should export report in HTML format', async () => {
      const htmlReport = await diagnosticTool.exportReport('html');
      
      expect(typeof htmlReport).toBe('string');
      expect(htmlReport).toContain('<!DOCTYPE html>');
      expect(htmlReport).toContain('</html>');
    });
  });

  describe('Configuration and Customization', () => {
    it('should allow runtime configuration updates', () => {
      const newConfig = {
        enablePerformanceMetrics: false,
        reportingInterval: 10000
      };
      
      diagnosticTool.updateConfiguration(newConfig);
      const config = diagnosticTool.getConfiguration();
      
      expect(config.enablePerformanceMetrics).toBe(false);
      expect(config.reportingInterval).toBe(10000);
    });

    it('should validate configuration updates', () => {
      const invalidConfig = {
        reportingInterval: -1000 // Invalid negative interval
      };
      
      expect(() => diagnosticTool.updateConfiguration(invalidConfig))
        .toThrow('Reporting interval must be positive');
    });

    it('should expose current configuration', () => {
      const config = diagnosticTool.getConfiguration();
      
      expect(config).toHaveProperty('enablePerformanceMetrics');
      expect(config).toHaveProperty('enableHealthChecks');
      expect(config).toHaveProperty('reportingInterval');
      expect(config).toHaveProperty('enableLogging');
    });

    it('should allow custom health check registration', () => {
      const customCheck = {
        name: 'custom-service-check',
        check: async () => ({ status: 'healthy', message: 'Service is running' })
      };
      
      diagnosticTool.registerHealthCheck(customCheck);
      const checks = diagnosticTool.getRegisteredHealthChecks();
      
      expect(checks).toContain('custom-service-check');
    });
  });

  describe('Event Handling and Alerts', () => {
    it('should emit events for health status changes', async () => {
      const eventSpy = jest.fn();
      diagnosticTool.on('health-status-changed', eventSpy);
      
      // Simulate a health status change
      await diagnosticTool.simulateHealthStatusChange('degraded');
      
      expect(eventSpy).toHaveBeenCalledWith({
        previousStatus: 'healthy',
        currentStatus: 'degraded',
        timestamp: expect.any(Date)
      });
    });

    it('should emit alerts for performance anomalies', async () => {
      const alertSpy = jest.fn();
      diagnosticTool.on('performance-alert', alertSpy);
      
      // Simulate high CPU usage
      await diagnosticTool.simulateHighCpuUsage();
      
      expect(alertSpy).toHaveBeenCalledWith({
        type: 'high-cpu-usage',
        severity: 'warning',
        value: expect.any(Number),
        threshold: expect.any(Number),
        timestamp: expect.any(Date)
      });
    });

    it('should manage alert thresholds', () => {
      const thresholds = {
        cpuUsage: 80,
        memoryUsage: 85,
        diskUsage: 90
      };
      
      diagnosticTool.setAlertThresholds(thresholds);
      const currentThresholds = diagnosticTool.getAlertThresholds();
      
      expect(currentThresholds.cpuUsage).toBe(80);
      expect(currentThresholds.memoryUsage).toBe(85);
      expect(currentThresholds.diskUsage).toBe(90);
    });
  });

  describe('Integration and Lifecycle', () => {
    it('should start and stop gracefully', async () => {
      expect(diagnosticTool.getStatus()).toBe('initialized');
      
      await diagnosticTool.start();
      expect(diagnosticTool.getStatus()).toBe('running');
      
      await diagnosticTool.stop();
      expect(diagnosticTool.getStatus()).toBe('stopped');
    });

    it('should integrate with external monitoring systems', async () => {
      const monitoringConfig = {
        endpoint: 'http://monitoring.example.com/metrics',
        interval: 30000,
        format: 'prometheus'
      };
      
      await diagnosticTool.configureExternalMonitoring(monitoringConfig);
      expect(diagnosticTool.isExternalMonitoringEnabled()).toBe(true);
    });

    it('should handle graceful shutdown', async () => {
      await diagnosticTool.start();
      
      const shutdownPromise = diagnosticTool.gracefulShutdown();
      
      // Should complete shutdown within reasonable time
      await expect(shutdownPromise).resolves.toBeUndefined();
      expect(diagnosticTool.getStatus()).toBe('stopped');
    });
  });

  describe('Error Handling', () => {
    it('should handle health check failures gracefully', async () => {
      // Register a failing health check
      const failingCheck = {
        name: 'failing-check',
        check: async () => { throw new Error('Check failed'); }
      };
      
      diagnosticTool.registerHealthCheck(failingCheck);
      
      const healthReport = await diagnosticTool.checkSystemHealth();
      expect(healthReport.checks['failing-check']).toHaveProperty('error');
      expect(healthReport.status).toBe('degraded');
    });

    it('should handle metrics collection errors', async () => {
      // Should not throw when metrics collection fails
      await expect(diagnosticTool.collectPerformanceMetrics())
        .resolves.toBeDefined();
    });

    it('should handle invalid report format requests', async () => {
      await expect(diagnosticTool.exportReport('invalid-format' as any))
        .rejects.toThrow('Unsupported report format: invalid-format');
    });
  });
});
