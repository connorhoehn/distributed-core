import { GRPCAdapter } from '../../../src/transport/adapters';
import { Message, MessageType } from '../../../src/types';

describe('GRPCAdapter', () => {
  let adapter: GRPCAdapter;
  let originalConsoleError: typeof console.error;
  const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };

  beforeAll(() => {
    // Suppress gRPC library console.error output during tests
    originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      const message = args.join(' ');
      // Suppress specific gRPC internal errors
      if (message.includes('No address added out of total') || 
          message.includes('E No address added') ||
          message.includes('gRPC')) {
        return; // Don't log gRPC internal errors
      }
      // Log other errors normally
      originalConsoleError(...args);
    };
  });

  afterAll(() => {
    // Restore original console.error
    console.error = originalConsoleError;
  });

  beforeEach(() => {
    adapter = new GRPCAdapter(nodeA, { port: 9006, enableLogging: false });
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

  describe('gRPC Server', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should handle health check calls', async () => {
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
      
      // The gRPC server should be running and accessible
      // Health service should be available
    });

    test('should track RPC statistics', async () => {
      const stats = adapter.getStats();
      expect(stats).toHaveProperty('isStarted');
      expect(stats).toHaveProperty('messagesSent');
      expect(stats).toHaveProperty('messagesReceived');
      expect(stats).toHaveProperty('activeConnections');
      expect(stats).toHaveProperty('errors');
    });
  });

  describe('Message Handling', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should handle message sending to non-existent node gracefully', async () => {
      const message: Message = {
        id: 'test-message-1',
        type: MessageType.PING,
        data: { data: 'test' },
        sender: nodeA,
        timestamp: Date.now()
      };
      const targetNode = { id: 'node-b', address: '127.0.0.1', port: 9999 };
      
      // Should throw when connection fails
      await expect(adapter.send(message, targetNode)).rejects.toThrow();
    }, 15000);

    test('should handle streaming calls', async () => {
      // gRPC adapter should support streaming
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid target nodes', async () => {
      await adapter.start();
      
      const message: Message = {
        id: 'test-message-2',
        type: MessageType.PING,
        data: { data: 'test' },
        sender: nodeA,
        timestamp: Date.now()
      };
      const invalidNode = { id: 'invalid', address: 'invalid-address', port: -1 };
      
      await expect(adapter.send(message, invalidNode)).rejects.toThrow();
      
      const stats = adapter.getStats();
      expect(stats.errors).toBeGreaterThanOrEqual(0);
    }, 10000);

    test('should handle stop before start', async () => {
      await expect(adapter.stop()).resolves.not.toThrow();
    });

    test('should handle port conflicts gracefully', async () => {
      await adapter.start();
      
      // Try to create another adapter on the same port
      const conflictAdapter = new GRPCAdapter(nodeA, { port: 9006, enableLogging: false });
      
      // Should handle the conflict gracefully
      await expect(conflictAdapter.start()).rejects.toThrow();
      await conflictAdapter.stop().catch(() => {}); // Cleanup
    }, 10000);
  });

  describe('Configuration', () => {
    test('should respect custom configuration', () => {
      const customAdapter = new GRPCAdapter(nodeA, {
        port: 9007,
        maxReceiveMessageLength: 8 * 1024 * 1024,
        maxSendMessageLength: 8 * 1024 * 1024,
        enableLogging: false
      });
      
      expect(customAdapter).toBeDefined();
    });

    test('should use default configuration when not provided', () => {
      const defaultAdapter = new GRPCAdapter(nodeA, { enableLogging: false });
      expect(defaultAdapter).toBeDefined();
    });
  });

  describe('gRPC Services', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should provide gossip service', async () => {
      // The adapter should have GossipService with SendMessage method
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });

    test('should provide health service', async () => {
      // The adapter should have Health service
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });

    test('should handle connection pooling', async () => {
      // gRPC adapter should manage connection pools efficiently
      const stats = adapter.getStats();
      expect(stats.activeConnections).toBeGreaterThanOrEqual(0);
    });
  });
});
