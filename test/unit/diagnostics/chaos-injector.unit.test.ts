import { ChaosInjector } from '../../../src/diagnostics/ChaosInjector';

describe('ChaosInjector Unit Tests', () => {
  let chaosInjector: ChaosInjector;

  beforeEach(() => {
    chaosInjector = new ChaosInjector();
  });

  afterEach(() => {
    // Clean up any active chaos scenarios
    if (chaosInjector && typeof chaosInjector.stopAll === 'function') {
      chaosInjector.stopAll();
    }
  });

  describe('Construction and Initialization', () => {
    it('should create a new ChaosInjector instance', () => {
      expect(chaosInjector).toBeInstanceOf(ChaosInjector);
    });

    it('should initialize with default configuration', () => {
      expect(chaosInjector).toBeDefined();
      // Test that the injector starts in a clean state
      expect(typeof chaosInjector.isActive).toBe('function');
      expect(chaosInjector.isActive()).toBe(false);
    });

    it('should accept custom configuration', () => {
      const config = {
        defaultFailureRate: 0.1,
        enableLogging: true,
        maxConcurrentChaos: 5
      };
      
      const customInjector = new ChaosInjector(config);
      expect(customInjector).toBeInstanceOf(ChaosInjector);
    });
  });

  describe('Network Failure Injection', () => {
    it('should inject network latency', async () => {
      const latencyMs = 100;
      
      await chaosInjector.injectNetworkLatency(latencyMs);
      
      expect(chaosInjector.isActive()).toBe(true);
      expect(chaosInjector.getActiveScenarios()).toContain('network-latency');
    });

    it('should inject network packet loss', async () => {
      const lossRate = 0.1; // 10% packet loss
      
      await chaosInjector.injectPacketLoss(lossRate);
      
      expect(chaosInjector.isActive()).toBe(true);
      expect(chaosInjector.getActiveScenarios()).toContain('packet-loss');
    });

    it('should inject network partition', async () => {
      const nodeIds = ['node-1', 'node-2'];
      
      await chaosInjector.injectNetworkPartition(nodeIds);
      
      expect(chaosInjector.isActive()).toBe(true);
      expect(chaosInjector.getActiveScenarios()).toContain('network-partition');
    });

    it('should reject invalid latency values', async () => {
      await expect(chaosInjector.injectNetworkLatency(-1))
        .rejects.toThrow('Latency must be non-negative');
      
      await expect(chaosInjector.injectNetworkLatency(NaN))
        .rejects.toThrow('Latency must be a valid number');
    });

    it('should reject invalid packet loss rates', async () => {
      await expect(chaosInjector.injectPacketLoss(-0.1))
        .rejects.toThrow('Packet loss rate must be between 0 and 1');
      
      await expect(chaosInjector.injectPacketLoss(1.5))
        .rejects.toThrow('Packet loss rate must be between 0 and 1');
    });
  });

  describe('Node Failure Injection', () => {
    it('should inject node crashes', async () => {
      const nodeId = 'test-node-1';
      
      await chaosInjector.injectNodeCrash(nodeId);
      
      expect(chaosInjector.isActive()).toBe(true);
      expect(chaosInjector.getActiveScenarios()).toContain('node-crash');
    });

    it('should inject memory pressure', async () => {
      const nodeId = 'test-node-1';
      const pressureLevel = 0.8; // 80% memory usage
      
      await chaosInjector.injectMemoryPressure(nodeId, pressureLevel);
      
      expect(chaosInjector.isActive()).toBe(true);
      expect(chaosInjector.getActiveScenarios()).toContain('memory-pressure');
    });

    it('should inject CPU stress', async () => {
      const nodeId = 'test-node-1';
      const cpuLoad = 0.9; // 90% CPU usage
      
      await chaosInjector.injectCpuStress(nodeId, cpuLoad);
      
      expect(chaosInjector.isActive()).toBe(true);
      expect(chaosInjector.getActiveScenarios()).toContain('cpu-stress');
    });

    it('should reject invalid memory pressure values', async () => {
      const nodeId = 'test-node-1';
      
      await expect(chaosInjector.injectMemoryPressure(nodeId, -0.1))
        .rejects.toThrow('Memory pressure must be between 0 and 1');
      
      await expect(chaosInjector.injectMemoryPressure(nodeId, 1.5))
        .rejects.toThrow('Memory pressure must be between 0 and 1');
    });

    it('should reject invalid CPU load values', async () => {
      const nodeId = 'test-node-1';
      
      await expect(chaosInjector.injectCpuStress(nodeId, -0.1))
        .rejects.toThrow('CPU load must be between 0 and 1');
      
      await expect(chaosInjector.injectCpuStress(nodeId, 1.5))
        .rejects.toThrow('CPU load must be between 0 and 1');
    });
  });

  describe('Message Failure Injection', () => {
    it('should inject message drops', async () => {
      const dropRate = 0.2; // 20% message drop rate
      
      await chaosInjector.injectMessageDrop(dropRate);
      
      expect(chaosInjector.isActive()).toBe(true);
      expect(chaosInjector.getActiveScenarios()).toContain('message-drop');
    });

    it('should inject message corruption', async () => {
      const corruptionRate = 0.05; // 5% message corruption rate
      
      await chaosInjector.injectMessageCorruption(corruptionRate);
      
      expect(chaosInjector.isActive()).toBe(true);
      expect(chaosInjector.getActiveScenarios()).toContain('message-corruption');
    });

    it('should inject message duplication', async () => {
      const duplicationRate = 0.1; // 10% message duplication rate
      
      await chaosInjector.injectMessageDuplication(duplicationRate);
      
      expect(chaosInjector.isActive()).toBe(true);
      expect(chaosInjector.getActiveScenarios()).toContain('message-duplication');
    });

    it('should reject invalid message drop rates', async () => {
      await expect(chaosInjector.injectMessageDrop(-0.1))
        .rejects.toThrow('Message drop rate must be between 0 and 1');
      
      await expect(chaosInjector.injectMessageDrop(1.5))
        .rejects.toThrow('Message drop rate must be between 0 and 1');
    });
  });

  describe('Scenario Management', () => {
    it('should track active scenarios', async () => {
      expect(chaosInjector.getActiveScenarios()).toEqual([]);
      
      await chaosInjector.injectNetworkLatency(50);
      expect(chaosInjector.getActiveScenarios()).toContain('network-latency');
      
      await chaosInjector.injectPacketLoss(0.1);
      expect(chaosInjector.getActiveScenarios()).toContain('packet-loss');
      expect(chaosInjector.getActiveScenarios()).toHaveLength(2);
    });

    it('should stop individual scenarios', async () => {
      await chaosInjector.injectNetworkLatency(50);
      await chaosInjector.injectPacketLoss(0.1);
      
      expect(chaosInjector.getActiveScenarios()).toHaveLength(2);
      
      await chaosInjector.stopScenario('network-latency');
      expect(chaosInjector.getActiveScenarios()).not.toContain('network-latency');
      expect(chaosInjector.getActiveScenarios()).toContain('packet-loss');
    });

    it('should stop all scenarios', async () => {
      await chaosInjector.injectNetworkLatency(50);
      await chaosInjector.injectPacketLoss(0.1);
      await chaosInjector.injectNodeCrash('test-node');
      
      expect(chaosInjector.getActiveScenarios()).toHaveLength(3);
      
      await chaosInjector.stopAll();
      expect(chaosInjector.getActiveScenarios()).toEqual([]);
      expect(chaosInjector.isActive()).toBe(false);
    });

    it('should prevent duplicate scenarios', async () => {
      await chaosInjector.injectNetworkLatency(50);
      
      // Attempting to inject the same scenario should update, not duplicate
      await chaosInjector.injectNetworkLatency(100);
      
      const activeScenarios = chaosInjector.getActiveScenarios();
      const latencyCount = activeScenarios.filter(s => s === 'network-latency').length;
      expect(latencyCount).toBe(1);
    });
  });

  describe('Configuration and Settings', () => {
    it('should allow runtime configuration updates', () => {
      const newConfig = {
        defaultFailureRate: 0.2,
        enableLogging: false
      };
      
      chaosInjector.updateConfiguration(newConfig);
      const config = chaosInjector.getConfiguration();
      
      expect(config.defaultFailureRate).toBe(0.2);
      expect(config.enableLogging).toBe(false);
    });

    it('should validate configuration updates', () => {
      const invalidConfig = {
        defaultFailureRate: -0.1 // Invalid negative rate
      };
      
      expect(() => chaosInjector.updateConfiguration(invalidConfig))
        .toThrow('Default failure rate must be between 0 and 1');
    });

    it('should expose current configuration', () => {
      const config = chaosInjector.getConfiguration();
      
      expect(config).toHaveProperty('defaultFailureRate');
      expect(config).toHaveProperty('enableLogging');
      expect(config).toHaveProperty('maxConcurrentChaos');
    });
  });

  describe('Event Handling and Monitoring', () => {
    it('should emit events when scenarios start', async () => {
      const eventSpy = jest.fn();
      chaosInjector.on('scenario-started', eventSpy);
      
      await chaosInjector.injectNetworkLatency(50);
      
      expect(eventSpy).toHaveBeenCalledWith({
        type: 'network-latency',
        parameters: { latencyMs: 50 },
        timestamp: expect.any(Date)
      });
    });

    it('should emit events when scenarios stop', async () => {
      const eventSpy = jest.fn();
      chaosInjector.on('scenario-stopped', eventSpy);
      
      await chaosInjector.injectNetworkLatency(50);
      await chaosInjector.stopScenario('network-latency');
      
      expect(eventSpy).toHaveBeenCalledWith({
        type: 'network-latency',
        timestamp: expect.any(Date)
      });
    });

    it('should provide scenario statistics', async () => {
      await chaosInjector.injectNetworkLatency(50);
      await chaosInjector.injectPacketLoss(0.1);
      
      const stats = chaosInjector.getStatistics();
      
      expect(stats).toHaveProperty('totalScenariosStarted');
      expect(stats).toHaveProperty('activeScenariosCount');
      expect(stats).toHaveProperty('scenarioTypes');
      expect(stats.activeScenariosCount).toBe(2);
    });
  });

  describe('Integration with Transport Layer', () => {
    it('should intercept network operations when active', async () => {
      // This would test integration with the transport layer
      // For now, we test the interface
      expect(typeof chaosInjector.shouldInterceptMessage).toBe('function');
      expect(typeof chaosInjector.shouldDelayMessage).toBe('function');
      expect(typeof chaosInjector.shouldDropMessage).toBe('function');
    });

    it('should calculate message delays correctly', async () => {
      await chaosInjector.injectNetworkLatency(100);
      
      const delay = chaosInjector.calculateMessageDelay();
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(200); // Assuming some variance
    });

    it('should determine message dropping correctly', async () => {
      await chaosInjector.injectMessageDrop(0.5);
      
      // Test multiple times due to randomness
      const results = Array.from({ length: 100 }, () => 
        chaosInjector.shouldDropMessage()
      );
      
      const dropCount = results.filter(dropped => dropped).length;
      // Should be approximately 50 drops out of 100, allow for variance
      expect(dropCount).toBeGreaterThan(30);
      expect(dropCount).toBeLessThan(70);
    });
  });

  describe('Error Handling', () => {
    it('should handle scenario startup failures gracefully', async () => {
      // Test with an invalid scenario type
      await expect(chaosInjector.startScenario('invalid-scenario', {}))
        .rejects.toThrow('Unknown scenario type: invalid-scenario');
    });

    it('should handle stopping non-existent scenarios gracefully', async () => {
      // Should not throw when stopping a scenario that doesn't exist
      await expect(chaosInjector.stopScenario('non-existent'))
        .resolves.not.toThrow();
    });

    it('should maintain consistency during concurrent operations', async () => {
      // Start multiple scenarios concurrently
      const promises = [
        chaosInjector.injectNetworkLatency(50),
        chaosInjector.injectPacketLoss(0.1),
        chaosInjector.injectNodeCrash('test-node')
      ];
      
      await Promise.all(promises);
      
      expect(chaosInjector.getActiveScenarios()).toHaveLength(3);
      expect(chaosInjector.isActive()).toBe(true);
    });
  });
});
