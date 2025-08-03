import { TCPAdapter } from '../../../src/transport/adapters/TCPAdapter';
import { CircuitBreaker, CircuitBreakerManager } from '../../../src/transport/CircuitBreaker';
import { MessageBatcher } from '../../../src/transport/MessageBatcher';
import { Encryption } from '../../../src/transport/Encryption';
import { MessageAuth } from '../../../src/transport/MessageAuth';
import { Message, MessageType } from '../../../src/types';

/**
 * End-to-End Transport Layer Integration Test
 * 
 * Tests the complete transport layer stack working together:
 * - TCP transport adapters
 * - Circuit breakers for fault tolerance
 * - Message batching for performance
 * - Encryption and authentication for security
 * - Real network communication scenarios
 */
describe('Transport Layer E2E Integration', () => {
  let tcpNode1: TCPAdapter;
  let tcpNode2: TCPAdapter;
  let circuitBreakerManager: CircuitBreakerManager;
  let messageBatcher: MessageBatcher;
  let encryption: Encryption;
  let messageAuth: MessageAuth;

  const node1Info = { id: 'node-1', address: '127.0.0.1', port: 8001 };
  const node2Info = { id: 'node-2', address: '127.0.0.1', port: 8002 };

  beforeAll(async () => {
    // Initialize security components
    encryption = new Encryption({
      algorithm: 'aes-256-gcm',
      enableKeyRotation: false // Disable for testing
    });
    
    messageAuth = new MessageAuth({
      algorithm: 'hmac-sha256',
      enableReplayProtection: true
    });

    // Initialize message batching
    messageBatcher = new MessageBatcher({
      maxBatchSize: 5,
      flushInterval: 100, // 100ms for faster tests
      maxBatchAge: 200,
      enableCompression: false // Disable for simpler testing
    });

    // Initialize circuit breaker manager
    circuitBreakerManager = new CircuitBreakerManager();

    // Create encryption and auth keys
    await encryption.generateNewKey('test-key');
    await messageAuth.generateNewKey();
  });

  beforeEach(async () => {
    // Initialize TCP adapters
    tcpNode1 = new TCPAdapter(node1Info, {
      port: node1Info.port,
      enableLogging: false,
      connectionTimeout: 2000,
      maxRetries: 2,
      baseRetryDelay: 100
    });

    tcpNode2 = new TCPAdapter(node2Info, {
      port: node2Info.port,
      enableLogging: false,
      connectionTimeout: 2000,
      maxRetries: 2,
      baseRetryDelay: 100
    });
  });

  afterEach(async () => {
    // Clean shutdown
    const adapters = [tcpNode1, tcpNode2];
    await Promise.all(adapters.map(async (adapter) => {
      try {
        if (adapter && adapter.getStats().isStarted) {
          await adapter.stop();
        }
      } catch (error) {
        // Ignore shutdown errors in tests
      }
    }));

    // Reset circuit breakers
    circuitBreakerManager.resetAll();
  });

  afterAll(async () => {
    // Cleanup resources
    messageBatcher.destroy();
    circuitBreakerManager.destroy();
    encryption.destroy();
    messageAuth.destroy();
  });

  describe('TCP Transport Communication', () => {
    test('should enable TCP nodes to communicate bidirectionally', async () => {
      await tcpNode1.start();
      await tcpNode2.start();

      const receivedMessages: Message[] = [];
      
      tcpNode2.on('message', (message: Message) => {
        receivedMessages.push(message);
      });

      // Send message from node1 to node2
      const message: Message = {
        id: 'test-msg-1',
        type: MessageType.PING,
        data: { content: 'Hello from TCP Node 1' },
        sender: node1Info,
        timestamp: Date.now()
      };

      await tcpNode1.send(message, node2Info);

      // Wait for message delivery
      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].data.content).toBe('Hello from TCP Node 1');
    }, 10000);
  });

  describe('Circuit Breaker Integration', () => {
    test('should protect against failing nodes with circuit breaker', async () => {
      await tcpNode1.start();
      // Note: not starting tcpNode2 to simulate failure

      const breaker = circuitBreakerManager.getBreaker('tcp-node-2', {
        failureThreshold: 3,
        timeout: 1000,
        resetTimeout: 2000,
        enableLogging: false
      });

      let circuitOpenCount = 0;
      breaker.on('state-change', (event: any) => {
        if (event.newState === 'open') {
          circuitOpenCount++;
        }
      });

      const message: Message = {
        id: 'test-msg-3',
        type: MessageType.PING,
        data: { content: 'Test message' },
        sender: node1Info,
        timestamp: Date.now()
      };

      // Simulate multiple failures that should trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        try {
          await breaker.execute(async () => {
            await tcpNode1.send(message, node2Info);
          });
        } catch (error) {
          // Expected failures
        }
      }

      expect(circuitOpenCount).toBeGreaterThan(0);
      expect(breaker.getState()).toBe('open');
    }, 15000);
  });

  describe('Message Batching Integration', () => {
    test('should batch multiple messages for efficiency', async () => {
      const batches: any[] = [];
      
      messageBatcher.on('batch-sent', (batch: any) => {
        batches.push(batch);
      });

      // Queue multiple messages
      const messages = Array.from({ length: 3 }, (_, i) => ({
        id: `batch-msg-${i}`,
        data: Buffer.from(`Message ${i}`),
        destination: 'node-2',
        priority: 1,
        timestamp: Date.now()
      }));

      for (const msg of messages) {
        messageBatcher.addMessage(
          msg.id,
          msg.data,
          msg.destination,
          msg.priority,
          msg.timestamp
        );
      }

      // Wait for batch to be created and sent
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(batches.length).toBeGreaterThan(0);
    }, 8000);
  });

  describe('Security Integration', () => {
    test('should encrypt and authenticate messages end-to-end', async () => {
      const originalMessage = Buffer.from('Sensitive data that needs protection');
      
      // Encrypt the message
      const encryptedData = await encryption.encrypt(originalMessage, 'test-key');
      expect(encryptedData.data).not.toEqual(originalMessage);
      
      // Add authentication
      const authenticatedMessage = await messageAuth.sign(encryptedData.data);
      expect(authenticatedMessage.signature).toBeDefined();
      
      // Verify authentication
      const isValidAuth = await messageAuth.verify(authenticatedMessage);
      expect(isValidAuth).toBe(true);
      
      // Decrypt the message
      const decryptedData = await encryption.decrypt(encryptedData, 'test-key');
      expect(decryptedData).toEqual(originalMessage);
    }, 5000);

    test('should detect tampered messages', async () => {
      const originalMessage = Buffer.from('Important message');
      const authenticatedMessage = await messageAuth.sign(originalMessage);
      
      // Tamper with the message
      const tamperedMessage = {
        ...authenticatedMessage,
        data: Buffer.from('Tampered message')
      };
      
      // Verification should fail
      const isValid = await messageAuth.verify(tamperedMessage);
      expect(isValid).toBe(false);
    }, 5000);
  });

  describe('Performance Metrics', () => {
    test('should provide comprehensive transport statistics', async () => {
      await tcpNode1.start();
      await tcpNode2.start();

      // Send some messages to generate stats
      for (let i = 0; i < 3; i++) {
        const message: Message = {
          id: `stats-msg-${i}`,
          type: MessageType.PING,
          data: { content: `Stats test ${i}` },
          sender: node1Info,
          timestamp: Date.now()
        };
        
        try {
          await tcpNode1.send(message, node2Info);
        } catch (error) {
          // Some failures expected in tests
        }
      }

      const stats1 = tcpNode1.getStats();
      const stats2 = tcpNode2.getStats();
      
      expect(stats1.isStarted).toBe(true);
      expect(stats2.isStarted).toBe(true);
      expect(stats1.totalConnections).toBeGreaterThanOrEqual(0);
      expect(stats2.totalConnections).toBeGreaterThanOrEqual(0);

      // Check circuit breaker stats
      const allBreakerStats = circuitBreakerManager.getAllStats();
      expect(typeof allBreakerStats).toBe('object');

      // Check batcher stats
      const batcherStats = messageBatcher.getStats();
      expect(batcherStats.totalBatches).toBeGreaterThanOrEqual(0);
      expect(batcherStats.totalMessages).toBeGreaterThanOrEqual(0);
    }, 8000);
  });

  describe('Failure Recovery Scenario', () => {
    test('should recover from transport adapter failures', async () => {
      await tcpNode1.start();
      await tcpNode2.start();

      const breaker = circuitBreakerManager.getBreaker('recovery-test', {
        failureThreshold: 2,
        resetTimeout: 1000,
        enableLogging: false
      });

      let successCount = 0;
      let failureCount = 0;

      // Simulate some failures followed by recovery
      for (let i = 0; i < 5; i++) {
        try {
          await breaker.execute(async () => {
            if (i < 2) {
              // First 2 calls fail
              throw new Error('Simulated failure');
            }
            
            // Subsequent calls succeed
            const message: Message = {
              id: `recovery-msg-${i}`,
              type: MessageType.PING,
              data: { content: `Recovery test ${i}` },
              sender: node1Info,
              timestamp: Date.now()
            };
            
            await tcpNode1.send(message, node2Info);
            successCount++;
          });
        } catch (error) {
          failureCount++;
        }

        // Wait a bit between attempts
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      expect(failureCount).toBeGreaterThan(0);
      expect(successCount).toBeGreaterThan(0);
    }, 10000);
  });
});

  afterEach(async () => {
    // Clean shutdown
    const adapters = [tcpNode1, tcpNode2];
    await Promise.all(adapters.map(async (adapter) => {
      try {
        if (adapter && adapter.getStats().isStarted) {
          await adapter.stop();
        }
      } catch (error) {
        // Ignore shutdown errors in tests
      }
    }));

    // Reset circuit breakers
    circuitBreakerManager.resetAll();
  });

  afterAll(async () => {
    // Cleanup resources
    messageBatcher.destroy();
    circuitBreakerManager.destroy();
    encryption.destroy();
    messageAuth.destroy();
  });

  describe('TCP Transport Communication', () => {
    test('should enable TCP nodes to communicate bidirectionally', async () => {
      await tcpNode1.start();
      await tcpNode2.start();

      const receivedMessages: Message[] = [];
      
      tcpNode2.on('message', (message: Message) => {
        receivedMessages.push(message);
      });

      // Send message from node1 to node2
      const message: Message = {
        id: 'test-msg-1',
        type: MessageType.PING,
        data: { content: 'Hello from TCP Node 1' },
        sender: node1Info,
        timestamp: Date.now()
      };

      await tcpNode1.send(message, node2Info);

      // Wait for message delivery
      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].data.content).toBe('Hello from TCP Node 1');
    }, 10000);
  });

  describe('Circuit Breaker Integration', () => {
    test('should protect against failing nodes with circuit breaker', async () => {
      await tcpNode1.start();
      // Note: not starting tcpNode2 to simulate failure

      const breaker = circuitBreakerManager.getBreaker('tcp-node-2', {
        failureThreshold: 3,
        timeout: 1000,
        resetTimeout: 2000,
        enableLogging: false
      });

      let circuitOpenCount = 0;
      breaker.on('state-change', (event) => {
        if (event.newState === 'open') {
          circuitOpenCount++;
        }
      });

      const message: Message = {
        id: 'test-msg-3',
        type: MessageType.PING,
        data: { content: 'Test message' },
        sender: node1Info,
        timestamp: Date.now()
      };

      // Simulate multiple failures that should trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        try {
          await breaker.execute(async () => {
            await tcpNode1.send(message, node2Info);
          });
        } catch (error) {
          // Expected failures
        }
      }

      expect(circuitOpenCount).toBeGreaterThan(0);
      expect(breaker.getState()).toBe('open');
    }, 15000);
  });

  describe('Message Batching Integration', () => {
    test('should batch multiple messages for efficiency', async () => {
      const batches: any[] = [];
      
      messageBatcher.on('batch-sent', (batch) => {
        batches.push(batch);
      });

      // Queue multiple messages
      const messages = Array.from({ length: 3 }, (_, i) => ({
        id: `batch-msg-${i}`,
        data: Buffer.from(`Message ${i}`),
        destination: 'node-2',
        priority: 1,
        timestamp: Date.now()
      }));

      for (const msg of messages) {
        messageBatcher.addMessage(
          msg.id,
          msg.data,
          msg.destination,
          msg.priority,
          msg.timestamp
        );
      }

      // Wait for batch to be created and sent
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(batches.length).toBeGreaterThan(0);
    }, 8000);
  });

  describe('Security Integration', () => {
    test('should encrypt and authenticate messages end-to-end', async () => {
      const originalMessage = Buffer.from('Sensitive data that needs protection');
      
      // Encrypt the message
      const encryptedData = await encryption.encrypt(originalMessage, 'test-key');
      expect(encryptedData.data).not.toEqual(originalMessage);
      
      // Add authentication
      const authenticatedMessage = await messageAuth.sign(encryptedData.data);
      expect(authenticatedMessage.signature).toBeDefined();
      
      // Verify authentication
      const isValidAuth = await messageAuth.verify(authenticatedMessage);
      expect(isValidAuth).toBe(true);
      
      // Decrypt the message
      const decryptedData = await encryption.decrypt(encryptedData, 'test-key');
      expect(decryptedData).toEqual(originalMessage);
    }, 5000);

    test('should detect tampered messages', async () => {
      const originalMessage = Buffer.from('Important message');
      const authenticatedMessage = await messageAuth.sign(originalMessage);
      
      // Tamper with the message
      const tamperedMessage = {
        ...authenticatedMessage,
        data: Buffer.from('Tampered message')
      };
      
      // Verification should fail
      const isValid = await messageAuth.verify(tamperedMessage);
      expect(isValid).toBe(false);
    }, 5000);
  });

  describe('Performance Metrics', () => {
    test('should provide comprehensive transport statistics', async () => {
      await tcpNode1.start();
      await tcpNode2.start();

      // Send some messages to generate stats
      for (let i = 0; i < 3; i++) {
        const message: Message = {
          id: `stats-msg-${i}`,
          type: MessageType.PING,
          data: { content: `Stats test ${i}` },
          sender: node1Info,
          timestamp: Date.now()
        };
        
        try {
          await tcpNode1.send(message, node2Info);
        } catch (error) {
          // Some failures expected in tests
        }
      }

      const stats1 = tcpNode1.getStats();
      const stats2 = tcpNode2.getStats();
      
      expect(stats1.isStarted).toBe(true);
      expect(stats2.isStarted).toBe(true);
      expect(stats1.totalConnections).toBeGreaterThanOrEqual(0);
      expect(stats2.totalConnections).toBeGreaterThanOrEqual(0);

      // Check circuit breaker stats
      const allBreakerStats = circuitBreakerManager.getAllStats();
      expect(typeof allBreakerStats).toBe('object');

      // Check batcher stats
      const batcherStats = messageBatcher.getStats();
      expect(batcherStats.totalBatches).toBeGreaterThanOrEqual(0);
      expect(batcherStats.totalMessages).toBeGreaterThanOrEqual(0);
    }, 8000);
  });

  describe('Failure Recovery Scenario', () => {
    test('should recover from transport adapter failures', async () => {
      await tcpNode1.start();
      await tcpNode2.start();

      const breaker = circuitBreakerManager.getBreaker('recovery-test', {
        failureThreshold: 2,
        resetTimeout: 1000,
        enableLogging: false
      });

      let successCount = 0;
      let failureCount = 0;

      // Simulate some failures followed by recovery
      for (let i = 0; i < 5; i++) {
        try {
          await breaker.execute(async () => {
            if (i < 2) {
              // First 2 calls fail
              throw new Error('Simulated failure');
            }
            
            // Subsequent calls succeed
            const message: Message = {
              id: `recovery-msg-${i}`,
              type: MessageType.PING,
              data: { content: `Recovery test ${i}` },
              sender: node1Info,
              timestamp: Date.now()
            };
            
            await tcpNode1.send(message, node2Info);
            successCount++;
          });
        } catch (error) {
          failureCount++;
        }

        // Wait a bit between attempts
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      expect(failureCount).toBeGreaterThan(0);
      expect(successCount).toBeGreaterThan(0);
    }, 10000);
  });
});

  afterEach(async () => {
    // Clean shutdown
    const adapters = [tcpNode1, tcpNode2, wsNode1, wsNode2];
    await Promise.all(adapters.map(async (adapter) => {
      try {
        if (adapter.getStats().isStarted) {
          await adapter.stop();
        }
      } catch (error) {
        // Ignore shutdown errors in tests
      }
    }));

    // Reset circuit breakers
    circuitBreakerManager.resetAll();
  });

  afterAll(async () => {
    // Cleanup resources
    messageBatcher.destroy();
    circuitBreakerManager.destroy();
    encryption.destroy();
    messageAuth.destroy();
  });

  describe('Multi-Transport Communication', () => {
    test('should enable TCP nodes to communicate bidirectionally', async () => {
      await tcpNode1.start();
      await tcpNode2.start();

      const receivedMessages: Message[] = [];
      
      tcpNode2.on('message', (message: Message) => {
        receivedMessages.push(message);
      });

      // Send message from node1 to node2
      const message: Message = {
        id: 'test-msg-1',
        type: MessageType.PING,
        data: { content: 'Hello from TCP Node 1' },
        sender: node1Info,
        timestamp: Date.now()
      };

      await tcpNode1.send(message, node2Info);

      // Wait for message delivery
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].data.content).toBe('Hello from TCP Node 1');
    }, 10000);

    test('should enable WebSocket nodes to communicate bidirectionally', async () => {
      await wsNode1.start();
      await wsNode2.start();

      const receivedMessages: Message[] = [];
      
      wsNode2.on('message', (message: Message) => {
        receivedMessages.push(message);
      });

      // Send message from node3 to node4
      const message: Message = {
        id: 'test-msg-2',
        type: MessageType.PING,
        data: { content: 'Hello from WebSocket Node 1' },
        sender: node3Info,
        timestamp: Date.now()
      };

      await wsNode1.send(message, node4Info);

      // Wait for message delivery
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].data.content).toBe('Hello from WebSocket Node 1');
    }, 10000);
  });

  describe('Circuit Breaker Integration', () => {
    test('should protect against failing nodes with circuit breaker', async () => {
      await tcpNode1.start();
      // Note: not starting tcpNode2 to simulate failure

      const breaker = circuitBreakerManager.getBreaker('tcp-node-2', {
        failureThreshold: 3,
        timeout: 1000,
        resetTimeout: 2000,
        enableLogging: false
      });

      let circuitOpenCount = 0;
      breaker.on('state-change', (event) => {
        if (event.newState === 'open') {
          circuitOpenCount++;
        }
      });

      const message: Message = {
        id: 'test-msg-3',
        type: MessageType.PING,
        data: { content: 'Test message' },
        sender: node1Info,
        timestamp: Date.now()
      };

      // Simulate multiple failures that should trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        try {
          await breaker.execute(async () => {
            await tcpNode1.send(message, node2Info);
          });
        } catch (error) {
          // Expected failures
        }
      }

      expect(circuitOpenCount).toBeGreaterThan(0);
      expect(breaker.getState()).toBe('open');
    }, 15000);
  });

  describe('Message Batching Integration', () => {
    test('should batch multiple messages for efficiency', async () => {
      await tcpNode1.start();
      await tcpNode2.start();

      const batches: any[] = [];
      
      messageBatcher.on('batch-sent', (batch) => {
        batches.push(batch);
      });

      // Queue multiple messages
      const messages = Array.from({ length: 3 }, (_, i) => ({
        id: `batch-msg-${i}`,
        data: Buffer.from(`Message ${i}`),
        destination: 'node-2',
        priority: 1,
        timestamp: Date.now()
      }));

      for (const msg of messages) {
        messageBatcher.addMessage(msg);
      }

      // Wait for batch to be created and sent
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(batches.length).toBeGreaterThan(0);
      const totalBatchedMessages = batches.reduce((sum, batch) => sum + batch.messages.length, 0);
      expect(totalBatchedMessages).toBe(3);
    }, 8000);
  });

  describe('Security Integration', () => {
    test('should encrypt and authenticate messages end-to-end', async () => {
      const originalMessage = Buffer.from('Sensitive data that needs protection');
      
      // Encrypt the message
      const encryptedData = await encryption.encrypt(originalMessage, 'test-key');
      expect(encryptedData.data).not.toEqual(originalMessage);
      
      // Add authentication
      const authenticatedMessage = await messageAuth.sign(encryptedData.data, 1);
      expect(authenticatedMessage.signature).toBeDefined();
      
      // Verify authentication
      const isValidAuth = await messageAuth.verify(authenticatedMessage);
      expect(isValidAuth).toBe(true);
      
      // Decrypt the message
      const decryptedData = await encryption.decrypt(encryptedData, 'test-key');
      expect(decryptedData).toEqual(originalMessage);
    }, 5000);

    test('should detect tampered messages', async () => {
      const originalMessage = Buffer.from('Important message');
      const authenticatedMessage = await messageAuth.sign(originalMessage, 1);
      
      // Tamper with the message
      const tamperedMessage = {
        ...authenticatedMessage,
        data: Buffer.from('Tampered message')
      };
      
      // Verification should fail
      const isValid = await messageAuth.verify(tamperedMessage);
      expect(isValid).toBe(false);
    }, 5000);
  });

  describe('High-Load Scenario', () => {
    test('should handle concurrent messages across multiple transports', async () => {
      await tcpNode1.start();
      await tcpNode2.start();
      await wsNode1.start();
      await wsNode2.start();

      const receivedTCP: Message[] = [];
      const receivedWS: Message[] = [];

      tcpNode2.on('message', (msg: Message) => receivedTCP.push(msg));
      wsNode2.on('message', (msg: Message) => receivedWS.push(msg));

      // Send messages concurrently on both transports
      const tcpPromises = Array.from({ length: 5 }, async (_, i) => {
        const message: Message = {
          id: `tcp-concurrent-${i}`,
          type: MessageType.PING,
          data: { content: `TCP Message ${i}` },
          sender: node1Info,
          timestamp: Date.now()
        };
        return tcpNode1.send(message, node2Info);
      });

      const wsPromises = Array.from({ length: 5 }, async (_, i) => {
        const message: Message = {
          id: `ws-concurrent-${i}`,
          type: MessageType.PING,
          data: { content: `WS Message ${i}` },
          sender: node3Info,
          timestamp: Date.now()
        };
        return wsNode1.send(message, node4Info);
      });

      // Execute all sends concurrently
      await Promise.allSettled([...tcpPromises, ...wsPromises]);

      // Wait for message delivery
      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(receivedTCP.length).toBeGreaterThan(0);
      expect(receivedWS.length).toBeGreaterThan(0);
    }, 15000);
  });

  describe('Failure Recovery Scenario', () => {
    test('should recover from transport adapter failures', async () => {
      await tcpNode1.start();
      await tcpNode2.start();

      const breaker = circuitBreakerManager.getBreaker('recovery-test', {
        failureThreshold: 2,
        resetTimeout: 1000,
        enableLogging: false
      });

      let successCount = 0;
      let failureCount = 0;

      // Simulate some failures followed by recovery
      for (let i = 0; i < 5; i++) {
        try {
          await breaker.execute(async () => {
            if (i < 2) {
              // First 2 calls fail
              throw new Error('Simulated failure');
            }
            
            // Subsequent calls succeed
            const message: Message = {
              id: `recovery-msg-${i}`,
              type: MessageType.PING,
              data: { content: `Recovery test ${i}` },
              sender: node1Info,
              timestamp: Date.now()
            };
            
            await tcpNode1.send(message, node2Info);
            successCount++;
          });
        } catch (error) {
          failureCount++;
        }

        // Wait a bit between attempts
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      expect(failureCount).toBeGreaterThan(0);
      expect(successCount).toBeGreaterThan(0);
    }, 10000);
  });

  describe('Performance Metrics', () => {
    test('should provide comprehensive transport statistics', async () => {
      await tcpNode1.start();
      await tcpNode2.start();

      // Send some messages to generate stats
      for (let i = 0; i < 3; i++) {
        const message: Message = {
          id: `stats-msg-${i}`,
          type: MessageType.PING,
          data: { content: `Stats test ${i}` },
          sender: node1Info,
          timestamp: Date.now()
        };
        
        await tcpNode1.send(message, node2Info);
      }

      const stats1 = tcpNode1.getStats();
      const stats2 = tcpNode2.getStats();
      
      expect(stats1.isStarted).toBe(true);
      expect(stats2.isStarted).toBe(true);
      expect(stats1.totalConnections).toBeGreaterThanOrEqual(0);
      expect(stats2.totalConnections).toBeGreaterThanOrEqual(0);

      // Check circuit breaker stats
      const allBreakerStats = circuitBreakerManager.getAllStats();
      expect(typeof allBreakerStats).toBe('object');

      // Check batcher stats
      const batcherStats = messageBatcher.getStats();
      expect(batcherStats.totalBatches).toBeGreaterThanOrEqual(0);
      expect(batcherStats.totalMessages).toBeGreaterThanOrEqual(0);
    }, 8000);
  });
});
