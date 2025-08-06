import { jest } from '@jest/globals';
import { ChatApplicationModule, ChatApplicationConfig } from '../../../src/applications/ChatApplicationModule';
import { ApplicationModuleContext, ModuleState } from '../../../src/applications/types';
import { ResourceState, ResourceHealth } from '../../../src/cluster/resources/types';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { ResourceRegistry } from '../../../src/cluster/resources/ResourceRegistry';
import { ResourceTopologyManager } from '../../../src/cluster/topology/ResourceTopologyManager';

// Mock dependencies
jest.mock('../../../src/cluster/ClusterManager');
jest.mock('../../../src/cluster/resources/ResourceRegistry');
jest.mock('../../../src/cluster/topology/ResourceTopologyManager');

describe('ChatApplicationModule', () => {
  let chatModule: ChatApplicationModule;
  let mockContext: ApplicationModuleContext;
  let mockClusterManager: jest.Mocked<ClusterManager>;
  let mockResourceRegistry: jest.Mocked<ResourceRegistry>;
  let mockTopologyManager: jest.Mocked<ResourceTopologyManager>;

  const defaultConfig: ChatApplicationConfig = {
    moduleId: 'chat-module',
    moduleName: 'Chat Application',
    version: '1.0.0',
    resourceTypes: ['chat-room'],
    configuration: {},
    maxRoomsPerNode: 1000,
    maxClientsPerRoom: 10000,
    messageRetentionDays: 7,
    autoScaling: {
      enabled: true,
      scaleUpThreshold: 0.8,
      scaleDownThreshold: 0.2,
      maxShards: 10
    },
    moderation: {
      enableAutoModeration: false,
      bannedWords: [],
      maxMessageLength: 1000,
      rateLimitPerMinute: 60
    }
  };

  beforeEach(() => {
    // Create mock implementations
    mockClusterManager = {
      localNodeId: 'node-1',
      getAliveMembers: jest.fn().mockReturnValue([]),
      transport: {
        send: jest.fn(),
        onMessage: jest.fn()
      }
    } as any;

    mockResourceRegistry = {
      registerResourceType: jest.fn(),
      createResource: jest.fn(),
      removeResource: jest.fn(),
      getResourcesByType: jest.fn().mockReturnValue([]),
      getResource: jest.fn(),
      updateResource: jest.fn(),
      on: jest.fn(),
      removeAllListeners: jest.fn()
    } as any;

    mockTopologyManager = {
      start: jest.fn(),
      stop: jest.fn(),
      getResourceTopology: jest.fn(),
      on: jest.fn(),
      removeAllListeners: jest.fn()
    } as any;

    mockContext = {
      clusterManager: mockClusterManager,
      resourceRegistry: mockResourceRegistry,
      topologyManager: mockTopologyManager,
      moduleRegistry: {
        registerModule: jest.fn(),
        unregisterModule: jest.fn(),
        getModule: jest.fn(),
        getAllModules: jest.fn().mockReturnValue([]),
        getModulesByResourceType: jest.fn().mockReturnValue([])
      } as any,
      configuration: {},
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      }
    };

    chatModule = new ChatApplicationModule(defaultConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should create ChatApplicationModule with valid config', () => {
      expect(chatModule).toBeInstanceOf(ChatApplicationModule);
      expect(chatModule.moduleId).toBe('chat-module');
      expect(chatModule.moduleName).toBe('Chat Application');
    });

    it('should initialize with context', async () => {
      await chatModule.initialize(mockContext);

      expect(mockResourceRegistry.registerResourceType).toHaveBeenCalled();
      expect(chatModule.moduleState).toBe(ModuleState.RUNNING);
    });
  });

  describe('Module Lifecycle', () => {
    beforeEach(async () => {
      await chatModule.initialize(mockContext);
    });

    it('should start successfully', async () => {
      await chatModule.start();
      // Module should emit started event
    });

    it('should stop successfully', async () => {
      await chatModule.start();
      await chatModule.stop();
      expect(chatModule.moduleState).toBe(ModuleState.STOPPED);
    });

    it('should handle health checks', async () => {
      await chatModule.start();
      
      const health = await chatModule.healthCheck();
      
      expect(health.healthy).toBe(true);
      expect(health.details).toBeDefined();
    });
  });

  describe('Room Management', () => {
    beforeEach(async () => {
      await chatModule.initialize(mockContext);
      await chatModule.start();
    });

    it('should create room successfully', async () => {
      const roomMetadata = {
        resourceType: 'chat-room' as const,
        applicationData: {
          roomName: 'Test Room',
          maxParticipants: 100,
          participantCount: 0,
          messageRate: 0,
          isPublic: true,
          created: Date.now(),
          lastActivity: Date.now()
        }
      };

      mockResourceRegistry.createResource.mockResolvedValue({
        resourceId: 'test-room',
        resourceType: 'chat-room',
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 0, maximum: 100, unit: 'participants' },
        performance: { latency: 0, throughput: 0, errorRate: 0 },
        distribution: {},
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY,
        applicationData: roomMetadata.applicationData
      });

      const result = await chatModule.createResource(roomMetadata);

      expect(result).toBeDefined();
      expect(mockResourceRegistry.createResource).toHaveBeenCalled();
    });

    it('should delete room successfully', async () => {
      const roomId = 'test-room';
      
      // First create a room
      chatModule['rooms'].set(roomId, {
        resourceId: roomId,
        resourceType: 'chat-room',
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 0, maximum: 100, unit: 'participants' },
        performance: { latency: 0, throughput: 0, errorRate: 0 },
        distribution: {},
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY,
        applicationData: {
          roomName: 'Test Room',
          maxParticipants: 100,
          participantCount: 0,
          messageRate: 0,
          isPublic: true,
          created: Date.now(),
          lastActivity: Date.now()
        }
      });
      
      mockResourceRegistry.removeResource.mockResolvedValue();

      await chatModule.deleteResource(roomId);

      expect(mockResourceRegistry.removeResource).toHaveBeenCalledWith(roomId);
    });

    it('should create room with ChatApplicationModule method', async () => {
      const roomName = 'Test Room';
      const isPublic = false;

      mockResourceRegistry.createResource.mockResolvedValue({
        resourceId: 'test-room-created',
        resourceType: 'chat-room',
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 0, maximum: 500, unit: 'participants' },
        performance: { latency: 0, throughput: 0, errorRate: 0 },
        distribution: {},
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY,
        applicationData: {
          roomName,
          maxParticipants: 1000,
          participantCount: 0,
          messageRate: 0,
          isPublic,
          created: Date.now(),
          lastActivity: Date.now()
        }
      });

      const result = await chatModule.createRoom(roomName, isPublic);

      expect(result).toBeDefined();
      expect(result.applicationData.roomName).toBe('Test Room');
      expect(result.applicationData.isPublic).toBe(false);
    });
  });

  describe('Metrics and Monitoring', () => {
    beforeEach(async () => {
      await chatModule.initialize(mockContext);
      await chatModule.start();
    });

    it('should collect module metrics', async () => {
      const metrics = await chatModule.getMetrics();

      expect(metrics).toBeDefined();
      expect(metrics.moduleId).toBe('chat-module');
      expect(metrics.state).toBe(ModuleState.RUNNING);
      expect(typeof metrics.performance.requestsPerSecond).toBe('number');
    });

    it('should provide dashboard data', async () => {
      const dashboardData = await chatModule.getDashboardData();

      expect(dashboardData).toBeDefined();
      expect(dashboardData.moduleId).toBe('chat-module');
      expect(dashboardData.moduleName).toBe('Chat Application');
      expect(Array.isArray(dashboardData.charts)).toBe(true);
    });
  });

  describe('Configuration Updates', () => {
    beforeEach(async () => {
      await chatModule.initialize(mockContext);
      await chatModule.start();
    });

    it('should update configuration', async () => {
      const newConfig = {
        configuration: {
          maxRoomsPerNode: 2000,
          autoScaling: {
            enabled: false,
            scaleUpThreshold: 0.9,
            scaleDownThreshold: 0.1,
            maxShards: 5
          }
        }
      };

      await chatModule.updateConfiguration(newConfig);

      const currentConfig = chatModule.getConfiguration();
      expect(currentConfig.configuration.maxRoomsPerNode).toBe(2000);
    });
  });

  describe('Resource Scaling', () => {
    beforeEach(async () => {
      await chatModule.initialize(mockContext);
      await chatModule.start();
    });

    it('should handle resource scaling', async () => {
      const resourceId = 'test-room';
      const scalingStrategy = {
        type: 'auto' as const,
        triggers: {
          cpuThreshold: 0.7,
          memoryThreshold: 0.8
        },
        actions: {
          scaleUp: {
            enabled: true,
            maxInstances: 10,
            cooldownPeriod: 300000
          },
          scaleDown: {
            enabled: true,
            minInstances: 1,
            cooldownPeriod: 600000
          }
        }
      };

      // Mock existing resource
      chatModule['rooms'].set(resourceId, {
        resourceId,
        resourceType: 'chat-room',
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 50, maximum: 100, unit: 'participants' },
        performance: { latency: 100, throughput: 10, errorRate: 0.01 },
        distribution: {},
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY,
        applicationData: {
          roomName: 'Test Room',
          maxParticipants: 100,
          participantCount: 50,
          messageRate: 10,
          isPublic: true,
          created: Date.now(),
          lastActivity: Date.now()
        }
      });

      await expect(chatModule.scaleResource(resourceId, scalingStrategy)).resolves.not.toThrow();
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      await chatModule.initialize(mockContext);
      await chatModule.start();
    });

    it('should handle resource registry errors', async () => {
      mockResourceRegistry.createResource.mockRejectedValue(new Error('Registry error'));

      await expect(chatModule.createResource({
        resourceType: 'chat-room' as const,
        applicationData: {
          roomName: 'Error Room',
          maxParticipants: 100,
          participantCount: 0,
          messageRate: 0,
          isPublic: true,
          created: Date.now(),
          lastActivity: Date.now()
        }
      })).rejects.toThrow('Registry error');
    });

    it('should handle invalid module state transitions', async () => {
      // Try to start without initialization
      const uninitializedModule = new ChatApplicationModule(defaultConfig);
      
      await expect(uninitializedModule.start()).rejects.toThrow();
    });
  });
});
