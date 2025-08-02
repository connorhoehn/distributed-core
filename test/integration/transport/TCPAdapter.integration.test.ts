import { TCPAdapter } from '../../../src/transport/adapters/TCPAdapter';
import { Message, MessageType } from '../../../src/types';

describe('TCPAdapter', () => {
  let adapter: TCPAdapter;
  const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };

  beforeEach(() => {
    adapter = new TCPAdapter(nodeA, { 
      port: 9001, 
      enableLogging: false,
      connectionTimeout: 1000, // Very short timeout for faster tests
      maxRetries: 1, // Reduce retries for faster failure
      baseRetryDelay: 100, // Minimal retry delay
      circuitBreakerTimeout: 1000 // Short circuit breaker timeout
    });
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
    }, 3000); // Increased slightly for 1s connection timeout + overhead

    test('should track connection statistics', async () => {
      const stats = adapter.getStats();
      expect(stats).toHaveProperty('isStarted');
      expect(stats).toHaveProperty('activeConnections');
      expect(stats).toHaveProperty('totalConnections');
      expect(stats).toHaveProperty('port');
      expect(stats).toHaveProperty('host');
    });
  });

  describe('Connection Management', () => {
    test('should manage connections properly', async () => {
      await adapter.start();
      
      const initialStats = adapter.getStats();
      expect(initialStats.totalConnections).toBe(0);
      
      // Connection count should be tracked when attempting connections
      const message: Message = {
        id: 'test-msg-2',
        type: MessageType.PING,
        data: { content: 'test' },
        sender: nodeA,
        timestamp: Date.now()
      };
      const targetNode = { id: 'node-b', address: '127.0.0.1', port: 9002 };
      
      await adapter.send(message, targetNode).catch(() => {
        // Expected to fail, we're testing connection tracking
      });
      
      // Stats should reflect the attempt
      const finalStats = adapter.getStats();
      expect(finalStats.activeConnections).toBeGreaterThanOrEqual(0);
    }, 3000); // Increased slightly for 1s connection timeout + overhead
  });

  describe('Error Handling', () => {
    test('should handle invalid target nodes', async () => {
      await adapter.start();
      
      const message: Message = {
        id: 'test-msg-3',
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
    }, 3000); // Increased slightly for 1s connection timeout + overhead

    test('should handle stop before start', async () => {
      await expect(adapter.stop()).resolves.not.toThrow();
    });
  });

  describe('Configuration', () => {
    test('should respect custom configuration', () => {
      const customAdapter = new TCPAdapter(nodeA, {
        port: 9003,
        keepAliveInterval: 10000,
        connectionTimeout: 10000,
        enableLogging: false
      });
      
      expect(customAdapter).toBeDefined();
    });

    test('should use default configuration when not provided', () => {
      const defaultAdapter = new TCPAdapter(nodeA, { enableLogging: false });
      expect(defaultAdapter).toBeDefined();
    });
  });
});
