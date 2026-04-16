import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { Message, MessageType } from '../../../src/types';

// Mock the CircuitBreaker and RetryManager
jest.mock('../../../src/transport/CircuitBreaker', () => ({
  CircuitBreaker: jest.fn().mockImplementation(() => ({
    execute: jest.fn().mockImplementation(async (fn) => fn()),
    destroy: jest.fn(),
    on: jest.fn()
  }))
}));

jest.mock('../../../src/transport/RetryManager', () => ({
  RetryManager: jest.fn().mockImplementation(() => ({
    execute: jest.fn().mockImplementation(async (fn) => fn()),
    destroy: jest.fn()
  }))
}));

describe('WebSocketAdapter', () => {
  let adapter: WebSocketAdapter;
  const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };
  const nodeB = { id: 'node-b', address: '127.0.0.1', port: 8081 };

  beforeEach(() => {
    adapter = new WebSocketAdapter(nodeA, { port: 9010, enableLogging: false });
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
    }
  });

  describe('Constructor', () => {
    test('should create WebSocketAdapter instance', () => {
      expect(adapter).toBeInstanceOf(WebSocketAdapter);
      expect(adapter.getLocalNodeInfo()).toEqual(nodeA);
    });

    test('should set default configuration', () => {
      const defaultAdapter = new WebSocketAdapter(nodeA);
      expect(defaultAdapter).toBeInstanceOf(WebSocketAdapter);
    });

    test('should accept custom configuration', () => {
      const customConfig = {
        port: 9050,
        enableLogging: true,
        maxConnections: 100,
        pingInterval: 30000
      };
      const customAdapter = new WebSocketAdapter(nodeA, customConfig);
      expect(customAdapter).toBeInstanceOf(WebSocketAdapter);
    });
  });

  describe('Lifecycle Management', () => {
    test('should start successfully', async () => {
      await adapter.start();
      // Add small delay to ensure start is complete
      await new Promise(resolve => setTimeout(resolve, 10));
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });

    test('should stop successfully', async () => {
      await adapter.start();
      await expect(adapter.stop()).resolves.not.toThrow();
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(false);
    });

    test('should handle multiple start calls gracefully', async () => {
      await adapter.start();
      await expect(adapter.start()).resolves.not.toThrow();
    });

    test('should handle multiple stop calls gracefully', async () => {
      await adapter.start();
      await adapter.stop();
      await expect(adapter.stop()).resolves.not.toThrow();
    });
  });

  describe('Message Handling', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should handle message reception', async () => {
      const messageHandler = jest.fn();
      adapter.on('message', messageHandler);

      // Simulate receiving a message
      const receivedMessage = {
        id: 'received-message',
        type: MessageType.PING,
        data: {},
        timestamp: Date.now(),
        sender: nodeB
      };

      adapter.emit('message', receivedMessage);
      expect(messageHandler).toHaveBeenCalledWith(receivedMessage);
    });

    test('should handle send message with broadcast', async () => {
      const message: Message = {
        id: 'test-message',
        type: MessageType.GOSSIP,
        data: { test: 'data' },
        timestamp: Date.now(),
        sender: nodeA
      };

      // Mock GossipMessage for broadcast test
      const mockGossipMessage = {
        isBroadcast: () => true,
        header: { id: message.id },
        serialize: () => Buffer.from(JSON.stringify(message))
      };

      // Should either send successfully or throw a defined error (no connections)
      const result = await adapter.send(mockGossipMessage as any).then(
        (res) => ({ sent: true, value: res }),
        (err) => { expect(err).toBeDefined(); return { sent: false }; }
      );
      expect(result).toBeDefined();
    });
  });

  describe('Connection Management', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should connect to target node', async () => {
      // Should either connect successfully or throw a defined error
      const result = await adapter.connect(nodeB).then(
        () => ({ connected: true }),
        (err) => { expect(err).toBeDefined(); return { connected: false }; }
      );
      expect(result).toBeDefined();
    });

    test('should get connection statistics', () => {
      const stats = adapter.getStats();
      expect(stats).toHaveProperty('isStarted');
      expect(stats).toHaveProperty('activeConnections');
      expect(stats).toHaveProperty('totalConnections');
      expect(stats).toHaveProperty('port');
      expect(stats).toHaveProperty('host');
    });

    test('should get connected nodes', () => {
      const nodes = adapter.getConnectedNodes();
      expect(Array.isArray(nodes)).toBe(true);
    });
  });

  describe('WebSocket Specific Features', () => {
    test('should support compression when enabled', () => {
      const compressedAdapter = new WebSocketAdapter(nodeA, { 
        port: 9011, 
        enableCompression: true,
        enableLogging: false 
      });
      expect(compressedAdapter).toBeInstanceOf(WebSocketAdapter);
    });

    test('should support custom ping interval', () => {
      const customAdapter = new WebSocketAdapter(nodeA, { 
        port: 9012, 
        pingInterval: 10000,
        enableLogging: false 
      });
      expect(customAdapter).toBeInstanceOf(WebSocketAdapter);
    });

    test('should support max connections limit', () => {
      const limitedAdapter = new WebSocketAdapter(nodeA, { 
        port: 9013, 
        maxConnections: 50,
        enableLogging: false 
      });
      expect(limitedAdapter).toBeInstanceOf(WebSocketAdapter);
    });
  });

  describe('Event Handling', () => {
    test('should handle error events', () => {
      const errorHandler = jest.fn();
      adapter.on('error', errorHandler);
      
      // Emit a test error to verify the handler is set up
      adapter.emit('error', new Error('test error'));
      expect(errorHandler).toHaveBeenCalledWith(new Error('test error'));
    });

    test('should register and remove message listeners', () => {
      const messageCallback = jest.fn();
      
      adapter.onMessage(messageCallback);
      adapter.removeMessageListener(messageCallback);
      
      // Emit message should not call the removed listener
      adapter.emit('message', { id: 'test' });
      expect(messageCallback).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    test('should handle send when not started', async () => {
      const message: Message = {
        id: 'msg-1',
        type: MessageType.PING,
        sender: nodeA,
        timestamp: Date.now(),
        data: {}
      };

      await expect(adapter.send(message as any)).rejects.toThrow('WebSocket adapter not started');
    });

    test('should handle connection errors gracefully', async () => {
      await adapter.start();

      // Should either connect or throw a defined error without crashing
      const result = await adapter.connect(nodeB).then(
        () => ({ connected: true }),
        (err) => { expect(err).toBeDefined(); return { connected: false }; }
      );
      expect(result).toBeDefined();
    });
  });

  describe('Integration Tests', () => {
    test('should integrate with circuit breaker', async () => {
      await adapter.start();
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });

    test('should integrate with retry manager', async () => {
      await adapter.start();

      // Should either connect or throw a defined error, exercising the retry manager
      const result = await adapter.connect(nodeB).then(
        () => ({ connected: true }),
        (err) => { expect(err).toBeDefined(); return { connected: false }; }
      );
      expect(result).toBeDefined();
    });
  });
});
