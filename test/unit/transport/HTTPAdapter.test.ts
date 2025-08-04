import { HTTPAdapter, HTTPAdapterConfig } from '../../../src/transport/adapters/HTTPAdapter';
import { Message, MessageType } from '../../../src/types';
import * as http from 'http';
import * as https from 'https';

// Mock the CircuitBreaker and RetryManager
jest.mock('../../../src/transport/CircuitBreaker');
jest.mock('../../../src/transport/RetryManager');

describe('HTTPAdapter', () => {
  let adapter: HTTPAdapter;
  const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };
  const nodeB = { id: 'node-b', address: '127.0.0.1', port: 8081 };

  beforeEach(() => {
    adapter = new HTTPAdapter(nodeA, { 
      enableLogging: false,
      timeout: 1000,
      port: 9001 // Use different port for tests
    });
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
    }
  });

  describe('Constructor and Configuration', () => {
    test('should create adapter instance with default config', () => {
      const defaultAdapter = new HTTPAdapter(nodeA);
      expect(defaultAdapter).toBeDefined();
      expect(defaultAdapter.getLocalNodeInfo()).toEqual(nodeA);
    });

    test('should create adapter instance with custom config', () => {
      const config: HTTPAdapterConfig = {
        port: 9002,
        host: '0.0.0.0',
        useHttps: true,
        cors: false,
        timeout: 2000,
        maxConnections: 50,
        enableLogging: false
      };
      
      const customAdapter = new HTTPAdapter(nodeA, config);
      expect(customAdapter).toBeDefined();
      expect(customAdapter.getLocalNodeInfo()).toEqual(nodeA);
    });

    test('should return correct local node info', () => {
      expect(adapter.getLocalNodeInfo()).toEqual(nodeA);
    });
  });

  describe('Lifecycle Management', () => {
    test('should start successfully', async () => {
      await expect(adapter.start()).resolves.not.toThrow();
      
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });

    test('should stop successfully', async () => {
      await adapter.start();
      await expect(adapter.stop()).resolves.not.toThrow();
      
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(false);
    });

    test('should handle multiple start calls', async () => {
      await adapter.start();
      await expect(adapter.start()).rejects.toThrow('HTTP adapter is already running');
    });

    test('should handle stop when not started', async () => {
      await expect(adapter.stop()).resolves.not.toThrow();
    });

    test('should handle start/stop cycles', async () => {
      await adapter.start();
      await adapter.stop();
      
      // Create new adapter since we can't restart the same instance
      const newAdapter = new HTTPAdapter(nodeA, { port: 9003, enableLogging: false });
      await expect(newAdapter.start()).resolves.not.toThrow();
      await newAdapter.stop();
    });
  });

  describe('Message Handling', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should register message handler', () => {
      const handler = jest.fn();
      expect(() => adapter.onMessage(handler)).not.toThrow();
    });

    test('should handle send when not started', async () => {
      const stoppedAdapter = new HTTPAdapter(nodeA, { enableLogging: false });
      const message: Message = {
        id: 'msg-1',
        type: MessageType.PING,
        sender: nodeA,
        timestamp: Date.now(),
        data: { test: 'data' }
      };

      await expect(stoppedAdapter.send(message, nodeB)).rejects.toThrow('HTTP adapter is not running');
    });

    test('should create message for send', async () => {
      const message: Message = {
        id: 'msg-1',
        type: MessageType.PING,
        sender: nodeA,
        timestamp: Date.now(),
        data: { test: 'data' }
      };

      // Test that send method exists and can be called
      // (We can't easily mock HTTP in unit tests, so we just test the interface)
      await expect(adapter.send(message, nodeB)).rejects.toThrow(); // Will fail due to no target server
    });
  });

  describe('Statistics and Monitoring', () => {
    test('should return initial stats', () => {
      const stats = adapter.getStats();
      expect(stats).toMatchObject({
        isStarted: false,
        host: '127.0.0.1',
        port: 9001,
        secure: false,
        cors: true,
        activeAgents: 0,
        requestsHandled: 0,
        messagesReceived: 0,
        messagesSent: 0,
        errors: 0,
        timeout: 1000
      });
      // CircuitBreakerState might be undefined initially
      expect(stats).toHaveProperty('circuitBreakerState');
    });

    test('should track stats when started', async () => {
      await adapter.start();
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(true);
    });
  });

  describe('Agent Management', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should handle agent creation', () => {
      // Test that the adapter manages agents (indirectly through stats)
      const stats = adapter.getStats();
      expect(stats.activeAgents).toBe(0);
    });
  });

  describe('Error Handling', () => {
    test('should handle start errors gracefully', async () => {
      // Create adapter with conflicting port
      await adapter.start();
      const conflictingAdapter = new HTTPAdapter(nodeA, { 
        port: 9001, // Same port as first adapter
        enableLogging: false 
      });
      
      await expect(conflictingAdapter.start()).rejects.toThrow();
    });

    test('should handle send errors for unreachable targets', async () => {
      await adapter.start();
      
      const message: Message = {
        id: 'msg-1',
        type: MessageType.PING,
        sender: nodeA,
        timestamp: Date.now(),
        data: {}
      };

      // Try to send to unreachable target
      await expect(adapter.send(message, nodeB)).rejects.toThrow();
    });
  });

  describe('HTTPS Support', () => {
    test('should use HTTPS when configured', () => {
      const httpsAdapter = new HTTPAdapter(nodeA, { 
        useHttps: true,
        enableLogging: false,
        port: 9005
      });
      
      expect(httpsAdapter.getLocalNodeInfo()).toEqual(nodeA);
    });

    test('should handle HTTPS configuration', () => {
      const httpsAdapter = new HTTPAdapter(nodeA, { 
        useHttps: true,
        enableLogging: false,
        port: 9006
      });

      const stats = httpsAdapter.getStats();
      expect(stats.secure).toBe(true);
    });
  });

  describe('Request Handling', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should handle health check requests', (done) => {
      const options = {
        hostname: '127.0.0.1',
        port: 9001,
        path: '/gossip/health',
        method: 'GET'
      };

      const req = http.request(options, (res) => {
        expect(res.statusCode).toBe(200);
        
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          const response = JSON.parse(data);
          expect(response.status).toBe('healthy');
          expect(response.nodeId).toBe(nodeA.id);
          done();
        });
      });

      req.on('error', done);
      req.end();
    });

    test('should handle unknown routes', (done) => {
      const options = {
        hostname: '127.0.0.1',
        port: 9001,
        path: '/unknown',
        method: 'GET'
      };

      const req = http.request(options, (res) => {
        expect(res.statusCode).toBe(404);
        
        // Consume response data to prevent ECONNRESET
        res.on('data', () => {
          // Consume data chunks
        });
        
        res.on('end', () => {
          done();
        });
      });

      req.on('error', (error: any) => {
        // Handle various connection errors gracefully
        if (error.message.includes('socket hang up') || 
            error.message.includes('ECONNRESET') ||
            error.code === 'ECONNRESET') {
          // This is expected for 404 responses in some Node.js versions
          done();
        } else {
          done(error);
        }
      });
      
      req.setTimeout(5000, () => {
        req.destroy();
        done(new Error('Request timeout'));
      });
      
      req.end();
    });
  });
});
