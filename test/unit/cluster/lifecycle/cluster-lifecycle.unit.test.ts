import { ClusterLifecycle } from '../../../../src/cluster/lifecycle/ClusterLifecycle';
import { IClusterManagerContext } from '../../../../src/cluster/core/IClusterManagerContext';
import { NodeInfo, MembershipEntry } from '../../../../src/cluster/types';

describe('ClusterLifecycle', () => {
  let lifecycle: ClusterLifecycle;
  let mockContext: jest.Mocked<IClusterManagerContext>;

  // Base node template for consistent test data
  const baseNode = {
    id: 'test-node-1',
    status: 'ALIVE' as const,
    version: 1,
    lastSeen: Date.now(),
    metadata: {
      address: '127.0.0.1',
      port: 3000
    }
  };

  // Helper function to create NodeInfo objects with consistent structure
  const createNodeInfo = (overrides: Partial<NodeInfo> = {}): NodeInfo => {
    return {
      ...baseNode,
      ...overrides,
      metadata: {
        ...baseNode.metadata,
        ...(overrides.metadata || {})
      }
    };
  };

  // Helper function to create list of NodeInfo objects
  const createNodeInfoList = (nodeSpecs: Array<Partial<NodeInfo>>): NodeInfo[] => {
    return nodeSpecs.map(spec => createNodeInfo(spec));
  };

  beforeEach(() => {
    // Create mock context with proper Jest mocks
    mockContext = {
      config: {
        getSeedNodes: jest.fn().mockReturnValue(['seed1', 'seed2']),
        enableLogging: false
      },
      localNodeId: 'test-node-1',
      keyManager: {
        signClusterPayload: jest.fn().mockImplementation((payload) => payload)
      },
      transport: {
        start: jest.fn().mockResolvedValue(void 0),
        stop: jest.fn().mockResolvedValue(void 0),
        send: jest.fn().mockResolvedValue(void 0),
        onMessage: jest.fn()
      },
      membership: {
        addLocalNode: jest.fn(),
        getMember: jest.fn() as jest.MockedFunction<(nodeId: string) => MembershipEntry | undefined>,
        updateNode: jest.fn().mockReturnValue(true),
        getAliveMembers: jest.fn() as jest.MockedFunction<() => MembershipEntry[]>,
        clear: jest.fn()
      },
      failureDetector: {
        start: jest.fn(),
        stop: jest.fn()
      },
      gossipStrategy: {
        sendPeriodicGossip: jest.fn().mockResolvedValue(void 0)
      },
      recentUpdates: [],
      getLocalNodeInfo: jest.fn().mockReturnValue(createNodeInfo()),
      addToRecentUpdates: jest.fn(),
      incrementVersion: jest.fn(),
      isBootstrapped: jest.fn().mockReturnValue(false),
      getClusterSize: jest.fn().mockReturnValue(1)
    } as any;

    lifecycle = new ClusterLifecycle({
      shutdownTimeout: 100,        // 100ms for unit tests
      drainTimeout: 100,           // 100ms for unit tests  
      enableGracefulShutdown: true,
      maxShutdownWait: 50          // 50ms for unit tests
    });

    lifecycle.setContext(mockContext);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default configuration', () => {
      const defaultLifecycle = new ClusterLifecycle();
      const config = defaultLifecycle.getConfig();
      
      expect(config.shutdownTimeout).toBe(10000);
      expect(config.drainTimeout).toBe(30000);
      expect(config.enableAutoRebalance).toBe(true);
      expect(config.enableGracefulShutdown).toBe(true);
    });

    it('should override defaults with provided configuration', () => {
      const customConfig = {
        shutdownTimeout: 5000,
        drainTimeout: 15000,
        enableAutoRebalance: false
      };
      
      const customLifecycle = new ClusterLifecycle(customConfig);
      const config = customLifecycle.getConfig();
      
      expect(config.shutdownTimeout).toBe(5000);
      expect(config.drainTimeout).toBe(15000);
      expect(config.enableAutoRebalance).toBe(false);
      expect(config.enableGracefulShutdown).toBe(true); // default preserved
    });
  });

  describe('setContext', () => {
    it('should set the context successfully', () => {
      const newLifecycle = new ClusterLifecycle();
      newLifecycle.setContext(mockContext);
      
      const status = newLifecycle.getStatus();
      expect(status.nodeId).toBe('test-node-1');
    });
  });

  describe('start', () => {
    it('should require context to be set', async () => {
      const noContextLifecycle = new ClusterLifecycle();
      
      await expect(noContextLifecycle.start()).rejects.toThrow(
        'ClusterLifecycle requires context to be set'
      );
    });

    it('should start successfully when context is set', async () => {
      const startedSpy = jest.fn();
      lifecycle.on('started', startedSpy);

      await lifecycle.start();

      expect(mockContext.getLocalNodeInfo).toHaveBeenCalled();
      expect(mockContext.membership.addLocalNode).toHaveBeenCalled();
      expect(mockContext.transport.start).toHaveBeenCalled();
      expect(mockContext.failureDetector.start).toHaveBeenCalled();
      
      expect(startedSpy).toHaveBeenCalledWith({
        nodeId: 'test-node-1',
        timestamp: expect.any(Number)
      });

      const status = lifecycle.getStatus();
      expect(status.isStarted).toBe(true);
    });

    it('should not start twice', async () => {
      await lifecycle.start();
      await lifecycle.start(); // Second call

      expect(mockContext.transport.start).toHaveBeenCalledTimes(1);
    });

    it('should emit error on failure', async () => {
      (mockContext.transport.start as any).mockRejectedValue(new Error('Transport failed'));
      
      const errorSpy = jest.fn();
      lifecycle.on('error', errorSpy);

      await expect(lifecycle.start()).rejects.toThrow('Transport failed');
      expect(errorSpy).toHaveBeenCalledWith({
        error: expect.any(Error),
        operation: 'start'
      });
    });
  });

  describe('stop', () => {
    beforeEach(async () => {
      await lifecycle.start();
    });

    it('should stop successfully', async () => {
      const stoppedSpy = jest.fn();
      lifecycle.on('stopped', stoppedSpy);

      await lifecycle.stop();

      expect(mockContext.failureDetector.stop).toHaveBeenCalled();
      expect(mockContext.transport.stop).toHaveBeenCalled();
      expect(mockContext.membership.clear).toHaveBeenCalled();
      
      expect(stoppedSpy).toHaveBeenCalledWith({
        nodeId: 'test-node-1',
        timestamp: expect.any(Number)
      });

      const status = lifecycle.getStatus();
      expect(status.isStarted).toBe(false);
    });

    it('should not stop twice', async () => {
      await lifecycle.stop();
      await lifecycle.stop(); // Second call

      expect(mockContext.transport.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('leave', () => {
    beforeEach(async () => {
      await lifecycle.start();
    });

    it('should leave cluster gracefully', async () => {
      const mockLocalNode = createNodeInfo();
      (mockContext.membership.getMember as any).mockReturnValue(mockLocalNode);

      const leftSpy = jest.fn();
      lifecycle.on('left', leftSpy);

      await lifecycle.leave();

      expect(mockContext.membership.updateNode).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-node-1',
          status: 'LEAVING',
          version: 2
        })
      );
      expect(mockContext.addToRecentUpdates).toHaveBeenCalled();
      
      expect(leftSpy).toHaveBeenCalledWith({
        nodeId: 'test-node-1',
        timestamp: expect.any(Number)
      });

      const status = lifecycle.getStatus();
      expect(status.isStarted).toBe(false);
    });

    it('should return early if node not in cluster', async () => {
      (mockContext.membership.getMember as any).mockReturnValue(null);

      await lifecycle.leave();

      expect(mockContext.membership.updateNode).not.toHaveBeenCalled();
    });
  });

  describe('drainNode', () => {
    beforeEach(async () => {
      await lifecycle.start();
    });

    it('should drain local node by default', async () => {
      const mockLocalNode = createNodeInfo();
      (mockContext.membership.getMember as any).mockReturnValue(mockLocalNode);

      const drainedSpy = jest.fn();
      lifecycle.on('drained', drainedSpy);

      await lifecycle.drainNode();

      expect(mockContext.membership.updateNode).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-node-1',
          status: 'DRAINING',
          version: 2
        })
      );
      
      expect(drainedSpy).toHaveBeenCalledWith({
        nodeId: 'test-node-1',
        timestamp: expect.any(Number)
      });
    });

    it('should drain specified node', async () => {
      const mockTargetNode = createNodeInfo({
        id: 'target-node',
        metadata: {
          address: '127.0.0.1',
          port: 3001
        }
      });

      (mockContext.membership.getMember as any).mockReturnValue(mockTargetNode);

      await lifecycle.drainNode('target-node');

      expect(mockContext.membership.getMember).toHaveBeenCalledWith('target-node');
      expect(mockContext.membership.updateNode).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'target-node',
          status: 'DRAINING'
        })
      );
    });

    it('should throw error if node not found', async () => {
      (mockContext.membership.getMember as any).mockReturnValue(null);

      await expect(lifecycle.drainNode('unknown-node')).rejects.toThrow(
        'Node unknown-node not found in cluster'
      );
    });
  });

  describe('rebalanceCluster', () => {
    beforeEach(async () => {
      await lifecycle.start();
    });

    it('should rebalance cluster with multiple nodes', async () => {
      (mockContext.membership.getAliveMembers as any).mockReturnValue([
        { id: 'node1', status: 'ALIVE' },
        { id: 'node2', status: 'ALIVE' }
      ] as any);

      const rebalancedSpy = jest.fn();
      lifecycle.on('rebalanced', rebalancedSpy);

      await lifecycle.rebalanceCluster();

      expect(rebalancedSpy).toHaveBeenCalledWith({
        nodeCount: 2,
        timestamp: expect.any(Number)
      });
    });

    it('should not rebalance with less than 2 nodes', async () => {
      (mockContext.membership.getAliveMembers as any).mockReturnValue([
        { id: 'node1', status: 'ALIVE' }
      ] as any);

      const rebalancedSpy = jest.fn();
      lifecycle.on('rebalanced', rebalancedSpy);

      await lifecycle.rebalanceCluster();

      expect(rebalancedSpy).not.toHaveBeenCalled();
    });
  });

  describe('configuration management', () => {
    it('should get configuration', () => {
      const config = lifecycle.getConfig();
      
      expect(config.shutdownTimeout).toBe(100);
      expect(config.drainTimeout).toBe(100);
    });

    it('should update configuration', () => {
      lifecycle.updateConfig({
        shutdownTimeout: 5000,
        enableAutoRebalance: false
      });

      const config = lifecycle.getConfig();
      expect(config.shutdownTimeout).toBe(5000);
      expect(config.enableAutoRebalance).toBe(false);
      expect(config.drainTimeout).toBe(100); // Unchanged
    });
  });

  describe('getStatus', () => {
    it('should return initial status', () => {
      const status = lifecycle.getStatus();
      
      expect(status).toEqual({
        isStarted: false,
        isDraining: false,
        nodeId: 'test-node-1'
      });
    });

    it('should return status without context', () => {
      const noContextLifecycle = new ClusterLifecycle();
      const status = noContextLifecycle.getStatus();
      
      expect(status).toEqual({
        isStarted: false,
        isDraining: false,
        nodeId: undefined
      });
    });

    it('should track draining state', async () => {
      await lifecycle.start();
      
      const mockLocalNode = createNodeInfo();
      (mockContext.membership.getMember as any).mockReturnValue(mockLocalNode);

      // Start draining (don't await to check intermediate state)
      const drainPromise = lifecycle.drainNode();
      
      // Check status while draining
      const drainingStatus = lifecycle.getStatus();
      expect(drainingStatus.isDraining).toBe(true);

      await drainPromise;

      // Check status after draining
      const completedStatus = lifecycle.getStatus();
      expect(completedStatus.isDraining).toBe(false);
    });
  });
});
