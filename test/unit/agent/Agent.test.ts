import { Agent, AgentConfig, HealthStatus, ClusterStatus, MemberInfo } from '../../../src/agent/Agent';

// ---------------------------------------------------------------------------
// Mock Node
// ---------------------------------------------------------------------------

function createMockNode(overrides: Record<string, any> = {}) {
  const defaultMembership = new Map([
    ['node-1', { status: 'alive', lastSeen: 1000, version: 1, metadata: { role: 'worker' } }],
    ['node-2', { status: 'alive', lastSeen: 2000, version: 2, metadata: undefined }],
  ]);

  return {
    id: overrides.id ?? 'node-1',
    isRunning: jest.fn().mockReturnValue(overrides.isRunning ?? false),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    getClusterHealth: jest.fn().mockReturnValue(
      overrides.clusterHealth ?? {
        isHealthy: true,
        totalNodes: 2,
        aliveNodes: 2,
        suspectNodes: 0,
        deadNodes: 0,
      },
    ),
    getClusterTopology: jest.fn().mockReturnValue(
      overrides.topology ?? { nodes: ['node-1', 'node-2'], ring: [] },
    ),
    getClusterMetadata: jest.fn().mockReturnValue(
      overrides.metadata ?? { clusterId: 'test-cluster', version: 1 },
    ),
    getNodeInfo: jest.fn().mockReturnValue(
      overrides.nodeInfo ?? { id: overrides.id ?? 'node-1', status: 'running' },
    ),
    getMembership: jest.fn().mockReturnValue(overrides.membership ?? defaultMembership),
    getMemberCount: jest.fn().mockReturnValue(overrides.memberCount ?? 2),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Agent', () => {
  describe('wraps a Node and provides status', () => {
    it('exposes the underlying node via getNode()', () => {
      const node = createMockNode();
      const agent = new Agent(node);

      expect(agent.getNode()).toBe(node);
    });

    it('uses the configured name', () => {
      const node = createMockNode();
      const agent = new Agent(node, { name: 'my-agent' });

      expect(agent.name).toBe('my-agent');
    });

    it('falls back to node id when no name configured', () => {
      const node = createMockNode({ id: 'fallback-id' });
      const agent = new Agent(node);

      expect(agent.name).toBe('fallback-id');
    });

    it('reports isRunning() as false before start', () => {
      const agent = new Agent(createMockNode());

      expect(agent.isRunning()).toBe(false);
    });
  });

  // -- getClusterStatus -------------------------------------------------------

  describe('getClusterStatus()', () => {
    it('returns health, topology, and metadata from the node', async () => {
      const node = createMockNode();
      const agent = new Agent(node);

      const status: ClusterStatus = await agent.getClusterStatus();

      expect(status.health.isHealthy).toBe(true);
      expect(status.health.totalNodes).toBe(2);
      expect(status.topology).toEqual({ nodes: ['node-1', 'node-2'], ring: [] });
      expect(status.metadata).toEqual({ clusterId: 'test-cluster', version: 1 });

      expect(node.getClusterHealth).toHaveBeenCalledTimes(1);
      expect(node.getClusterTopology).toHaveBeenCalledTimes(1);
      expect(node.getClusterMetadata).toHaveBeenCalledTimes(1);
    });

    it('reflects unhealthy cluster state', async () => {
      const node = createMockNode({
        clusterHealth: {
          isHealthy: false,
          totalNodes: 3,
          aliveNodes: 1,
          suspectNodes: 1,
          deadNodes: 1,
        },
      });
      const agent = new Agent(node);

      const status = await agent.getClusterStatus();

      expect(status.health.isHealthy).toBe(false);
      expect(status.health.deadNodes).toBe(1);
    });
  });

  // -- getHealth --------------------------------------------------------------

  describe('getHealth()', () => {
    it('returns node health summary', async () => {
      const node = createMockNode({ isRunning: true });
      const agent = new Agent(node);

      const health: HealthStatus = await agent.getHealth();

      expect(health.nodeId).toBe('node-1');
      expect(health.running).toBe(true);
      expect(health.clusterHealthy).toBe(true);
      expect(health.memberCount).toBe(2);
      expect(health.resourceCount).toBeNull(); // no registry
    });

    it('reports running=false when node is stopped', async () => {
      const node = createMockNode({ isRunning: false });
      const agent = new Agent(node);

      const health = await agent.getHealth();

      expect(health.running).toBe(false);
    });

    it('includes resource count when registry is provided', async () => {
      const node = createMockNode({ isRunning: true });
      const mockRegistry = {
        getAllResources: jest.fn().mockReturnValue([{ id: 'r1' }, { id: 'r2' }]),
      } as any;
      const agent = new Agent(node, { resourceRegistry: mockRegistry });

      const health = await agent.getHealth();

      expect(health.resourceCount).toBe(2);
    });
  });

  // -- listMembers ------------------------------------------------------------

  describe('listMembers()', () => {
    it('returns member list from the node membership table', async () => {
      const node = createMockNode();
      const agent = new Agent(node);

      const members: MemberInfo[] = await agent.listMembers();

      expect(members).toHaveLength(2);

      const member1 = members.find(m => m.id === 'node-1');
      expect(member1).toBeDefined();
      expect(member1!.status).toBe('alive');
      expect(member1!.lastSeen).toBe(1000);
      expect(member1!.version).toBe(1);
      expect(member1!.metadata).toEqual({ role: 'worker' });

      const member2 = members.find(m => m.id === 'node-2');
      expect(member2).toBeDefined();
      expect(member2!.status).toBe('alive');
    });

    it('returns empty list when no members', async () => {
      const node = createMockNode({ membership: new Map() });
      const agent = new Agent(node);

      const members = await agent.listMembers();

      expect(members).toEqual([]);
    });
  });

  // -- start / stop delegates to Node -----------------------------------------

  describe('start/stop delegation', () => {
    it('start() calls node.start() when node is not running', async () => {
      const node = createMockNode({ isRunning: false });
      const agent = new Agent(node);

      await agent.start();

      expect(node.start).toHaveBeenCalledTimes(1);
      expect(agent.isRunning()).toBe(true);
    });

    it('start() skips node.start() when node is already running', async () => {
      const node = createMockNode({ isRunning: true });
      const agent = new Agent(node);

      await agent.start();

      expect(node.start).not.toHaveBeenCalled();
      expect(agent.isRunning()).toBe(true);
    });

    it('start() throws on double-start', async () => {
      const node = createMockNode({ isRunning: false });
      const agent = new Agent(node);

      await agent.start();
      await expect(agent.start()).rejects.toThrow(/already started/);
    });

    it('stop() calls node.stop() when node is running', async () => {
      const node = createMockNode({ isRunning: false });
      const agent = new Agent(node);

      await agent.start();

      // After agent.start(), the node mock still returns isRunning based on
      // the original mock value.  Adjust mock to reflect started state.
      node.isRunning.mockReturnValue(true);

      await agent.stop();

      expect(node.stop).toHaveBeenCalledTimes(1);
      expect(agent.isRunning()).toBe(false);
    });

    it('stop() is a no-op when agent is not started', async () => {
      const node = createMockNode();
      const agent = new Agent(node);

      await agent.stop(); // should not throw

      expect(node.stop).not.toHaveBeenCalled();
      expect(agent.isRunning()).toBe(false);
    });

    it('stop() skips node.stop() when node is already stopped', async () => {
      const node = createMockNode({ isRunning: false });
      const agent = new Agent(node);

      await agent.start();
      // node.isRunning still returns false, so agent.stop() won't call node.stop()
      await agent.stop();

      expect(node.stop).not.toHaveBeenCalled();
      expect(agent.isRunning()).toBe(false);
    });
  });
});
