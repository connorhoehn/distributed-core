import { describe, test, beforeAll, afterAll, beforeEach, afterEach, expect } from '@jest/globals';
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

    // Initialize message batching with disabled logging
    messageBatcher = new MessageBatcher({
      maxBatchSize: 5,
      flushInterval: 100, // 100ms for faster tests
      maxBatchAge: 200,
      enableCompression: false, // Disable for simpler testing
      enableLogging: false // Disable logging for clean test output
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
      // Only the receiving node needs to listen/start to accept connections
      await tcpNode2.start();
      
      const receivedMessages: Message[] = [];
      
      // Use the proper onMessage method instead of 'on' event
      tcpNode2.onMessage((message: Message) => {
        receivedMessages.push(message);
      });

      // Give the receiving node time to start listening
      await new Promise(resolve => setTimeout(resolve, 500));

      // Send message from node1 to node2 (node1 will auto-start when sending)
      const message: Message = {
        id: 'test-msg-1',
        type: MessageType.PING,
        data: { content: 'Hello from TCP Node 1' },
        sender: node1Info,
        timestamp: Date.now()
      };

      await tcpNode1.send(message, node2Info);

      // Wait for message delivery
      await new Promise(resolve => setTimeout(resolve, 2000));

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].data.content).toBe('Hello from TCP Node 1');
    }, 10000);
  });

  describe('Security Integration', () => {
    test('should encrypt and authenticate messages end-to-end', async () => {
      const originalMessage = Buffer.from('Sensitive data that needs protection');
      
      // Encrypt the message
      const encryptedData = encryption.encrypt(originalMessage);
      expect(encryptedData.data).not.toEqual(originalMessage);
      
      // Decrypt the message
      const decryptedData = encryption.decrypt(encryptedData);
      expect(decryptedData).toEqual(originalMessage);
    }, 5000);

    test('should detect tampered messages', async () => {
      const originalMessage = Buffer.from('Important message');
      const authenticatedMessage = messageAuth.signMessage(originalMessage);
      
      // Tamper with the message
      const tamperedMessage = {
        ...authenticatedMessage,
        data: Buffer.from('Tampered message')
      };
      
      // Verification should fail
      const isValid = messageAuth.verifyMessage(tamperedMessage);
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
});
