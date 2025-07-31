import { Node } from '../Node';
import { InMemoryAdapter } from '../../transport/adapters/InMemoryAdapter';

describe('Node', () => {
  let node: Node;

  afterEach(async () => {
    if (node && node.isRunning()) {
      await node.stop();
    }
  });

  describe('constructor', () => {
    it('should create a new node with minimal config', () => {
      node = new Node({ id: 'test-node' });
      
      expect(node.id).toBe('test-node');
      expect(node.isRunning()).toBe(false);
      expect(node.metadata).toBeDefined();
      expect(node.cluster).toBeDefined();
      expect(node.router).toBeDefined();
      expect(node.connections).toBeDefined();
    });

    it('should create a node with custom config', () => {
      const transport = new InMemoryAdapter({
        id: 'custom-node',
        address: 'localhost',
        port: 8080
      });

      node = new Node({
        id: 'custom-node',
        region: 'us-east-1',
        zone: 'us-east-1a',
        role: 'coordinator',
        tags: { environment: 'test', service: 'distributed-core' },
        seedNodes: ['seed-1', 'seed-2'],
        transport,
        enableMetrics: true,
        enableChaos: true
      });
      
      expect(node.id).toBe('custom-node');
      expect(node.metadata).toBeDefined();
    });
  });

  describe('lifecycle', () => {
    beforeEach(() => {
      node = new Node({ id: 'lifecycle-test' });
    });

    it('should start and stop successfully', async () => {
      expect(node.isRunning()).toBe(false);
      
      await node.start();
      expect(node.isRunning()).toBe(true);
      
      await node.stop();
      expect(node.isRunning()).toBe(false);
    });

    it('should throw error when starting already started node', async () => {
      await node.start();
      
      await expect(node.start()).rejects.toThrow('already started');
    });

    it('should handle multiple stop calls gracefully', async () => {
      await node.start();
      await node.stop();
      await node.stop(); // Should not throw
    });
  });

  describe('cluster operations', () => {
    beforeEach(async () => {
      node = new Node({ id: 'cluster-test' });
      await node.start();
    });

    it('should provide cluster information', () => {
      const nodeInfo = node.getNodeInfo();
      expect(nodeInfo).toBeDefined();
      expect(nodeInfo.id).toBe('cluster-test');

      const health = node.getClusterHealth();
      expect(health).toBeDefined();

      const topology = node.getClusterTopology();
      expect(topology).toBeDefined();

      const metadata = node.getClusterMetadata();
      expect(metadata).toBeDefined();
    });

    it('should get replica nodes for a key', () => {
      const replicas = node.getReplicaNodes('test-key', 2);
      expect(Array.isArray(replicas)).toBe(true);
    });

    it('should provide membership information', () => {
      const membership = node.getMembership();
      expect(membership).toBeDefined();

      const memberCount = node.getMemberCount();
      expect(typeof memberCount).toBe('number');
    });
  });

  describe('message handling', () => {
    beforeEach(async () => {
      node = new Node({ id: 'message-test' });
      await node.start();
    });

    it('should register custom message handlers', () => {
      const handler = jest.fn();
      
      expect(() => {
        node.registerHandler('custom-message', handler);
      }).not.toThrow();
    });

    it('should route messages through the router', () => {
      const message = { type: 'echo', payload: 'test' };
      
      expect(() => {
        node.routeMessage(message);
      }).not.toThrow();
    });
  });

  describe('observability', () => {
    beforeEach(() => {
      node = new Node({ 
        id: 'observability-test',
        region: 'us-east-1',
        zone: 'us-east-1a',
        tags: { service: 'distributed-core' }
      });
    });

    it('should provide metrics', () => {
      const metrics = node.getMetrics();
      expect(metrics).toBeDefined();
      expect(metrics.nodeId).toBe('observability-test');
    });

    it('should handle chaos injection', () => {
      expect(() => {
        node.injectChaos('delay', { duration: 100 });
      }).not.toThrow();
    });
  });

  describe('connection management', () => {
    beforeEach(() => {
      node = new Node({ id: 'connection-test' });
    });

    it('should create connections', () => {
      const sendFn = jest.fn();
      const connection = node.createConnection('conn-1', sendFn);
      
      expect(connection).toBeDefined();
      
      // Clean up the connection to prevent timers from keeping Jest alive
      connection.close();
    });

    it('should get sessions', () => {
      const session = node.getSession('non-existent');
      expect(session).toBeUndefined();
    });
  });
});
