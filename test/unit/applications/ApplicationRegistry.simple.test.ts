import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import { ApplicationRegistry } from '../../../src/applications/ApplicationRegistry';
import { ApplicationModule, ApplicationModuleConfig, ApplicationModuleContext, ModuleState, ApplicationModuleMetrics, ApplicationModuleDashboardData, ScalingStrategy } from '../../../src/applications/types';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { ResourceRegistry } from '../../../src/cluster/resources/ResourceRegistry';
import { ResourceTopologyManager } from '../../../src/cluster/topology/ResourceTopologyManager';
import { ResourceMetadata } from '../../../src/cluster/resources/types';

// Mock dependencies
const mockClusterManager = {
  getNodeId: () => 'test-node-1',
  isLeader: () => true
} as any;

const mockResourceRegistry = {
  getAllResources: () => []
} as any;

const mockTopologyManager = {
  getTopology: () => ({ nodes: [], resources: [] })
} as any;

// Simple mock ApplicationModule for testing
class SimpleTestModule implements ApplicationModule {
  moduleId: string;
  moduleName: string;
  moduleState: ModuleState = ModuleState.UNINITIALIZED;
  managedResourceTypes: string[];
  private config: ApplicationModuleConfig;

  constructor(moduleId: string, moduleName: string, resourceTypes: string[] = []) {
    this.moduleId = moduleId;
    this.moduleName = moduleName;
    this.managedResourceTypes = resourceTypes;
    this.config = {
      moduleId,
      moduleName,
      version: '1.0.0',
      resourceTypes: resourceTypes,
      dependencies: [],
      configuration: {}
    };
  }

  async initialize(context: ApplicationModuleContext): Promise<void> {
    this.moduleState = ModuleState.RUNNING;
  }

  async start(): Promise<void> {
    this.moduleState = ModuleState.RUNNING;
  }

  async stop(): Promise<void> {
    this.moduleState = ModuleState.STOPPED;
  }

  async createResource(metadata: Partial<ResourceMetadata>): Promise<ResourceMetadata> {
    return {
      resourceId: 'test-resource-1',
      resourceType: 'test-type',
      nodeId: 'test-node',
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
    // Simple mock implementation
  }

  async deleteResource(resourceId: string): Promise<void> {
    // Simple mock implementation
  }

  async getMetrics(): Promise<ApplicationModuleMetrics> {
    return {
      moduleId: this.moduleId,
      timestamp: Date.now(),
      state: this.moduleState,
      resourceCounts: { 'test-type': 1 },
      performance: {
        requestsPerSecond: 100,
        averageLatency: 10,
        errorRate: 0.01,
        uptime: 1000
      }
    };
  }

  async getDashboardData(): Promise<ApplicationModuleDashboardData> {
    return {
      moduleId: this.moduleId,
      moduleName: this.moduleName,
      state: this.moduleState,
      summary: {
        totalResources: 1,
        healthyResources: 1,
        activeConnections: 10,
        throughput: 100
      },
      charts: []
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; details?: any }> {
    return { healthy: this.moduleState === ModuleState.RUNNING };
  }

  async updateConfiguration(config: ApplicationModuleConfig): Promise<void> {
    this.config = config;
  }

  getConfiguration(): ApplicationModuleConfig {
    return this.config;
  }
}

describe('ApplicationRegistry - Basic Tests', () => {
  let registry: ApplicationRegistry;
  let testModule: SimpleTestModule;

  beforeEach(async () => {
    registry = new ApplicationRegistry(
      mockClusterManager,
      mockResourceRegistry,
      mockTopologyManager,
      { globalSetting: 'test' }
    );
    await registry.start();
    
    testModule = new SimpleTestModule('test-module', 'Test Module', ['test-resource']);
  });

  afterEach(async () => {
    await registry.stop();
  });

  describe('Registry Lifecycle', () => {
    test('should start and stop successfully', async () => {
      const newRegistry = new ApplicationRegistry(
        mockClusterManager,
        mockResourceRegistry,
        mockTopologyManager
      );

      await newRegistry.start();
      await newRegistry.stop();
      // If we get here without throwing, the test passes
      expect(true).toBe(true);
    });
  });

  describe('Module Registration', () => {
    test('should register a new module', async () => {
      await registry.registerModule(testModule);

      expect(registry.getModule('test-module')).toBe(testModule);
      expect(registry.getModuleState('test-module')).toBe(ModuleState.RUNNING);
    });

    test('should throw error when registering duplicate module', async () => {
      await registry.registerModule(testModule);

      const duplicateModule = new SimpleTestModule('test-module', 'Duplicate Module');
      
      await expect(registry.registerModule(duplicateModule))
        .rejects.toThrow('Module \'test-module\' is already registered');
    });

    test('should throw error when registering before start', async () => {
      const newRegistry = new ApplicationRegistry(
        mockClusterManager,
        mockResourceRegistry,
        mockTopologyManager
      );

      await expect(newRegistry.registerModule(testModule))
        .rejects.toThrow('ApplicationRegistry is not started. Call start() first.');
      
      await newRegistry.stop();
    });
  });

  describe('Module Unregistration', () => {
    beforeEach(async () => {
      await registry.registerModule(testModule);
    });

    test('should unregister existing module', async () => {
      await registry.unregisterModule('test-module');

      expect(registry.getModule('test-module')).toBeUndefined();
      expect(registry.getModuleState('test-module')).toBeUndefined();
    });

    test('should throw error when unregistering non-existent module', async () => {
      await expect(registry.unregisterModule('non-existent'))
        .rejects.toThrow('Module \'non-existent\' is not registered');
    });
  });

  describe('Module Retrieval', () => {
    beforeEach(async () => {
      await registry.registerModule(testModule);
    });

    test('should get module by ID', () => {
      const module = registry.getModule('test-module');
      expect(module).toBe(testModule);
    });

    test('should return undefined for non-existent module', () => {
      const module = registry.getModule('non-existent');
      expect(module).toBeUndefined();
    });

    test('should get all modules', () => {
      const allModules = registry.getAllModules();
      expect(allModules).toHaveLength(1);
      expect(allModules[0]).toBe(testModule);
    });

    test('should get modules by resource type', async () => {
      const chatModule = new SimpleTestModule('chat-module', 'Chat Module', ['chat-room', 'user-session']);
      await registry.registerModule(chatModule);

      const chatModules = registry.getModulesByResourceType('chat-room');
      expect(chatModules).toHaveLength(1);
      expect(chatModules[0]).toBe(chatModule);

      const emptyModules = registry.getModulesByResourceType('non-existent');
      expect(emptyModules).toHaveLength(0);
    });

    test('should get module configuration', () => {
      const config = registry.getModuleConfig('test-module');
      expect(config?.moduleId).toBe('test-module');
      expect(config?.moduleName).toBe('Test Module');
    });

    test('should get module state', () => {
      const state = registry.getModuleState('test-module');
      expect(state).toBe(ModuleState.RUNNING);
    });

    test('should get all module states', () => {
      const states = registry.getAllModuleStates();
      expect(states.get('test-module')).toBe(ModuleState.RUNNING);
      expect(states.size).toBe(1);
    });
  });

  describe('Health Monitoring', () => {
    test('should check if registry is healthy when all modules are healthy', async () => {
      await registry.registerModule(testModule);
      
      const isHealthy = await registry.isHealthy();
      expect(isHealthy).toBe(true);
    });

    test('should get comprehensive health status', async () => {
      await registry.registerModule(testModule);

      const healthStatus = await registry.getHealthStatus();
      
      expect(healthStatus.overall).toBe(true);
      expect(healthStatus.modules['test-module']).toEqual({ healthy: true });
    });
  });

  describe('Configuration Management', () => {
    beforeEach(async () => {
      await registry.registerModule(testModule);
    });

    test('should update global configuration', async () => {
      const newConfig = { newSetting: 'value', timeout: 10000 };
      await registry.updateGlobalConfiguration(newConfig);

      // Check that module received updated configuration
      const moduleConfig = registry.getModuleConfig('test-module');
      expect(moduleConfig?.configuration.newSetting).toBe('value');
    });
  });

  describe('Dependency Management', () => {
    test('should handle modules with dependencies', async () => {
      // Register base module first
      await registry.registerModule(testModule);

      // Create dependent module
      const dependentModule = new SimpleTestModule('dependent-module', 'Dependent Module');
      dependentModule.getConfiguration().dependencies = ['test-module'];

      await registry.registerModule(dependentModule);

      expect(registry.getModuleState('test-module')).toBe(ModuleState.RUNNING);
      expect(registry.getModuleState('dependent-module')).toBe(ModuleState.RUNNING);
    });

    test('should reject modules with missing dependencies', async () => {
      const dependentModule = new SimpleTestModule('dependent-module', 'Dependent Module');
      dependentModule.getConfiguration().dependencies = ['non-existent-module'];

      await expect(registry.registerModule(dependentModule))
        .rejects.toThrow('Module \'dependent-module\' depends on unregistered module \'non-existent-module\'');
    });

    test('should prevent unregistering modules with dependents', async () => {
      // Register base module
      await registry.registerModule(testModule);

      // Register dependent module
      const dependentModule = new SimpleTestModule('dependent-module', 'Dependent Module');
      dependentModule.getConfiguration().dependencies = ['test-module'];
      await registry.registerModule(dependentModule);

      await expect(registry.unregisterModule('test-module'))
        .rejects.toThrow('Cannot unregister module \'test-module\'. Dependent modules: dependent-module');
    });
  });

  describe('Module Context Creation', () => {
    test('should create proper module context during registration', async () => {
      let capturedContext: ApplicationModuleContext | undefined;
      
      // Create a module that captures the context
      class ContextCapturingModule extends SimpleTestModule {
        async initialize(context: ApplicationModuleContext): Promise<void> {
          capturedContext = context;
          await super.initialize(context);
        }
      }

      const contextModule = new ContextCapturingModule('context-module', 'Context Module');
      await registry.registerModule(contextModule);

      expect(capturedContext).toBeDefined();
      expect(capturedContext!.clusterManager).toBe(mockClusterManager);
      expect(capturedContext!.resourceRegistry).toBe(mockResourceRegistry);
      expect(capturedContext!.topologyManager).toBe(mockTopologyManager);
      expect(capturedContext!.moduleRegistry).toBe(registry);
      expect(capturedContext!.configuration.globalSetting).toBe('test');
      expect(capturedContext!.logger).toBeDefined();
      expect(typeof capturedContext!.logger.info).toBe('function');
    });
  });
});
