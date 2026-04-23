import { EventEmitter } from 'events';
import { ClusterIntrospection } from '../../../../src/cluster/introspection/ClusterIntrospection';
import { IClusterManagerContext } from '../../../../src/cluster/core/IClusterManagerContext';
import { MembershipEntry, NodeInfo } from '../../../../src/cluster/types';
import { NodeHealthStatus } from '../../../../src/monitoring/FailureDetector';

// ---------------------------------------------------------------------------
// Minimal helpers
// ---------------------------------------------------------------------------

/**
 * Build a MembershipEntry from partial overrides so tests stay terse.
 */
function makeMember(
  id: string,
  status: MembershipEntry['status'] = 'ALIVE',
  extra: Partial<MembershipEntry> = {}
): MembershipEntry {
  return {
    id,
    status,
    version: 1,
    lastSeen: Date.now(),
    lastUpdated: Date.now(),
    metadata: { zone: 'zone-a', region: 'us-east-1' },
    ...extra
  };
}

/**
 * Build the minimal mock context that ClusterIntrospection delegates to.
 * All methods are jest.fn() so individual tests can override return values.
 */
function buildMockContext(
  members: MembershipEntry[] = [],
  aliveMembers: MembershipEntry[] = [],
  fdConfig: Partial<{ failureTimeout: number; heartbeatInterval: number }> = {}
): jest.Mocked<IClusterManagerContext> {
  const membershipEmitter = new EventEmitter();

  const membership = {
    getAllMembers: jest.fn<MembershipEntry[], []>(() => members),
    getAliveMembers: jest.fn<MembershipEntry[], []>(() => aliveMembers),
    getMember: jest.fn<MembershipEntry | undefined, [string]>(() => undefined),
    addLocalNode: jest.fn(),
    updateNode: jest.fn().mockReturnValue(true),
    clear: jest.fn(),
    on: membershipEmitter.on.bind(membershipEmitter),
    off: membershipEmitter.off.bind(membershipEmitter),
    emit: membershipEmitter.emit.bind(membershipEmitter),
    removeAllListeners: membershipEmitter.removeAllListeners.bind(membershipEmitter)
  } as unknown as jest.Mocked<IClusterManagerContext['membership']>;

  const fdStatus = {
    isRunning: true,
    monitoredNodes: [] as string[],
    healthStatuses: [] as NodeHealthStatus[],
    pendingPings: [] as string[],
    config: {
      heartbeatInterval: fdConfig.heartbeatInterval ?? 1000,
      failureTimeout: fdConfig.failureTimeout ?? 3000,
      deadTimeout: 6000,
      pingTimeout: 2000,
      maxMissedHeartbeats: 3,
      maxMissedPings: 2,
      enableActiveProbing: true,
      enableLogging: false
    },
    localSequenceNumber: 0
  };

  const failureDetector = {
    getStatus: jest.fn(() => fdStatus),
    start: jest.fn(),
    stop: jest.fn()
  } as unknown as jest.Mocked<IClusterManagerContext['failureDetector']>;

  const transport = {
    getConnectedNodes: jest.fn(() => []),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    onMessage: jest.fn(),
    removeMessageListener: jest.fn(),
    getLocalNodeInfo: jest.fn()
  } as unknown as jest.Mocked<IClusterManagerContext['transport']>;

  const localNodeInfo: NodeInfo = {
    id: 'local-node',
    status: 'ALIVE',
    version: 1,
    lastSeen: Date.now(),
    metadata: { address: '127.0.0.1', port: 3000 }
  };

  return {
    localNodeId: 'local-node',
    config: {
      gossipInterval: 1000,
      enableLogging: false,
      getSeedNodes: jest.fn().mockReturnValue([])
    } as unknown as jest.Mocked<IClusterManagerContext['config']>,
    membership,
    failureDetector,
    transport,
    keyManager: {} as jest.Mocked<IClusterManagerContext['keyManager']>,
    gossipStrategy: {} as jest.Mocked<IClusterManagerContext['gossipStrategy']>,
    hashRing: { rebuild: jest.fn() } as unknown as jest.Mocked<IClusterManagerContext['hashRing']>,
    recentUpdates: [],
    getLocalNodeInfo: jest.fn(() => localNodeInfo),
    addToRecentUpdates: jest.fn(),
    incrementVersion: jest.fn(),
    isBootstrapped: jest.fn().mockReturnValue(true),
    getClusterSize: jest.fn().mockReturnValue(members.length),
    rebuildHashRing: jest.fn(),
    joinCluster: jest.fn().mockResolvedValue(undefined),
    startGossipTimer: jest.fn(),
    stopGossipTimer: jest.fn(),
    sendImmediateGossip: jest.fn().mockResolvedValue(undefined),
    runAntiEntropyCycle: jest.fn()
  } as unknown as jest.Mocked<IClusterManagerContext>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClusterIntrospection', () => {
  let introspection: ClusterIntrospection;
  let mockContext: jest.Mocked<IClusterManagerContext>;

  afterEach(() => {
    introspection.destroy();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  describe('getTopologySnapshot()', () => {
    it('returns correct totalAliveNodes from membership', () => {
      const aliveMembers = [makeMember('n1'), makeMember('n2'), makeMember('n3')];
      mockContext = buildMockContext(aliveMembers, aliveMembers);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const topology = introspection.getTopology();

      expect(topology.totalAliveNodes).toBe(3);
    });

    it('returns empty rings when no alive members', () => {
      mockContext = buildMockContext([], []);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const topology = introspection.getTopology();

      expect(topology.totalAliveNodes).toBe(0);
      expect(topology.rings).toHaveLength(0);
    });

    it('includes a ring entry per alive node with 100 virtual nodes', () => {
      const aliveMembers = [makeMember('n1'), makeMember('n2')];
      mockContext = buildMockContext(aliveMembers, aliveMembers);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const topology = introspection.getTopology();

      expect(topology.rings).toHaveLength(2);
      topology.rings.forEach(r => expect(r.virtualNodes).toBe(100));
    });
  });

  // -------------------------------------------------------------------------
  describe('getHealthMetrics() / getClusterHealth()', () => {
    it('returns gossipRate > 0 when there are multiple members', () => {
      // gossipFanout = min(3, aliveCount - 1), gossipIntervalSec = 1000/1000 = 1
      // gossipRate = gossipFanout / gossipIntervalSec
      const aliveMembers = [makeMember('n1'), makeMember('n2'), makeMember('n3')];
      mockContext = buildMockContext(aliveMembers, aliveMembers);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const metrics = introspection.getPerformanceMetrics();

      // aliveCount=3, fanout=min(3,2)=2, interval=1s → gossipRate=2
      expect(metrics.gossipRate).toBeGreaterThan(0);
    });

    it('computes gossipRate using aliveCount * fanout / intervalSec formula', () => {
      // 4 alive nodes → fanout = min(3, 3) = 3; gossipInterval = 1000ms → 1s
      const aliveMembers = [makeMember('n1'), makeMember('n2'), makeMember('n3'), makeMember('n4')];
      mockContext = buildMockContext(aliveMembers, aliveMembers);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const metrics = introspection.getPerformanceMetrics();

      expect(metrics.gossipRate).toBe(3); // fanout=3, interval=1s
    });

    it('failureDetectionLatency comes from failureDetector config, not hardcoded', () => {
      const aliveMembers = [makeMember('n1'), makeMember('n2')];
      mockContext = buildMockContext(aliveMembers, aliveMembers, { failureTimeout: 7500 });
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const metrics = introspection.getPerformanceMetrics();

      expect(metrics.failureDetectionLatency).toBe(7500);
    });

    it('averageHeartbeatInterval comes from failureDetector config', () => {
      const aliveMembers = [makeMember('n1')];
      mockContext = buildMockContext(aliveMembers, aliveMembers, { heartbeatInterval: 2500 });
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const metrics = introspection.getPerformanceMetrics();

      expect(metrics.averageHeartbeatInterval).toBe(2500);
    });
  });

  // -------------------------------------------------------------------------
  describe('getPerformanceMetrics() — messageRate', () => {
    it('returns 0 messageRate when no connected nodes on first call', () => {
      const aliveMembers = [makeMember('n1')];
      mockContext = buildMockContext(aliveMembers, aliveMembers);
      (mockContext.transport.getConnectedNodes as jest.Mock).mockReturnValue([]);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const metrics = introspection.getPerformanceMetrics();

      // First call: lastMessageCount starts at 0, currentMessageCount=0 → rate=0
      expect(metrics.messageRate).toBe(0);
    });

    it('messageRate reflects connected peer count relative to baseline', () => {
      const aliveMembers = [makeMember('n1'), makeMember('n2')];
      mockContext = buildMockContext(aliveMembers, aliveMembers);
      // Return 4 connected nodes (non-zero current vs 0 initial baseline)
      (mockContext.transport.getConnectedNodes as jest.Mock).mockReturnValue([
        { id: 'n2', address: '127.0.0.1', port: 3001 },
        { id: 'n3', address: '127.0.0.1', port: 3002 },
        { id: 'n4', address: '127.0.0.1', port: 3003 },
        { id: 'n5', address: '127.0.0.1', port: 3004 }
      ]);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const metrics = introspection.getPerformanceMetrics();

      // messageRate = max(0, 4 - 0) / 5 = 0.8
      expect(metrics.messageRate).toBeCloseTo(0.8);
    });
  });

  // -------------------------------------------------------------------------
  describe('getStabilityMetrics()', () => {
    it('returns partitionCount from partition detection', () => {
      // All members alive → no partition
      const aliveMembers = [makeMember('n1'), makeMember('n2'), makeMember('n3')];
      mockContext = buildMockContext(aliveMembers, aliveMembers);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const stability = introspection.getStabilityMetrics();

      expect(stability.partitionCount).toBe(0);
    });

    it('partitionCount > 0 when minority of nodes are alive', () => {
      // total=4, alive=1 → aliveCount < ceil(4/2)=2 → partitionCount=1
      const allMembers = [
        makeMember('n1', 'ALIVE'),
        makeMember('n2', 'DEAD'),
        makeMember('n3', 'DEAD'),
        makeMember('n4', 'DEAD')
      ];
      const aliveMembers = allMembers.filter(m => m.status === 'ALIVE');
      mockContext = buildMockContext(allMembers, aliveMembers);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const stability = introspection.getStabilityMetrics();

      expect(stability.partitionCount).toBe(1);
    });

    it('churnRate reflects recent join/leave events', () => {
      const aliveMembers = [makeMember('n1')];
      mockContext = buildMockContext(aliveMembers, aliveMembers);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);
      introspection.startTracking();

      // Simulate 3 membership events via the membership emitter
      mockContext.membership.emit('member-joined', makeMember('new-node'));
      mockContext.membership.emit('member-left', makeMember('leaving-node'));
      mockContext.membership.emit('member-joined', makeMember('another-node'));

      const stability = introspection.getStabilityMetrics();

      // churnRate = number of changes in last 60s window = 3
      expect(stability.churnRate).toBe(3);
    });

    it('churnRate is 0 when no membership changes recorded', () => {
      const aliveMembers = [makeMember('n1')];
      mockContext = buildMockContext(aliveMembers, aliveMembers);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const stability = introspection.getStabilityMetrics();

      expect(stability.churnRate).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('detectPartitionCount()', () => {
    it('returns 0 for a healthy single-zone cluster where all nodes are alive', () => {
      // All 3 nodes alive in same zone → no partition
      const members = [
        makeMember('n1', 'ALIVE', { metadata: { zone: 'zone-a' } }),
        makeMember('n2', 'ALIVE', { metadata: { zone: 'zone-a' } }),
        makeMember('n3', 'ALIVE', { metadata: { zone: 'zone-a' } })
      ];
      mockContext = buildMockContext(members, members);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const health = introspection.getClusterHealth();

      expect(health.partitionCount).toBe(0);
    });

    it('returns 1 when majority of nodes are unreachable (alive < ceil(total/2))', () => {
      // 5 total, 2 alive → alive < ceil(5/2)=3 → partitionCount=1
      const allMembers = [
        makeMember('n1', 'ALIVE'),
        makeMember('n2', 'ALIVE'),
        makeMember('n3', 'DEAD'),
        makeMember('n4', 'DEAD'),
        makeMember('n5', 'DEAD')
      ];
      const aliveMembers = allMembers.filter(m => m.status === 'ALIVE');
      mockContext = buildMockContext(allMembers, aliveMembers);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const health = introspection.getClusterHealth();

      expect(health.partitionCount).toBe(1);
    });

    it('returns 0 when a single-zone cluster has a full majority alive', () => {
      // 4 total, 3 alive → alive >= ceil(4/2)=2 and all in same zone and aliveCount=total → no partition
      const members = [
        makeMember('n1', 'ALIVE', { metadata: { zone: 'z1' } }),
        makeMember('n2', 'ALIVE', { metadata: { zone: 'z1' } }),
        makeMember('n3', 'ALIVE', { metadata: { zone: 'z1' } }),
        makeMember('n4', 'ALIVE', { metadata: { zone: 'z1' } })
      ];
      mockContext = buildMockContext(members, members);
      introspection = new ClusterIntrospection();
      introspection.setContext(mockContext);

      const health = introspection.getClusterHealth();

      // All 4 alive, all in same zone, aliveCount === totalMembers → zone check (zones.size===1 but totalMembers===aliveCount) → 0
      expect(health.partitionCount).toBe(0);
    });
  });
});
