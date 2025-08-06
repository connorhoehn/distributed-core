import { ChatTopologyManager, RoomMetadata } from '../../../src/applications/chat/ChatTopologyManager';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { StateAggregator } from '../../../src/cluster/aggregation/StateAggregator';
import { MetricsTracker } from '../../../src/monitoring/metrics/MetricsTracker';
import { ResourceTopologyManager } from '../../../src/cluster/topology/ResourceTopologyManager';
import { ResourceRegistry } from '../../../src/cluster/resources/ResourceRegistry';
import { ResourceState, ResourceHealth } from '../../../src/cluster/resources/types';

// Mock dependencies
jest.mock('../../../src/cluster/ClusterManager');
jest.mock('../../../src/cluster/aggregation/StateAggregator');
jest.mock('../../../src/monitoring/metrics/MetricsTracker');
jest.mock('../../../src/cluster/topology/ResourceTopologyManager');
jest.mock('../../../src/cluster/resources/ResourceRegistry');

describe('ChatTopologyManager', () => {
  let chatTopologyManager: ChatTopologyManager;
  let mockClusterManager: jest.Mocked<ClusterManager>;
  let mockStateAggregator: jest.Mocked<StateAggregator>;
  let mockMetricsTracker: jest.Mocked<MetricsTracker>;
  let mockResourceTopologyManager: jest.Mocked<ResourceTopologyManager>;
  let mockResourceRegistry: jest.Mocked<ResourceRegistry>;

  beforeEach(() => {
    // Create mocks
    mockClusterManager = {
      localNodeId: 'node-1',
      getAliveMembers: jest.fn().mockReturnValue([
        { id: 'node-1', metadata: { region: 'us-east-1', zone: 'us-east-1a' } },
        { id: 'node-2', metadata: { region: 'us-east-1', zone: 'us-east-1b' } }
      ]),
      on: jest.fn(),
      removeAllListeners: jest.fn()
    } as any;

    mockStateAggregator = {
      collectClusterState: jest.fn()
    } as any;

    mockMetricsTracker = {
      getGaugeValue: jest.fn().mockReturnValue(0),
      setGauge: jest.fn(),
      incrementCounter: jest.fn()
    } as any;

    mockResourceTopologyManager = {
      getResourceTopology: jest.fn().mockResolvedValue({
        timestamp: Date.now(),
        clusterHealth: { status: 'healthy', score: 0.95 },
        nodes: [
          {
            nodeId: 'node-1',
            region: 'us-east-1',
            zone: 'us-east-1a',
            role: 'worker',
            health: { status: 'healthy', lastHeartbeat: Date.now(), uptime: 3600, errorRate: 0, responseTime: 10 }
          },
          {
            nodeId: 'node-2',
            region: 'us-east-1',
            zone: 'us-east-1b',
            role: 'worker',
            health: { status: 'healthy', lastHeartbeat: Date.now(), uptime: 3600, errorRate: 0, responseTime: 12 }
          }
        ],
        resources: {
          byType: new Map(),
          byNode: new Map(),
          total: 0,
          healthy: 0,
          degraded: 0,
          unhealthy: 0
        },
        distribution: {
          strategy: 'ROUND_ROBIN' as any,
          replicationFactor: 1,
          shardingEnabled: false,
          loadBalancing: 'least-loaded' as any
        },
        performance: {
          averageLatency: 10,
          totalThroughput: 1000,
          errorRate: 0.01,
          utilizationRate: 0.6
        },
        recommendations: []
      })
    } as any;

    mockResourceRegistry = {
      createResource: jest.fn(),
      removeResource: jest.fn(),
      getResourcesByType: jest.fn().mockReturnValue([]),
      getResourcesByNode: jest.fn().mockReturnValue([]),
      on: jest.fn(),
      removeAllListeners: jest.fn()
    } as any;

    chatTopologyManager = new ChatTopologyManager(
      mockClusterManager,
      mockStateAggregator,
      mockMetricsTracker,
      mockResourceTopologyManager,
      mockResourceRegistry
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should create ChatTopologyManager', () => {
      expect(chatTopologyManager).toBeInstanceOf(ChatTopologyManager);
    });

    it('should start successfully', async () => {
      await chatTopologyManager.start();
      
      expect(mockClusterManager.on).toHaveBeenCalledWith('member-joined', expect.any(Function));
      expect(mockClusterManager.on).toHaveBeenCalledWith('member-left', expect.any(Function));
      expect(mockResourceRegistry.on).toHaveBeenCalledWith('resource:created', expect.any(Function));
    });

    it('should stop successfully', async () => {
      await chatTopologyManager.start();
      await chatTopologyManager.stop();
      
      expect(mockClusterManager.removeAllListeners).toHaveBeenCalled();
      expect(mockResourceRegistry.removeAllListeners).toHaveBeenCalled();
    });
  });

  describe('Room Registration', () => {
    const mockRoomMetadata: RoomMetadata = {
      roomId: 'test-room',
      ownerNode: 'node-1',
      participantCount: 5,
      messageRate: 10,
      created: Date.now(),
      lastActivity: Date.now(),
      sharding: {
        enabled: false,
        maxParticipants: 1000,
        shardingStrategy: 'participant-count'
      },
      highAvailability: {
        enabled: false,
        replicationFactor: 1,
        regions: ['us-east-1'],
        zones: ['us-east-1a'],
        requirements: {
          crossRegion: false,
          crossZone: false,
          isolation: 'none'
        }
      },
      roomType: {
        type: 'chat',
        capabilities: ['messaging'],
        permissions: {
          canPost: ['*'],
          canView: ['*']
        }
      },
      performance: {
        priority: 'normal',
        expectedLoad: 100,
        maxLatency: 500,
        guaranteedDelivery: false
      },
      geographic: {}
    };

    beforeEach(async () => {
      await chatTopologyManager.start();
    });

    it('should register room successfully', async () => {
      mockResourceRegistry.createResource.mockResolvedValue({
        resourceId: 'test-room',
        resourceType: 'chat-room',
        nodeId: 'node-1',
        timestamp: Date.now(),
        capacity: { current: 5, maximum: 1000, unit: 'participants' },
        performance: { latency: 500, throughput: 10, errorRate: 0 },
        distribution: { replicationFactor: 1 },
        state: ResourceState.ACTIVE,
        health: ResourceHealth.HEALTHY,
        applicationData: mockRoomMetadata
      });

      await chatTopologyManager.registerRoom(mockRoomMetadata);

      expect(mockResourceRegistry.createResource).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: 'test-room',
          resourceType: 'chat-room'
        })
      );
    });

    it('should unregister room successfully', async () => {
      await chatTopologyManager.registerRoom(mockRoomMetadata);
      await chatTopologyManager.unregisterRoom('test-room');

      expect(mockResourceRegistry.removeResource).toHaveBeenCalledWith('test-room');
    });
  });

  describe('Chat Topology Analysis', () => {
    beforeEach(async () => {
      await chatTopologyManager.start();
    });

    it('should get chat cluster topology', async () => {
      const topology = await chatTopologyManager.getChatClusterTopology();

      expect(topology).toBeDefined();
      expect(topology.totalNodes).toBe(2);
      expect(topology.aliveNodes).toBe(2);
      expect(topology.rooms).toBeDefined();
      expect(topology.rooms.total).toBe(0);
      expect(topology.timestamp).toBeDefined();
    });

    it('should calculate room distribution', async () => {
      // Mock some chat rooms
      mockResourceRegistry.getResourcesByType.mockReturnValue([
        {
          resourceId: 'room-1',
          resourceType: 'chat-room',
          nodeId: 'node-1',
          timestamp: Date.now(),
          capacity: { current: 10, maximum: 100, unit: 'participants' },
          performance: { latency: 0, throughput: 0, errorRate: 0 },
          distribution: {},
          state: ResourceState.ACTIVE,
          health: ResourceHealth.HEALTHY,
          applicationData: { roomType: 'chat' }
        },
        {
          resourceId: 'room-2',
          resourceType: 'chat-room',
          nodeId: 'node-2',
          timestamp: Date.now(),
          capacity: { current: 15, maximum: 100, unit: 'participants' },
          performance: { latency: 0, throughput: 0, errorRate: 0 },
          distribution: {},
          state: ResourceState.ACTIVE,
          health: ResourceHealth.HEALTHY,
          applicationData: { roomType: 'broadcast' }
        }
      ]);

      const topology = await chatTopologyManager.getChatClusterTopology();

      expect(topology.rooms.total).toBe(2);
      expect(topology.rooms.byNode['node-1']).toBe(1);
      expect(topology.rooms.byNode['node-2']).toBe(1);
      expect(topology.rooms.byType['chat']).toBe(1);
      expect(topology.rooms.byType['broadcast']).toBe(1);
    });
  });

  describe('Room Placement Recommendations', () => {
    beforeEach(async () => {
      await chatTopologyManager.start();
    });

    it('should provide room placement recommendations', async () => {
      const recommendation = await chatTopologyManager.getRoomPlacementRecommendation({
        expectedParticipants: 100,
        expectedMessageRate: 50,
        regionPreference: 'us-east-1',
        haRequirements: false
      });

      expect(recommendation).toBeDefined();
      expect(recommendation.recommendedNode).toBeDefined();
      expect(Array.isArray(recommendation.reasoning)).toBe(true);
      expect(Array.isArray(recommendation.alternativeNodes)).toBe(true);
    });

    it('should consider high availability requirements', async () => {
      const recommendation = await chatTopologyManager.getRoomPlacementRecommendation({
        expectedParticipants: 100,
        expectedMessageRate: 50,
        haRequirements: true
      });

      expect(recommendation.reasoning).toContain('High availability requirements considered');
    });
  });

  describe('Scaling Recommendations', () => {
    beforeEach(async () => {
      await chatTopologyManager.start();
    });

    it('should generate chat scaling recommendations', async () => {
      const recommendations = await chatTopologyManager.getChatScalingRecommendations();

      expect(Array.isArray(recommendations)).toBe(true);
    });

    it('should recommend room sharding for large rooms', async () => {
      // Mock a large room
      chatTopologyManager['roomMetadata'].set('large-room', {
        roomId: 'large-room',
        ownerNode: 'node-1',
        participantCount: 15000, // Exceeds default threshold
        messageRate: 1500,
        created: Date.now(),
        lastActivity: Date.now(),
        sharding: { enabled: false, shardingStrategy: 'participant-count' },
        highAvailability: { enabled: false, replicationFactor: 1, regions: [], zones: [], requirements: { crossRegion: false, crossZone: false, isolation: 'none' } },
        roomType: { type: 'chat', capabilities: [], permissions: { canPost: [], canView: [] } },
        performance: { priority: 'normal', expectedLoad: 15000, maxLatency: 500, guaranteedDelivery: false },
        geographic: {}
      });

      const recommendations = await chatTopologyManager.getChatScalingRecommendations();

      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations[0].type).toBe('shard-room');
      expect(recommendations[0].target).toBe('large-room');
    });
  });

  describe('Health Monitoring', () => {
    beforeEach(async () => {
      await chatTopologyManager.start();
    });

    it('should calculate chat health score', async () => {
      const topology = await chatTopologyManager.getChatClusterTopology();

      expect(topology.overallHealth).toBeDefined();
      expect(topology.overallHealth.score).toBeGreaterThanOrEqual(0);
      expect(topology.overallHealth.score).toBeLessThanOrEqual(1);
      expect(['healthy', 'warning', 'critical']).toContain(topology.overallHealth.status);
    });
  });
});
