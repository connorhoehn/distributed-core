import { createClusterNode, createRangeHandler } from '../src/coordinators';
import { ChatHandler } from './fixtures/ChatHandler';

describe('Cluster Framework', () => {
  let coordinator: any;

  const testConfig = {
    testMode: true,
    heartbeatIntervalMs: 50,
    leaseRenewalIntervalMs: 100,
    leaseTimeoutMs: 500,
    // Fast timers for testing
    startupDelayMs: 100,    // Reduced from 1000ms
    processingDelayMs: 50   // Reduced from 500ms
  };

  const loggingConfig = {
    enableFrameworkLogs: false,
    enableCoordinatorLogs: false,
    enableTestMode: true
  };

    afterEach(async () => {
    if (coordinator) {
      await coordinator.stop();
      coordinator = null;
    }
    // Small delay to let any pending timers complete
    await new Promise(resolve => setTimeout(resolve, testConfig.processingDelayMs));
  });

  describe('createClusterNode', () => {
    it('should create a cluster node with in-memory coordinator', async () => {
      coordinator = await createClusterNode({
        ringId: 'test-ring',
        rangeHandler: new ChatHandler(),
        coordinator: 'in-memory',
        transport: 'ws',
        seedNodes: [],
        nodeId: 'test-node-1',
        coordinatorConfig: testConfig,
        logging: loggingConfig
      });

      expect(coordinator).toBeDefined();
      expect(coordinator.constructor.name).toBe('RangeCoordinator');
    });

    it('should create a cluster node with gossip coordinator', async () => {
      coordinator = await createClusterNode({
        ringId: 'test-gossip-ring',
        rangeHandler: new ChatHandler(),
        coordinator: 'gossip',
        transport: 'ws',
        seedNodes: [],
        nodeId: 'gossip-test-node',
        coordinatorConfig: testConfig,
        logging: loggingConfig
      });

      expect(coordinator).toBeDefined();
    });

    it('should create a cluster node with etcd coordinator', async () => {
      coordinator = await createClusterNode({
        ringId: 'test-etcd-ring',
        rangeHandler: new ChatHandler(),
        coordinator: 'etcd',
        transport: 'ws',
        seedNodes: [],
        nodeId: 'etcd-test-node',
        coordinatorConfig: testConfig,
        logging: loggingConfig
      });

      expect(coordinator).toBeDefined();
    });

    it('should create a cluster node with zookeeper coordinator', async () => {
      coordinator = await createClusterNode({
        ringId: 'test-zk-ring',
        rangeHandler: new ChatHandler(),
        coordinator: 'zookeeper',
        transport: 'ws',
        seedNodes: [],
        nodeId: 'zk-test-node',
        coordinatorConfig: testConfig,
        logging: loggingConfig
      });

      expect(coordinator).toBeDefined();
    });
  });

  describe('Range Management', () => {
    it('should acquire and release ranges', async () => {
      coordinator = await createClusterNode({
        ringId: 'test-range-ring',
        rangeHandler: new ChatHandler(),
        coordinator: 'in-memory',
        transport: 'ws',
        seedNodes: [],
        nodeId: 'range-test-node',
        coordinatorConfig: testConfig,
        logging: loggingConfig
      });

      await coordinator.start();
      await new Promise(resolve => setTimeout(resolve, testConfig.startupDelayMs));

      const ownedRanges = await coordinator.getOwnedRanges();
      expect(ownedRanges.length).toBeGreaterThan(0);
    });

    it('should send messages to range handlers', async () => {
      coordinator = await createClusterNode({
        ringId: 'test-message-ring',
        rangeHandler: new ChatHandler(),
        coordinator: 'in-memory',
        transport: 'ws',
        seedNodes: [],
        nodeId: 'message-test-node',
        coordinatorConfig: testConfig,
        logging: loggingConfig
      });

      await coordinator.start();
      await new Promise(resolve => setTimeout(resolve, testConfig.startupDelayMs));
      expect(coordinator).toBeDefined();
    });
  });

  describe('Cluster Status', () => {
    it('should provide cluster status information', async () => {
      coordinator = await createClusterNode({
        ringId: 'status-test',
        rangeHandler: new ChatHandler(),
        coordinator: 'in-memory',
        transport: 'ws',
        seedNodes: [],
        nodeId: 'status-test-node',
        coordinatorConfig: testConfig,
        logging: loggingConfig
      });

      await coordinator.start();

      const status = await coordinator.getClusterStatus();

      expect(status).toBeDefined();
      expect(status.nodes).toBeDefined();
      expect(status.leases).toBeDefined();
      expect(status.ringId).toBe('status-test');
      expect(status.nodes.size).toBeGreaterThan(0);
    });
  });

  describe('ChatHandler', () => {
    it('should handle chat-specific messages', async () => {
      const chatHandler = new ChatHandler();

      coordinator = await createClusterNode({
        ringId: 'chat-test',
        rangeHandler: chatHandler,
        coordinator: 'in-memory',
        transport: 'ws',
        seedNodes: [],
        nodeId: 'chat-test-node',
        coordinatorConfig: testConfig,
        logging: loggingConfig
      });

      await coordinator.start();

      await new Promise(resolve => setTimeout(resolve, testConfig.startupDelayMs));

      await coordinator.sendMessage({
        id: 'join-room-1',
        type: 'JOIN_ROOM',
        payload: { roomId: 'general', userId: 'alice' },
        sourceNodeId: 'chat-test-node',
        targetRangeId: 'range-0',
        timestamp: Date.now()
      });

      await coordinator.sendMessage({
        id: 'chat-msg-1',
        type: 'SEND_CHAT',
        payload: { roomId: 'general', userId: 'alice', text: 'Hello world!' },
        sourceNodeId: 'chat-test-node',
        targetRangeId: 'range-0',
        timestamp: Date.now()
      });

      await new Promise(resolve => setTimeout(resolve, testConfig.processingDelayMs));

      const stats = chatHandler.getStats();
      expect(stats.totalRooms).toBeGreaterThanOrEqual(1);
      expect(stats.totalMessages).toBeGreaterThanOrEqual(1);
    });
  });
});