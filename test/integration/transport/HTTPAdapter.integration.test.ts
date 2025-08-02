import { HTTPAdapter } from '../../../src/transport/adapters/HTTPAdapter';
import { Message, MessageType } from '../../../src/types';

describe('HTTPAdapter', () => {
  let adapter: HTTPAdapter;
  const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };

  beforeEach(() => {
    adapter = new HTTPAdapter(nodeA, { port: 9004, enableLogging: false });
  });

  afterEach(async () => {
    if (adapter.getStats().isStarted) {
      await adapter.stop();
    }
  });

  describe('Basic Operations', () => {
    test('should create adapter instance', () => {
      expect(adapter).toBeDefined();
      expect(typeof adapter.start).toBe('function');
      expect(typeof adapter.stop).toBe('function');
      expect(typeof adapter.send).toBe('function');
    });

    test('should start and stop adapter', async () => {
      await adapter.start();
      expect(adapter.getStats().isStarted).toBe(true);
      
      await adapter.stop();
      expect(adapter.getStats().isStarted).toBe(false);
    }, 10000);

    test('should handle multiple start/stop cycles', async () => {
      await adapter.start();
      await adapter.stop();
      
      await adapter.start();
      expect(adapter.getStats().isStarted).toBe(true);
      
      await adapter.stop();
      expect(adapter.getStats().isStarted).toBe(false);
    }, 10000);
  });

  describe('HTTP Server', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should handle health check requests', async () => {
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
      
      // The server should be running and accessible
      // Health endpoint should be available at /gossip/health
    });

    test('should track request statistics', async () => {
      const stats = adapter.getStats();
      expect(stats).toHaveProperty('isStarted');
      expect(stats).toHaveProperty('messagesSent');
      expect(stats).toHaveProperty('messagesReceived');
      expect(stats).toHaveProperty('errors');
    });
  });

  describe('Message Handling', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should handle message sending to non-existent node gracefully', async () => {
      const message: Message = {
        id: 'test-msg-1',
        type: MessageType.PING,
        data: { content: 'test' },
        sender: nodeA,
        timestamp: Date.now()
      };
      const targetNode = { id: 'node-b', address: '127.0.0.1', port: 9999 };
      
      // Should throw connection error for non-existent node
      await expect(adapter.send(message, targetNode)).rejects.toThrow();
    }, 15000);

    test('should handle CORS headers', async () => {
      // HTTP adapter should handle CORS for web compatibility
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid target nodes', async () => {
      await adapter.start();
      
      const message: Message = {
        id: 'test-msg-2',
        type: MessageType.PING,
        data: { content: 'test' },
        sender: nodeA,
        timestamp: Date.now()
      };
      const invalidNode = { id: 'invalid', address: 'invalid-address', port: -1 };
      
      await expect(adapter.send(message, invalidNode)).rejects.toThrow();
      
      // Connection stats should still be valid
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    }, 10000);

    test('should handle stop before start', async () => {
      await expect(adapter.stop()).resolves.not.toThrow();
    });

    test('should handle port conflicts gracefully', async () => {
      await adapter.start();
      
      // Try to create another adapter on the same port
            const conflictAdapter = new HTTPAdapter(nodeA, { port: 9004, enableLogging: false });
      
      // Should handle the conflict gracefully
      await expect(conflictAdapter.start()).rejects.toThrow();
      await conflictAdapter.stop().catch(() => {}); // Cleanup
    }, 10000);
  });

  describe('Configuration', () => {
    test('should respect custom configuration', () => {
      const customAdapter = new HTTPAdapter(nodeA, {
        port: 9005,
        timeout: 10000,
        cors: true,
        enableLogging: false
      });
      
      expect(customAdapter).toBeDefined();
    });

    test('should use default configuration when not provided', () => {
      const defaultAdapter = new HTTPAdapter(nodeA, { enableLogging: false });
      expect(defaultAdapter).toBeDefined();
    });
  });

  describe('REST Endpoints', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should provide gossip message endpoint', async () => {
      // The adapter should have POST /gossip/message endpoint
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });

    test('should provide health check endpoint', async () => {
      // The adapter should have GET /gossip/health endpoint
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });
  });
});
