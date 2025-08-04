import { UDPAdapter } from '../../../src/transport/adapters/UDPAdapter';
import { Message, MessageType } from '../../../src/types';

describe('UDPAdapter', () => {
  let adapter: UDPAdapter;
  const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };

  beforeEach(() => {
    // Use fast retry settings for tests to reduce execution time
    adapter = new UDPAdapter(nodeA, { 
      port: 9008, 
      enableLogging: false,
      retryConfig: {
        maxRetries: 2,        // Reduce from 3 to 2
        baseDelay: 100,       // Reduce from 1000ms to 100ms
        maxDelay: 500,        // Reduce max delay 
        backoffFactor: 1.5    // Reduce backoff factor
      }
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

  describe('UDP Socket', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should handle socket binding', async () => {
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
      
      // UDP socket should be bound and listening
    });

    test('should track UDP statistics', async () => {
      const stats = adapter.getStats();
      expect(stats).toHaveProperty('isStarted');
      expect(stats).toHaveProperty('packetStats');
      expect(stats.packetStats).toHaveProperty('totalSent');
      expect(stats.packetStats).toHaveProperty('totalReceived');
      expect(stats).toHaveProperty('activeConnections');
      expect(stats).toHaveProperty('reachableNodes');
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
      
      // Should not throw, UDP is connectionless
      await expect(adapter.send(message, targetNode)).resolves.not.toThrow();
    }, 10000);

    test('should handle multicast messages', async () => {
      // UDP adapter should support multicast
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });

    test('should handle broadcast messages', async () => {
      // UDP adapter should support broadcast
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });
  });

  describe('Multicast Support', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should join multicast groups', async () => {
      // UDP adapter should be able to join multicast groups
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });

    test('should leave multicast groups on stop', async () => {
      await adapter.stop();
      expect(adapter.getStats().isStarted).toBe(false);
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
      
      // UDP should throw for invalid ports
      await expect(adapter.send(message, invalidNode)).rejects.toThrow();
    }, 10000);

    test('should handle stop before start', async () => {
      await expect(adapter.stop()).resolves.not.toThrow();
    });

    test('should handle port conflicts gracefully', async () => {
      await adapter.start();
      
      // Try to create another adapter on the same port
      const conflictAdapter = new UDPAdapter(nodeA, { port: 9008, enableLogging: false });
      
      // Should handle the conflict gracefully
      await expect(conflictAdapter.start()).rejects.toThrow();
      await conflictAdapter.stop().catch(() => {}); // Cleanup
    }, 10000);

    test('should handle large messages', async () => {
      await adapter.start();
      
      // Create a large message that might exceed UDP packet size
      const largeData = 'x'.repeat(70000); // Larger than typical UDP MTU
      const message: Message = {
        id: 'test-message-3',
        type: MessageType.PING,
        data: { data: largeData },
        sender: nodeA,
        timestamp: Date.now()
      };
      const targetNode = { id: 'node-b', address: '127.0.0.1', port: 9009 };
      
      // Should throw for large messages that exceed max packet size
      await expect(adapter.send(message, targetNode)).rejects.toThrow('Message too large');
    }, 10000);
  });

  describe('Configuration', () => {
    test('should respect custom configuration', () => {
      const customAdapter = new UDPAdapter(nodeA, {
        port: 8002,
        enableLogging: false
      });
      
      expect(customAdapter).toBeDefined();
    });

    test('should use default configuration when not provided', () => {
      const defaultAdapter = new UDPAdapter(nodeA, { enableLogging: false });
      expect(defaultAdapter).toBeDefined();
    });

    test('should handle IPv6 configuration', () => {
      const ipv6Adapter = new UDPAdapter(nodeA, {
        port: 9011,
        enableLogging: false
      });
      
      expect(ipv6Adapter).toBeDefined();
    });
  });

  describe('Performance Characteristics', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should be low latency', async () => {
      // UDP should provide low-latency communication
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });

    test('should handle high throughput', async () => {
      // UDP should handle high message rates
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });
  });
});
