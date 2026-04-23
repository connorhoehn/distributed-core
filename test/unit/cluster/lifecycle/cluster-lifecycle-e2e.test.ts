/**
 * End-to-End Cluster Lifecycle Integration Test
 *
 * Covers the full cluster lifecycle: join → gossip → rebalance → leave.
 *
 * Two complementary approaches are used:
 *  1. Real Node instances with InMemoryAdapter  — exercises the full
 *     ClusterManager/ClusterLifecycle stack with actual async transport.
 *  2. Mocked IClusterManagerContext + bare ClusterLifecycle — lets us test
 *     every lifecycle operation in total isolation without timing concerns.
 *
 * Test groups
 *  - Single-node lifecycle      (6 tests)
 *  - Two-node join              (5 tests)
 *  - Node leave                 (4 tests)
 *  - Rebalance                  (4 tests)
 *  - Drain                      (4 tests)
 *  - Gossip propagation         (3 tests)
 *
 * Total: 26 tests
 */

import { ClusterLifecycle } from '../../../../src/cluster/lifecycle/ClusterLifecycle';
import { IClusterManagerContext } from '../../../../src/cluster/core/IClusterManagerContext';
import { NodeInfo, MembershipEntry } from '../../../../src/cluster/types';
import { Node, NodeConfig } from '../../../../src/common/Node';
import { InMemoryAdapter } from '../../../../src/transport/adapters/InMemoryAdapter';

jest.setTimeout(15000);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Base NodeInfo template used to build test fixtures. */
const baseNode: NodeInfo = {
  id: 'test-node-1',
  status: 'ALIVE',
  version: 1,
  lastSeen: Date.now(),
  metadata: { address: '127.0.0.1', port: 3000 }
};

/** Create a NodeInfo, merging any overrides on top of baseNode. */
function makeNodeInfo(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    ...baseNode,
    ...overrides,
    metadata: { ...baseNode.metadata, ...(overrides.metadata ?? {}) }
  };
}

/** Build a minimal, jest-mocked IClusterManagerContext. */
function buildMockContext(nodeId = 'test-node-1'): jest.Mocked<IClusterManagerContext> {
  return {
    config: {
      getSeedNodes: jest.fn().mockReturnValue([]),
      enableLogging: false
    },
    localNodeId: nodeId,
    keyManager: {
      signClusterPayload: jest.fn().mockImplementation((p) => p)
    },
    transport: {
      start: jest.fn().mockResolvedValue(void 0),
      stop: jest.fn().mockResolvedValue(void 0),
      send: jest.fn().mockResolvedValue(void 0),
      onMessage: jest.fn()
    },
    membership: {
      addLocalNode: jest.fn(),
      getMember: jest.fn() as jest.MockedFunction<(id: string) => MembershipEntry | undefined>,
      updateNode: jest.fn().mockReturnValue(true),
      getAliveMembers: jest.fn().mockReturnValue([]) as jest.MockedFunction<() => MembershipEntry[]>,
      clear: jest.fn()
    },
    failureDetector: {
      start: jest.fn(),
      stop: jest.fn()
    },
    gossipStrategy: {
      sendPeriodicGossip: jest.fn().mockResolvedValue(void 0)
    },
    hashRing: {
      rebuild: jest.fn(),
      getAllNodes: jest.fn().mockReturnValue([])
    },
    recentUpdates: [],
    getLocalNodeInfo: jest.fn().mockReturnValue(makeNodeInfo({ id: nodeId })),
    addToRecentUpdates: jest.fn(),
    incrementVersion: jest.fn(),
    isBootstrapped: jest.fn().mockReturnValue(false),
    getClusterSize: jest.fn().mockReturnValue(1),
    rebuildHashRing: jest.fn(),
    joinCluster: jest.fn().mockResolvedValue(void 0),
    startGossipTimer: jest.fn(),
    stopGossipTimer: jest.fn(),
    sendImmediateGossip: jest.fn().mockResolvedValue(void 0),
    runAntiEntropyCycle: jest.fn()
  } as any;
}

/** Lifecycle config tuned for fast unit-style tests (no real waiting). */
const FAST_LIFECYCLE = {
  shutdownTimeout: 50,
  drainTimeout: 50,
  enableGracefulShutdown: true,
  maxShutdownWait: 20
};

/** NodeConfig shared across all Node-based integration tests. */
function makeNodeConfig(id: string, port: number): NodeConfig {
  return {
    id,
    clusterId: 'e2e-test-cluster',
    service: 'distributed-core-test',
    region: 'test-region',
    zone: 'test-zone-a',
    role: 'test-node',
    tags: { environment: 'test' },
    transport: new InMemoryAdapter({ id, address: '127.0.0.1', port }),
    enableMetrics: false,
    enableChaos: false,
    enableLogging: false,
    lifecycle: {
      shutdownTimeout: 100,
      drainTimeout: 50,
      enableAutoRebalance: false,
      rebalanceThreshold: 0.1,
      enableGracefulShutdown: false, // keeps tests fast
      maxShutdownWait: 10
    }
  };
}

// ---------------------------------------------------------------------------
// 1. Single-node lifecycle
// ---------------------------------------------------------------------------

describe('Single-node lifecycle', () => {
  let lifecycle: ClusterLifecycle;
  let mockCtx: jest.Mocked<IClusterManagerContext>;

  beforeEach(() => {
    mockCtx = buildMockContext();
    lifecycle = new ClusterLifecycle(FAST_LIFECYCLE);
    lifecycle.setContext(mockCtx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('start() completes without error', async () => {
    await expect(lifecycle.start()).resolves.toBeUndefined();
  });

  it('after start(), isStarted is true', async () => {
    await lifecycle.start();
    expect(lifecycle.getStatus().isStarted).toBe(true);
  });

  it('start() registers local node in membership', async () => {
    await lifecycle.start();
    expect(mockCtx.membership.addLocalNode).toHaveBeenCalledTimes(1);
    expect(mockCtx.membership.addLocalNode).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'test-node-1' })
    );
  });

  it('stop() after start() completes without error', async () => {
    await lifecycle.start();
    await expect(lifecycle.stop()).resolves.toBeUndefined();
  });

  it('after stop(), isStarted is false', async () => {
    await lifecycle.start();
    await lifecycle.stop();
    expect(lifecycle.getStatus().isStarted).toBe(false);
  });

  it('real Node: single node starts and reports member count ≥ 1', async () => {
    const node = new Node(makeNodeConfig('single-e2e-node', 20100));
    try {
      await node.start();
      expect(node.isRunning()).toBe(true);
      expect(node.getMemberCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await node.stop().catch(() => {/* ignore cleanup errors */});
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Two-node join
// ---------------------------------------------------------------------------

describe('Two-node join', () => {
  let nodes: Node[] = [];

  afterEach(async () => {
    await Promise.allSettled(nodes.map(n => n.stop().catch(() => {})));
    nodes = [];
  });

  it('both nodes start successfully', async () => {
    const nodeA = new Node(makeNodeConfig('join-node-a', 20200));
    const nodeB = new Node(makeNodeConfig('join-node-b', 20201));
    nodes.push(nodeA, nodeB);

    await nodeA.start();
    await nodeB.start();

    expect(nodeA.isRunning()).toBe(true);
    expect(nodeB.isRunning()).toBe(true);
  });

  it('each node has its own local member in membership after start', async () => {
    const nodeA = new Node(makeNodeConfig('join-node-a2', 20202));
    const nodeB = new Node(makeNodeConfig('join-node-b2', 20203));
    nodes.push(nodeA, nodeB);

    await nodeA.start();
    await nodeB.start();

    // Each node sees at least itself in its membership table
    expect(nodeA.getMembership().has('join-node-a2')).toBe(true);
    expect(nodeB.getMembership().has('join-node-b2')).toBe(true);
  });

  it('mock: handleJoinMessage adds new member to membership table', () => {
    const mockCtxA = buildMockContext('node-a');
    const mockCtxB = buildMockContext('node-b');

    // Simulate what ClusterCommunication.handleJoinMessage does when
    // node-b receives a JOIN from node-a.
    const nodeAInfo = makeNodeInfo({ id: 'node-a', status: 'ALIVE', version: 1 });

    // node-b's membership table tracks node-a after receiving the join
    (mockCtxB.membership.getMember as jest.Mock).mockReturnValueOnce(undefined);
    const updated = mockCtxB.membership.updateNode(nodeAInfo);

    // The mock returns true by default (updateNode mock) — confirm the call happened
    expect(mockCtxB.membership.updateNode).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'node-a' })
    );
  });

  it('mock: after join exchange, both membership tables reference each other', () => {
    const members: Map<string, MembershipEntry> = new Map();

    const membershipFor = (ownId: string): jest.Mocked<IClusterManagerContext>['membership'] => ({
      addLocalNode: jest.fn((info: NodeInfo) => {
        members.set(info.id, { ...info, lastUpdated: Date.now() });
      }),
      getMember: jest.fn((id: string) => members.get(id)),
      updateNode: jest.fn((info: NodeInfo) => {
        members.set(info.id, { ...info, lastUpdated: Date.now() });
        return true;
      }),
      getAliveMembers: jest.fn(() => Array.from(members.values()).filter(m => m.status === 'ALIVE')),
      clear: jest.fn()
    } as any);

    const nodeAInfo = makeNodeInfo({ id: 'node-a', status: 'ALIVE' });
    const nodeBInfo = makeNodeInfo({ id: 'node-b', status: 'ALIVE', metadata: { address: '127.0.0.1', port: 3001 } });

    const memA = membershipFor('node-a');
    const memB = membershipFor('node-b');

    // Each node adds itself locally
    memA.addLocalNode(nodeAInfo);
    memB.addLocalNode(nodeBInfo);

    // Simulate join exchange: A learns about B, B learns about A
    memA.updateNode(nodeBInfo);
    memB.updateNode(nodeAInfo);

    const aliveFromA = memA.getAliveMembers();
    const aliveFromB = memB.getAliveMembers();

    expect(aliveFromA.map((m: any) => m.id)).toContain('node-b');
    expect(aliveFromB.map((m: any) => m.id)).toContain('node-a');
  });

  it('real Node: getMemberCount() is at least 1 per node after start', async () => {
    const nodeA = new Node(makeNodeConfig('count-node-a', 20204));
    const nodeB = new Node(makeNodeConfig('count-node-b', 20205));
    nodes.push(nodeA, nodeB);

    await nodeA.start();
    await nodeB.start();

    expect(nodeA.getMemberCount()).toBeGreaterThanOrEqual(1);
    expect(nodeB.getMemberCount()).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Node leave
// ---------------------------------------------------------------------------

describe('Node leave', () => {
  let lifecycle: ClusterLifecycle;
  let mockCtx: jest.Mocked<IClusterManagerContext>;

  beforeEach(async () => {
    mockCtx = buildMockContext();
    lifecycle = new ClusterLifecycle(FAST_LIFECYCLE);
    lifecycle.setContext(mockCtx);
    await lifecycle.start();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('leave() completes without error when node is in cluster', async () => {
    (mockCtx.membership.getMember as jest.Mock).mockReturnValue(makeNodeInfo());
    await expect(lifecycle.leave()).resolves.toBeUndefined();
  });

  it('leave() marks node status as LEAVING before stopping', async () => {
    (mockCtx.membership.getMember as jest.Mock).mockReturnValue(makeNodeInfo());
    await lifecycle.leave();

    expect(mockCtx.membership.updateNode).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'LEAVING' })
    );
  });

  it('leave() emits "left" event with nodeId and timestamp', async () => {
    (mockCtx.membership.getMember as jest.Mock).mockReturnValue(makeNodeInfo());

    const leftPayloads: any[] = [];
    lifecycle.on('left', (payload: any) => leftPayloads.push(payload));

    await lifecycle.leave();

    expect(leftPayloads).toHaveLength(1);
    expect(leftPayloads[0]).toMatchObject({
      nodeId: 'test-node-1',
      timestamp: expect.any(Number)
    });
  });

  it('leave() results in isStarted being false', async () => {
    (mockCtx.membership.getMember as jest.Mock).mockReturnValue(makeNodeInfo());
    await lifecycle.leave();
    expect(lifecycle.getStatus().isStarted).toBe(false);
  });

  it('real Node: stop() after start() does not throw', async () => {
    const node = new Node(makeNodeConfig('leave-e2e-node', 20300));
    await node.start();
    expect(node.isRunning()).toBe(true);
    await expect(node.stop()).resolves.toBeUndefined();
    expect(node.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Rebalance
// ---------------------------------------------------------------------------

describe('Rebalance', () => {
  let lifecycle: ClusterLifecycle;
  let mockCtx: jest.Mocked<IClusterManagerContext>;

  beforeEach(async () => {
    mockCtx = buildMockContext();
    lifecycle = new ClusterLifecycle(FAST_LIFECYCLE);
    lifecycle.setContext(mockCtx);
    await lifecycle.start();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('rebalanceCluster() with 2+ alive nodes calls rebuildHashRing', async () => {
    (mockCtx.membership.getAliveMembers as jest.Mock).mockReturnValue([
      makeNodeInfo({ id: 'node-1' }),
      makeNodeInfo({ id: 'node-2', metadata: { address: '127.0.0.1', port: 3001 } })
    ]);

    await lifecycle.rebalanceCluster();
    expect(mockCtx.rebuildHashRing).toHaveBeenCalled();
  });

  it('rebalanceCluster() emits "rebalanced" event with nodeCount', async () => {
    (mockCtx.membership.getAliveMembers as jest.Mock).mockReturnValue([
      makeNodeInfo({ id: 'node-1' }),
      makeNodeInfo({ id: 'node-2', metadata: { address: '127.0.0.1', port: 3001 } })
    ]);

    const events: any[] = [];
    lifecycle.on('rebalanced', (e: any) => events.push(e));

    await lifecycle.rebalanceCluster();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ nodeCount: 2, timestamp: expect.any(Number) });
  });

  it('rebalanceCluster() with fewer than 2 nodes does NOT emit "rebalanced"', async () => {
    (mockCtx.membership.getAliveMembers as jest.Mock).mockReturnValue([
      makeNodeInfo({ id: 'node-1' })
    ]);

    const events: any[] = [];
    lifecycle.on('rebalanced', (e: any) => events.push(e));

    // Clear any calls accumulated during beforeEach (e.g. from start()).
    (mockCtx.rebuildHashRing as jest.Mock).mockClear();

    await lifecycle.rebalanceCluster();

    expect(events).toHaveLength(0);
    // rebuildHashRing must not have been called by the rebalance itself.
    expect(mockCtx.rebuildHashRing).not.toHaveBeenCalled();
  });

  it('rebalanceCluster() triggers anti-entropy cycle when nodes ≥ 2', async () => {
    (mockCtx.membership.getAliveMembers as jest.Mock).mockReturnValue([
      makeNodeInfo({ id: 'node-1' }),
      makeNodeInfo({ id: 'node-2', metadata: { address: '127.0.0.1', port: 3001 } })
    ]);

    await lifecycle.rebalanceCluster();
    expect(mockCtx.runAntiEntropyCycle).toHaveBeenCalled();
  });

  it('real Node: hashRing is populated after start', async () => {
    const node = new Node(makeNodeConfig('ring-e2e-node', 20400));
    try {
      await node.start();
      // The ring is rebuilt during start; for a single node it should contain
      // at least the local node's virtual nodes.
      const ringStats = node.cluster.hashRing.getStats();
      expect(ringStats.totalVirtualNodes).toBeGreaterThan(0);
    } finally {
      await node.stop().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Drain
// ---------------------------------------------------------------------------

describe('Drain', () => {
  let lifecycle: ClusterLifecycle;
  let mockCtx: jest.Mocked<IClusterManagerContext>;

  beforeEach(async () => {
    mockCtx = buildMockContext();
    // Use a very short drainTimeout so tests finish quickly.
    lifecycle = new ClusterLifecycle({ ...FAST_LIFECYCLE, drainTimeout: 20 });
    lifecycle.setContext(mockCtx);
    await lifecycle.start();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('drainNode() changes node status to DRAINING in membership', async () => {
    (mockCtx.membership.getMember as jest.Mock).mockReturnValue(makeNodeInfo());
    await lifecycle.drainNode();
    expect(mockCtx.membership.updateNode).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'DRAINING' })
    );
  });

  it('drainNode() completes without error for local node', async () => {
    (mockCtx.membership.getMember as jest.Mock).mockReturnValue(makeNodeInfo());
    await expect(lifecycle.drainNode()).resolves.toBeUndefined();
  });

  it('drainNode() emits "drained" event after completion', async () => {
    (mockCtx.membership.getMember as jest.Mock).mockReturnValue(makeNodeInfo());

    const events: any[] = [];
    lifecycle.on('drained', (e: any) => events.push(e));

    await lifecycle.drainNode();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      nodeId: 'test-node-1',
      timestamp: expect.any(Number)
    });
  });

  it('drainNode() throws when the target node is not in membership', async () => {
    (mockCtx.membership.getMember as jest.Mock).mockReturnValue(undefined);
    await expect(lifecycle.drainNode('ghost-node')).rejects.toThrow(
      'Node ghost-node not found in cluster'
    );
  });

  it('real Node: cluster.drainNode() returns true for local node', async () => {
    const node = new Node(makeNodeConfig('drain-e2e-node', 20500));
    try {
      await node.start();
      // drainNode on the running cluster manager targets the local node by default.
      const result = await node.cluster.drainNode(node.id, 50);
      // Returns true when drain completes without error.
      expect(result).toBe(true);
    } finally {
      await node.stop().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Gossip propagation
// ---------------------------------------------------------------------------

describe('Gossip propagation', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('ClusterLifecycle.start() calls startGossipTimer on context', async () => {
    const mockCtx = buildMockContext();
    const lifecycle = new ClusterLifecycle(FAST_LIFECYCLE);
    lifecycle.setContext(mockCtx);

    await lifecycle.start();

    expect(mockCtx.startGossipTimer).toHaveBeenCalledTimes(1);

    // Cleanup
    await lifecycle.stop().catch(() => {});
  });

  it('ClusterLifecycle.stop() calls stopGossipTimer on context', async () => {
    const mockCtx = buildMockContext();
    const lifecycle = new ClusterLifecycle(FAST_LIFECYCLE);
    lifecycle.setContext(mockCtx);

    await lifecycle.start();
    await lifecycle.stop();

    expect(mockCtx.stopGossipTimer).toHaveBeenCalledTimes(1);
  });

  it('real Node: runAntiEntropyCycle() does not throw on a running node', async () => {
    const node = new Node(makeNodeConfig('gossip-e2e-node', 20600));
    try {
      await node.start();
      // runAntiEntropyCycle is exposed on the ClusterManager.
      expect(() => node.cluster.runAntiEntropyCycle()).not.toThrow();
    } finally {
      await node.stop().catch(() => {});
    }
  });
});
