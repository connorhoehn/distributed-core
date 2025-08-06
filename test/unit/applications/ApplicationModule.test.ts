import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import { ApplicationModule } from '../../../src/applications/ApplicationModule';
import { ApplicationModuleConfig, ApplicationModuleContext, ModuleState, ApplicationModuleMetrics, ApplicationModuleDashboardData, ScalingStrategy } from '../../../src/applications/types';
import { ResourceMetadata, ResourceTypeDefinition, DistributionStrategy } from '../../../src/cluster/resources/types';

// Mock context dependencies
const mockContext: ApplicationModuleContext = {
  clusterManager: {
    getNodeId: () => 'test-node-1',
    isLeader: () => true
  } as any,
  resourceRegistry: {
    registerResourceType: jest.fn(),
    getResourcesByType: jest.fn().mockReturnValue([])
  } as any,
  topologyManager: {
    getTopology: () => ({ nodes: [], resources: [] })
  } as any,
  moduleRegistry: {} as any,
  configuration: { globalSetting: 'test' },
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
};

// Concrete test implementation of ApplicationModule
class TestApplicationModule extends ApplicationModule {
  private testMetrics: ApplicationModuleMetrics;
  private simulateError = false;

  constructor(config: ApplicationModuleConfig) {
    super(config);
    this.testMetrics = {
      moduleId: config.moduleId,
      timestamp: Date.now(),
      state: ModuleState.UNINITIALIZED,
      resourceCounts: { 'test-resource': 0 },
      performance: {
        requestsPerSecond: 100,
        averageLatency: 10,
        errorRate: 0.05,
        uptime: 1000
      }
    };
  }

  // Implementation of abstract methods
  async createResource(metadata: Partial<ResourceMetadata>): Promise<ResourceMetadata> {
    if (this.simulateError) throw new Error('Simulated create error');
    
    return {
      resourceId: metadata.resourceId || 'test-resource-1',
      resourceType: metadata.resourceType || 'test-resource',
      nodeId: metadata.nodeId || 'test-node',
      timestamp: Date.now(),
      capacity: { current: 50, maximum: 100, unit: 'items' },
      performance: { latency: 10, throughput: 100, errorRate: 0.1 },
      distribution: {},
      applicationData: {},
      state: 'ACTIVE' as any,
      health: 'HEALTHY' as any
    };
  }

  async scaleResource(resourceId: string, strategy: ScalingStrategy): Promise<void> {
    if (this.simulateError) throw new Error('Simulated scale error');
    // Mock implementation
  }

  async deleteResource(resourceId: string): Promise<void> {
    if (this.simulateError) throw new Error('Simulated delete error');
    // Mock implementation
  }

  async getMetrics(): Promise<ApplicationModuleMetrics> {
    return {
      ...this.testMetrics,
      state: this.state,
      timestamp: Date.now()
    };
  }

  async getDashboardData(): Promise<ApplicationModuleDashboardData> {
    return {
      moduleId: this.config.moduleId,
      moduleName: this.config.moduleName,
      state: this.state,
      summary: {
        totalResources: 1,
        healthyResources: 1,
        activeConnections: 10,
        throughput: 100
      },
      charts: [
        {
          title: 'Performance Metrics',
          type: 'line',
          data: { latency: [10, 12, 8, 15] }
        }
      ]
    };
  }

  // Implementation of protected abstract methods
  protected async onInitialize(context: ApplicationModuleContext): Promise<void> {
    if (this.simulateError) throw new Error('Simulated initialization error');
    // Custom initialization logic
    this.log('info', 'Test module initialized');
  }

  protected async onStart(): Promise<void> {
    if (this.simulateError) throw new Error('Simulated start error');
    this.log('info', 'Test module started');
  }

  protected async onStop(): Promise<void> {
    if (this.simulateError) throw new Error('Simulated stop error');
    this.log('info', 'Test module stopped');
  }

  protected async onConfigurationUpdate(newConfig: ApplicationModuleConfig): Promise<void> {
    if (this.simulateError) throw new Error('Simulated config update error');
    this.log('info', 'Test module configuration updated');
  }

  protected getResourceTypeDefinitions(): ResourceTypeDefinition[] {
    return [
      {
        typeName: 'test-resource',
        version: '1.0.0',
        defaultCapacity: {
          totalCapacity: 100,
          maxThroughput: 50,
          avgLatency: 10
        },
        capacityCalculator: (resource) => 50,
        healthChecker: (resource) => 'HEALTHY' as any,
        performanceMetrics: ['latency', 'throughput', 'errorRate'],
        defaultDistributionStrategy: DistributionStrategy.ROUND_ROBIN,
        distributionConstraints: [],
        serialize: (resource) => JSON.stringify(resource),
        deserialize: (data) => JSON.parse(data as string)
      }
    ];
  }

  // Test helper methods
  setSimulateError(simulate: boolean): void {
    this.simulateError = simulate;
  }

  setTestMetrics(metrics: Partial<ApplicationModuleMetrics>): void {
    this.testMetrics = { ...this.testMetrics, ...metrics };
  }
}

describe('ApplicationModule Base Class', () => {
  let module: TestApplicationModule;
  let config: ApplicationModuleConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    
    config = {
      moduleId: 'test-module',
      moduleName: 'Test Module',
      version: '1.0.0',
      resourceTypes: ['test-resource'],
      dependencies: [],
      configuration: { timeout: 5000 }
    };

    module = new TestApplicationModule(config);
  });

  describe('Lifecycle Management', () => {
    test('should initialize module successfully', async () => {
      const initializingSpy = jest.fn();
      const initializedSpy = jest.fn();
      
      module.on('module:initializing', initializingSpy);
      module.on('module:initialized', initializedSpy);

      await module.initialize(mockContext);

      expect(module.moduleState).toBe(ModuleState.RUNNING);
      expect(initializingSpy).toHaveBeenCalledWith('test-module');
      expect(initializedSpy).toHaveBeenCalledWith('test-module');
      expect(mockContext.resourceRegistry.registerResourceType).toHaveBeenCalled();
      expect(mockContext.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Registered resource type: test-resource'),
        expect.any(Object)
      );
    });

    test('should handle initialization errors', async () => {
      const errorSpy = jest.fn();
      module.on('module:error', errorSpy);
      
      module.setSimulateError(true);

      await expect(module.initialize(mockContext))
        .rejects.toThrow('Simulated initialization error');

      expect(module.moduleState).toBe(ModuleState.ERROR);
      expect(errorSpy).toHaveBeenCalledWith({
        moduleId: 'test-module',
        error: expect.any(Error)
      });
    });

    test('should start module after initialization', async () => {
      const startedSpy = jest.fn();
      module.on('module:started', startedSpy);

      await module.initialize(mockContext);
      await module.start();

      expect(startedSpy).toHaveBeenCalledWith('test-module');
      expect(mockContext.logger.info).toHaveBeenCalledWith(
        '[test-module] Test module started',
        undefined
      );
    });

    test('should throw error when starting uninitialized module', async () => {
      await expect(module.start())
        .rejects.toThrow('Module test-module is not initialized');
    });

    test('should stop module successfully', async () => {
      const stoppingSpy = jest.fn();
      const stoppedSpy = jest.fn();
      
      module.on('module:stopping', stoppingSpy);
      module.on('module:stopped', stoppedSpy);

      await module.initialize(mockContext);
      await module.stop();

      expect(module.moduleState).toBe(ModuleState.STOPPED);
      expect(stoppingSpy).toHaveBeenCalledWith('test-module');
      expect(stoppedSpy).toHaveBeenCalledWith('test-module');
    });

    test('should handle stop errors', async () => {
      const errorSpy = jest.fn();
      module.on('module:error', errorSpy);

      await module.initialize(mockContext);
      module.setSimulateError(true);

      await expect(module.stop())
        .rejects.toThrow('Simulated stop error');

      expect(module.moduleState).toBe(ModuleState.ERROR);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('Resource Management', () => {
    beforeEach(async () => {
      await module.initialize(mockContext);
    });

    test('should create resource successfully', async () => {
      const metadata = {
        resourceId: 'custom-resource',
        resourceType: 'test-resource'
      };

      const resource = await module.createResource(metadata);

      expect(resource.resourceId).toBe('custom-resource');
      expect(resource.resourceType).toBe('test-resource');
      expect(resource.capacity).toBeDefined();
      expect(resource.performance).toBeDefined();
    });

    test('should handle create resource errors', async () => {
      module.setSimulateError(true);

      await expect(module.createResource({}))
        .rejects.toThrow('Simulated create error');
    });

    test('should scale resource successfully', async () => {
      const strategy: ScalingStrategy = {
        type: 'manual',
        triggers: { cpuThreshold: 80 },
        actions: {
          scaleUp: { enabled: true, maxInstances: 10, cooldownPeriod: 5000 },
          scaleDown: { enabled: true, minInstances: 1, cooldownPeriod: 5000 }
        }
      };

      await expect(module.scaleResource('test-resource-1', strategy))
        .resolves.not.toThrow();
    });

    test('should delete resource successfully', async () => {
      await expect(module.deleteResource('test-resource-1'))
        .resolves.not.toThrow();
    });

    test('should get managed resources', async () => {
      const mockResources = [
        {
          resourceId: 'test-1',
          resourceType: 'test-resource',
          nodeId: 'node-1',
          timestamp: Date.now(),
          capacity: { current: 50, maximum: 100, unit: 'items' },
          performance: { latency: 10, throughput: 100, errorRate: 0.1 },
          distribution: {},
          applicationData: {},
          state: 'ACTIVE' as any,
          health: 'HEALTHY' as any
        }
      ];

      (mockContext.resourceRegistry.getResourcesByType as jest.Mock)
        .mockReturnValue(mockResources);

      const resources = await module.getResources();
      
      expect(resources).toEqual(mockResources);
      expect(mockContext.resourceRegistry.getResourcesByType)
        .toHaveBeenCalledWith('test-resource');
    });
  });

  describe('Monitoring and Observability', () => {
    beforeEach(async () => {
      await module.initialize(mockContext);
    });

    test('should get module metrics', async () => {
      const metrics = await module.getMetrics();

      expect(metrics.moduleId).toBe('test-module');
      expect(metrics.state).toBe(ModuleState.RUNNING);
      expect(metrics.performance).toBeDefined();
      expect(metrics.resourceCounts).toBeDefined();
    });

    test('should get dashboard data', async () => {
      const dashboardData = await module.getDashboardData();

      expect(dashboardData.moduleId).toBe('test-module');
      expect(dashboardData.moduleName).toBe('Test Module');
      expect(dashboardData.state).toBe(ModuleState.RUNNING);
      expect(dashboardData.summary).toBeDefined();
      expect(dashboardData.charts).toBeDefined();
      expect(dashboardData.charts).toHaveLength(1);
    });

    test('should perform health check successfully', async () => {
      module.setTestMetrics({
        performance: {
          requestsPerSecond: 100,
          averageLatency: 10,
          errorRate: 0.05, // Low error rate = healthy
          uptime: 5000
        }
      });

      const health = await module.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.details.state).toBe(ModuleState.RUNNING);
      expect(health.details.errorRate).toBe(0.05);
    });

    test('should detect unhealthy module with high error rate', async () => {
      module.setTestMetrics({
        performance: {
          requestsPerSecond: 100,
          averageLatency: 10,
          errorRate: 0.15, // High error rate = unhealthy
          uptime: 5000
        }
      });

      const health = await module.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.details.errorRate).toBe(0.15);
    });

    test('should handle health check errors', async () => {
      // Override getMetrics to throw error
      const originalGetMetrics = module.getMetrics.bind(module);
      module.getMetrics = async () => {
        throw new Error('Metrics error');
      };

      const health = await module.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.details.error).toBe('Metrics error');
      
      // Restore original method
      module.getMetrics = originalGetMetrics;
    });
  });

  describe('Configuration Management', () => {
    beforeEach(async () => {
      await module.initialize(mockContext);
    });

    test('should update configuration successfully', async () => {
      const configUpdatedSpy = jest.fn();
      module.on('module:configuration-updated', configUpdatedSpy);

      const newConfig = {
        moduleName: 'Updated Test Module',
        configuration: { timeout: 10000 }
      };

      await module.updateConfiguration(newConfig);

      expect(module.getConfiguration().moduleName).toBe('Updated Test Module');
      expect(module.getConfiguration().configuration.timeout).toBe(10000);
      expect(configUpdatedSpy).toHaveBeenCalledWith({
        moduleId: 'test-module',
        config: expect.objectContaining(newConfig)
      });
    });

    test('should handle configuration update errors', async () => {
      module.setSimulateError(true);

      await expect(module.updateConfiguration({}))
        .rejects.toThrow('Simulated config update error');
    });

    test('should return configuration copy', () => {
      const config1 = module.getConfiguration();
      const config2 = module.getConfiguration();

      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2); // Should be different objects
    });
  });

  describe('Property Getters', () => {
    test('should return correct module properties', () => {
      expect(module.moduleId).toBe('test-module');
      expect(module.moduleName).toBe('Test Module');
      expect(module.moduleState).toBe(ModuleState.UNINITIALIZED);
      expect(module.managedResourceTypes).toEqual(['test-resource']);
    });

    test('should return copy of managed resource types', () => {
      const types1 = module.managedResourceTypes;
      const types2 = module.managedResourceTypes;

      expect(types1).toEqual(types2);
      expect(types1).not.toBe(types2); // Should be different arrays
    });
  });

  describe('Logging Helper', () => {
    beforeEach(async () => {
      await module.initialize(mockContext);
    });

    test('should log messages with module prefix', () => {
      (module as any).log('info', 'Test message', { extra: 'data' });

      expect(mockContext.logger.info).toHaveBeenCalledWith(
        '[test-module] Test message',
        { extra: 'data' }
      );
    });

    test('should handle logging when context is not available', () => {
      const newModule = new TestApplicationModule(config);
      
      // Should not throw error
      expect(() => {
        (newModule as any).log('info', 'Test message');
      }).not.toThrow();
    });
  });
});
