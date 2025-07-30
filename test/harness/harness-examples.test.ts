import { createTestCluster } from './create-test-cluster';
import { nodeFixtures } from '../fixtures/nodes';
import { spyLogger, LogEntry } from '../helpers/spyLogger';

describe('Test Harness Example', () => {
  describe('createTestCluster', () => {
    it('should create a test cluster with specified size', () => {
      const cluster = createTestCluster({ size: 3 });
      
      expect(cluster.nodes).toHaveLength(3);
      expect(cluster.start).toBeDefined();
      expect(cluster.stop).toBeDefined();
      expect(cluster.getNode).toBeDefined();
      expect(cluster.getLogs).toBeDefined();
    });

    it('should provide access to individual nodes', () => {
      const cluster = createTestCluster({ size: 2 });
      
      const node0 = cluster.getNode(0);
      const node1 = cluster.getNode(1);
      
      expect(node0).toBeDefined();
      expect(node1).toBeDefined();
      expect(node0).not.toBe(node1);
    });

    it('should throw error for invalid node index', () => {
      const cluster = createTestCluster({ size: 2 });
      
      expect(() => cluster.getNode(-1)).toThrow();
      expect(() => cluster.getNode(2)).toThrow();
    });

    it('should capture logs when enabled', async () => {
      const cluster = createTestCluster({ size: 1, enableLogging: true });
      
      await cluster.start();
      await cluster.stop();
      
      const logs = cluster.getLogs();
      expect(logs.some((log: any) => log.message?.includes('Starting test cluster'))).toBe(true);
      expect(logs.some((log: any) => log.message?.includes('Stopping test cluster'))).toBe(true);
    });

    it('should not capture logs when disabled', async () => {
      const cluster = createTestCluster({ size: 1, enableLogging: false });
      
      await cluster.start();
      await cluster.stop();
      
      const logs = cluster.getLogs();
      expect(logs).toHaveLength(0);
    });
  });

  describe('nodeFixtures', () => {
    it('should provide predefined test nodes', () => {
      expect(nodeFixtures).toBeDefined();
      expect(Array.isArray(nodeFixtures)).toBe(true);
      expect(nodeFixtures.length).toBeGreaterThan(0);
      
      const firstNode = nodeFixtures[0];
      expect(firstNode.id).toBeDefined();
      expect(firstNode.address).toBeDefined();
      expect(firstNode.port).toBeDefined();
    });

    it('should have unique ports for each node', () => {
      const ports = nodeFixtures.map(node => node.port);
      const uniquePorts = new Set(ports);
      
      expect(uniquePorts.size).toBe(ports.length);
    });
  });

  describe('spyLogger', () => {
    it('should create a functioning logger', () => {
      const logger = spyLogger();
      
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    it('should capture log messages', () => {
      const logger = spyLogger();
      
      logger.info('Test info message');
      logger.warn('Test warning');
      logger.error('Test error');
      
      const logs = logger.getLogs();
      expect(logs).toHaveLength(3);
      expect(logs[0].level).toBe('info');
      expect(logs[0].message).toBe('Test info message');
      expect(logs[1].level).toBe('warn');
      expect(logs[2].level).toBe('error');
    });

    it('should support clearing logs', () => {
      const logger = spyLogger();
      
      logger.info('Message 1');
      logger.info('Message 2');
      expect(logger.getLogs()).toHaveLength(2);
      
      logger.clear();
      expect(logger.getLogs()).toHaveLength(0);
    });
  });
});
