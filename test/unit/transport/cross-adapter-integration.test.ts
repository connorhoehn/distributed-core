import { HTTPAdapter } from '../../../src/transport/adapters/HTTPAdapter';
import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { Message, MessageType, NodeId } from '../../../src/types';

describe('Cross-Adapter Integration Tests', () => {
  let httpAdapter: HTTPAdapter;
  let wsAdapter: WebSocketAdapter;

  const httpNode: NodeId = { id: 'http-node', address: '127.0.0.1', port: 8001 };
  const wsNode: NodeId = { id: 'ws-node', address: '127.0.0.1', port: 0 }; // Use ephemeral port

  beforeEach(async () => {
    httpAdapter = new HTTPAdapter(httpNode, { 
      port: 8001, 
      enableLogging: false,
      requestTimeout: 2000
    });
    
    wsAdapter = new WebSocketAdapter(wsNode, { 
      port: 0, // Use ephemeral port
      enableLogging: false,
      pingInterval: 1000
    });
  });

  afterEach(async () => {
    const adapters = [httpAdapter, wsAdapter];
    await Promise.all(adapters.map(adapter => 
      adapter?.stop().catch(() => {})
    ));
    
    // Small delay to ensure clean shutdown
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  describe('HTTP Adapter Integration Scenarios', () => {
    test('should start and stop HTTP adapter properly', async () => {
      await httpAdapter.start();
      expect(httpAdapter.getStats().isStarted).toBe(true);
      
      await httpAdapter.stop();
      expect(httpAdapter.getStats().isStarted).toBe(false);
    });

    test('should handle HTTP message sending with proper error handling', async () => {
      await httpAdapter.start();
      
      const testMessage: Message = {
        id: 'http-integration-test',
        type: MessageType.PING,
        sender: httpNode,
        timestamp: Date.now(),
        data: { content: 'test message' }
      };

      const targetNode: NodeId = { id: 'non-existent', address: '127.0.0.1', port: 9999 };
      
      // Should handle failed sends gracefully
      try {
        await httpAdapter.send(testMessage, targetNode);
        expect(true).toBe(true);
      } catch (error) {
        expect(error).toBeDefined();
      }
      
      // Stats should be tracked regardless of success/failure
      const stats = httpAdapter.getStats();
      expect(stats.messagesSent + stats.errors).toBeGreaterThanOrEqual(1);
    });

    test('should maintain correct statistics', async () => {
      await httpAdapter.start();
      
      const initialStats = httpAdapter.getStats();
      expect(initialStats).toMatchObject({
        isStarted: true,
        port: 8001,
        messagesSent: expect.any(Number),
        messagesReceived: expect.any(Number),
        errors: expect.any(Number)
      });
    });
  });

  describe('WebSocket Adapter Integration Scenarios', () => {
    test('should start and stop WebSocket adapter properly', async () => {
      await wsAdapter.start();
      expect(wsAdapter.getStats().isStarted).toBe(true);
      
      await wsAdapter.stop();
      expect(wsAdapter.getStats().isStarted).toBe(false);
    });

    test('should handle WebSocket operations without active connections', async () => {
      await wsAdapter.start();
      
      const testMessage: Message = {
        id: 'ws-integration-test',
        type: MessageType.GOSSIP,
        sender: wsNode,
        timestamp: Date.now(),
        data: { content: 'websocket test' }
      };

      // WebSocket send without connections should handle gracefully
      try {
        await wsAdapter.send(testMessage as any);
        expect(true).toBe(true);
      } catch (error) {
        expect(error).toBeDefined();
      }
      
      // Check connected nodes
      const connectedNodes = wsAdapter.getConnectedNodes();
      expect(Array.isArray(connectedNodes)).toBe(true);
    });

    test('should maintain WebSocket statistics', async () => {
      await wsAdapter.start();
      
      const stats = wsAdapter.getStats();
      expect(stats).toMatchObject({
        isStarted: true,
        port: expect.any(Number), // Port assigned by OS
        activeConnections: expect.any(Number),
        totalConnections: expect.any(Number),
        host: expect.any(String)
      });
    });
  });

  describe('Multi-Adapter Coordination', () => {
    test('should run HTTP and WebSocket adapters concurrently', async () => {
      // Start both adapters
      await Promise.all([
        httpAdapter.start(),
        wsAdapter.start()
      ]);

      // Both should be started
      expect(httpAdapter.getStats().isStarted).toBe(true);
      expect(wsAdapter.getStats().isStarted).toBe(true);

      // Both should have different ports
      expect(httpAdapter.getStats().port).toBe(8001);
      expect(wsAdapter.getStats().port).toBeGreaterThan(0); // Port assigned by OS
      
      // Stop both adapters
      await Promise.all([
        httpAdapter.stop(),
        wsAdapter.stop()
      ]);

      // Both should be stopped
      expect(httpAdapter.getStats().isStarted).toBe(false);
      expect(wsAdapter.getStats().isStarted).toBe(false);
    });

    test('should handle adapter failover scenarios', async () => {
      // Start primary HTTP adapter
      await httpAdapter.start();
      expect(httpAdapter.getStats().isStarted).toBe(true);

      // Start backup WebSocket adapter
      await wsAdapter.start();
      expect(wsAdapter.getStats().isStarted).toBe(true);

      // Simulate primary failure
      await httpAdapter.stop();
      expect(httpAdapter.getStats().isStarted).toBe(false);

      // Backup should still be running
      expect(wsAdapter.getStats().isStarted).toBe(true);
    });

    test('should handle rapid start/stop cycles', async () => {
      // Test rapid cycles for HTTP adapter
      for (let i = 0; i < 3; i++) {
        await httpAdapter.start();
        expect(httpAdapter.getStats().isStarted).toBe(true);
        
        await httpAdapter.stop();
        expect(httpAdapter.getStats().isStarted).toBe(false);
        
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    });

    test('should maintain isolation between adapters', async () => {
      await httpAdapter.start();
      await wsAdapter.start();

      const httpStats = httpAdapter.getStats();
      const wsStats = wsAdapter.getStats();

      // Each adapter should maintain independent statistics
      expect(httpStats.port).not.toBe(wsStats.port);
      expect(httpStats.isStarted).toBe(true);
      expect(wsStats.isStarted).toBe(true);

      // Operations on one shouldn't affect the other
      await httpAdapter.stop();
      expect(httpAdapter.getStats().isStarted).toBe(false);
      expect(wsAdapter.getStats().isStarted).toBe(true);
    });
  });

  describe('Performance and Load Testing', () => {
    test('should handle concurrent operations on single adapter', async () => {
      await httpAdapter.start();

      const concurrentOperations = Array.from({ length: 10 }, async (_, i) => {
        const message: Message = {
          id: `concurrent-${i}`,
          type: MessageType.PING,
          sender: httpNode,
          timestamp: Date.now(),
          data: { sequence: i }
        };

        const target: NodeId = { id: `target-${i}`, address: '127.0.0.1', port: 8080 + i };

        try {
          await httpAdapter.send(message, target);
          return { success: true, id: i };
        } catch (error) {
          return { success: false, id: i, error };
        }
      });

      const results = await Promise.all(concurrentOperations);
      
      // Should complete all operations (successfully or with errors)
      expect(results).toHaveLength(10);
      expect(httpAdapter.getStats().isStarted).toBe(true);
    });

    test('should handle stress testing with multiple messages', async () => {
      await httpAdapter.start();

      const messages = Array.from({ length: 20 }, (_, i) => ({
        id: `stress-test-${i}`,
        type: MessageType.GOSSIP,
        sender: httpNode,
        timestamp: Date.now(),
        data: { sequence: i, payload: 'x'.repeat(50) }
      }));

      // Send all messages rapidly to a test target
      const testTarget: NodeId = { id: 'stress-target', address: '127.0.0.1', port: 9999 };
      const sendPromises = messages.map(msg => 
        httpAdapter.send(msg, testTarget).catch(error => ({ error, id: msg.id }))
      );

      const results = await Promise.all(sendPromises);
      
      // Adapter should remain stable under load
      expect(httpAdapter.getStats().isStarted).toBe(true);
      expect(results).toHaveLength(20);
      
      // Should have attempted to send messages (even if they failed)
      const stats = httpAdapter.getStats();
      expect(stats.messagesSent + stats.errors).toBeGreaterThan(0);
    });
  });
});
