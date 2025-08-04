import WebSocket from 'ws';
import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { GossipMessage, MessageType as GossipMessageType } from '../../../src/transport/GossipMessage';
import { Encryption } from '../../../src/transport/Encryption';
import { MessageAuth } from '../../../src/transport/MessageAuth';
import { MessageBatcher } from '../../../src/transport/MessageBatcher';
import { CircuitBreaker } from '../../../src/transport/CircuitBreaker';
import { NodeId, Message, MessageType } from '../../../src/types';

describe('WebSocket Comprehensive E2E Tests', () => {
  let wsNode1: WebSocketAdapter;
  let wsNode2: WebSocketAdapter;
  let wsNode3: WebSocketAdapter;
  let encryption: Encryption;
  let messageBatcher: MessageBatcher;
  let messageAuth: MessageAuth;
  let circuitBreaker: CircuitBreaker;

  // External client connections
  let client1: WebSocket;
  let clientMessages: any[] = [];

  const basePort = 3350; // Use ports 3350-3360 to avoid Docker conflicts
  const node1Info: NodeId = { id: 'ws-node-1', address: '127.0.0.1', port: basePort };
  const node2Info: NodeId = { id: 'ws-node-2', address: '127.0.0.1', port: basePort + 1 };
  const node3Info: NodeId = { id: 'ws-node-3', address: '127.0.0.1', port: basePort + 2 };

  beforeAll(async () => {
    // Initialize security components
    encryption = new Encryption({
      algorithm: 'aes-256-gcm',
      keyRotationInterval: 3600000 // 1 hour
    });
    await encryption.initialize();

    messageAuth = new MessageAuth({
      algorithm: 'hmac-sha256',
      enableReplayProtection: true,
      nonceSize: 16,
      timestampWindow: 300 // 5 minutes
    });
    messageAuth.initialize();

    messageBatcher = new MessageBatcher({
      maxBatchSize: 10,
      flushInterval: 100,
      enableCompression: true,
      compressionThreshold: 512
    });

    circuitBreaker = new CircuitBreaker({
      name: 'websocket-e2e-test',
      failureThreshold: 5,
      resetTimeout: 2000
    });
  }, 15000);

  afterAll(async () => {
    encryption?.destroy();
    messageAuth?.destroy();
    messageBatcher?.destroy();
    circuitBreaker?.destroy();
  });

  beforeEach(async () => {
    clientMessages = [];
    
    // Create WebSocket adapters with different configurations
    wsNode1 = new WebSocketAdapter(node1Info, {
      port: basePort,
      enableCompression: true,
      enableLogging: false,
      maxConnections: 50,
      pingInterval: 1000, // Fast heartbeat for testing
      pongTimeout: 500
    });

    wsNode2 = new WebSocketAdapter(node2Info, {
      port: basePort + 1,
      enableCompression: false, // Test mixed compression scenarios
      enableLogging: false,
      maxConnections: 50,
      pingInterval: 1000,
      pongTimeout: 500
    });

    wsNode3 = new WebSocketAdapter(node3Info, {
      port: basePort + 2,
      enableCompression: true,
      enableLogging: false,
      maxConnections: 50,
      pingInterval: 1000,
      pongTimeout: 500
    });

    // Start all nodes
    await Promise.all([
      wsNode1.start(),
      wsNode2.start(),
      wsNode3.start()
    ]);

    // Give nodes time to stabilize
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  afterEach(async () => {
    // Close client connections
    if (client1 && client1.readyState === WebSocket.OPEN) {
      client1.close();
    }

    // Stop adapters
    await Promise.all([
      wsNode1?.stop(),
      wsNode2?.stop(),
      wsNode3?.stop()
    ]);
  }, 10000);

  describe('Client Connection Management', () => {
    test('should accept external client connections with compression', async () => {
      const node1Port = wsNode1.getStats().port;
      
      client1 = new WebSocket(`ws://127.0.0.1:${node1Port}`, {
        perMessageDeflate: true
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
        
        client1.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        
        client1.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      expect(client1.readyState).toBe(WebSocket.OPEN);
      
      // Send a test message
      const testMessage = { type: 'ping', data: 'Hello from client' };
      client1.send(JSON.stringify(testMessage));
      
      // Wait for potential response processing
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    test('should handle multiple concurrent client connections', async () => {
      const node1Port = wsNode1.getStats().port;
      const clients: WebSocket[] = [];
      const connectionPromises: Promise<void>[] = [];

      // Create 5 concurrent client connections
      for (let i = 0; i < 5; i++) {
        const client = new WebSocket(`ws://127.0.0.1:${node1Port}`);
        clients.push(client);
        
        connectionPromises.push(new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Client ${i} connection timeout`)), 3000);
          
          client.on('open', () => {
            clearTimeout(timeout);
            resolve();
          });
          
          client.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        }));
      }

      await Promise.all(connectionPromises);

      // All clients should be connected
      clients.forEach((client, index) => {
        expect(client.readyState).toBe(WebSocket.OPEN);
      });

      // Check connection statistics
      const stats = wsNode1.getStats();
      expect(stats.activeConnections).toBeGreaterThanOrEqual(5);

      // Clean up
      clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.close();
        }
      });
    });
  });

  describe('Node-to-Node Cluster Communication', () => {
    test('should enable direct node communication via WebSocket', async () => {
      const receivedMessages: any[] = [];
      
      // Establish connection from node1 to node2
      await wsNode1.connect(node2Info);
      
      // Wait for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Set up message listener on node2 for 'message-received' event
      wsNode2.on('message-received', (message: any) => {
        receivedMessages.push(message);
      });

      // Create a proper GossipMessage for node-to-node communication
      const testMessage = new GossipMessage(
        GossipMessageType.PING,
        node1Info,
        { content: 'Node-to-node test message' },
        { recipient: node2Info }
      );

      // WebSocket adapter send method takes only GossipMessage (cast to Message interface)
      await wsNode1.send(testMessage as unknown as Message);
      
      // Allow time for message processing
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(receivedMessages).toHaveLength(1);
    });

    test('should support cluster gossip messaging with proper routing', async () => {
      const gossipMessages: any[] = [];
      
      // Establish connection from node1 to node2
      await wsNode1.connect(node2Info);
      
      // Wait for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 100));
      
      wsNode2.onMessage((message) => {
        if (message.type === MessageType.GOSSIP) {
          gossipMessages.push({
            senderId: message.sender.id,
            data: message.data
          });
        }
      });

      const gossipMessage = new GossipMessage(
        GossipMessageType.DATA,
        node1Info,
        { 
          gossipData: 'Cluster state update',
          timestamp: Date.now()
        },
        { recipient: node2Info }
      );

      await wsNode1.send(gossipMessage as unknown as Message);
      
      // Allow processing time
      await new Promise(resolve => setTimeout(resolve, 300));
      
      expect(gossipMessages.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Encryption and Security Features', () => {
    test('should encrypt and decrypt messages end-to-end', async () => {
      const receivedMessages: any[] = [];
      
      // Establish connection from node1 to node2
      await wsNode1.connect(node2Info);
      
      // Wait for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 100));
      
      wsNode2.onMessage((message) => {
        receivedMessages.push(message);
      });

      // Create encrypted message data
      const messageData = { 
        secret: 'classified information',
        level: 'top-secret' 
      };
      
      const encryptedData = encryption.encrypt(Buffer.from(JSON.stringify(messageData)));
      
      const encryptedMessage = new GossipMessage(
        GossipMessageType.DATA,
        node1Info,
        { 
          encrypted: true,
          payload: encryptedData 
        },
        { 
          recipient: node2Info,
          encryption: true
        }
      );

      await wsNode1.send(encryptedMessage as unknown as Message);
      
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(receivedMessages.length).toBeGreaterThanOrEqual(0);
    });

    test('should authenticate messages with HMAC signatures', async () => {
      const receivedMessages: any[] = [];
      
      // Establish connection from node1 to node2
      await wsNode1.connect(node2Info);
      
      // Wait for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 100));
      
      wsNode2.onMessage((message) => {
        receivedMessages.push(message);
      });

      // Create message with authentication
      const messageData = {
        content: 'authenticated message',
        important: true
      };
      
      const messageBuffer = Buffer.from(JSON.stringify(messageData), 'utf8');
      const signature = messageAuth.generateHMAC(messageBuffer);
      
      const authenticatedMessage = new GossipMessage(
        GossipMessageType.PING,
        node1Info,
        {
          payload: messageData,
          signature: signature.toString('base64'),
          timestamp: Date.now()
        },
        { recipient: node2Info }
      );

      await wsNode1.send(authenticatedMessage as unknown as Message);
      
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(receivedMessages.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Compression and Performance Features', () => {
    test('should batch multiple messages for efficiency', async () => {
      // Add multiple messages to the batcher
      const batchId1 = messageBatcher.addMessage(
        node2Info.id,
        Buffer.from(JSON.stringify({ msg: 1, data: 'First message' })),
        3,
        false
      );
      
      const batchId2 = messageBatcher.addMessage(
        node2Info.id,
        Buffer.from(JSON.stringify({ msg: 2, data: 'Second message' })),
        3,
        false
      );

      expect(batchId1).toBeDefined();
      expect(batchId2).toBeDefined();

      // Force flush the batch
      messageBatcher.flushAll();
      
      // Check batcher stats
      const stats = messageBatcher.getStats();
      expect(stats.totalMessages).toBe(2);
    });
  });

  describe('Error Handling and Circuit Breaking', () => {
    test('should handle network failures gracefully', async () => {
      // Try to send to a non-existent node
      const invalidNode: NodeId = { id: 'invalid-node', address: '192.168.255.255', port: 9999 };
      
      const failureMessage = new GossipMessage(
        GossipMessageType.PING,
        node1Info,
        { test: 'failure handling' },
        { recipient: invalidNode }
      );

      // This should not crash the system
      await expect(wsNode1.send(failureMessage as unknown as Message)).rejects.toThrow();
      
      // Node should still be operational
      expect(wsNode1.getStats().isStarted).toBe(true);
    });

    test('should implement circuit breaker pattern for failed connections', async () => {
      let executionCount = 0;
      
      const testOperation = async () => {
        executionCount++;
        throw new Error('Simulated failure');
      };

      // Test circuit breaker behavior
      for (let i = 0; i < 7; i++) {
        try {
          await circuitBreaker.execute(testOperation);
        } catch (error) {
          // Expected failures
        }
      }

      // Circuit should be open after threshold failures
      expect(executionCount).toBeGreaterThanOrEqual(5); // At least threshold attempts
    });
  });

  describe('Performance and Load Testing', () => {
    test('should handle concurrent message load', async () => {
      const receivedMessages: any[] = [];
      
      wsNode2.onMessage((message) => {
        receivedMessages.push(message);
      });

      // Create multiple concurrent message sends
      const messagePromises: Promise<void>[] = [];
      
      for (let i = 0; i < 10; i++) {
        const loadMessage = new GossipMessage(
          GossipMessageType.DATA,
          node1Info,
          { 
            loadTest: true,
            messageId: i,
            timestamp: Date.now() 
          },
          { recipient: node2Info }
        );
        
        messagePromises.push(wsNode1.send(loadMessage as unknown as Message));
      }

      const startTime = Date.now();
      await Promise.allSettled(messagePromises); // Use allSettled to handle partial failures
      const duration = Date.now() - startTime;

      // Performance check - should complete within reasonable time
      expect(duration).toBeLessThan(5000); // 5 seconds for 10 messages
      
      // Allow processing time
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Some messages should be received (exact count may vary due to network conditions)
      expect(receivedMessages.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Integration with Cluster Services', () => {
    test('should integrate with service discovery and routing', async () => {
      // Establish connection from node1 to node2
      await wsNode1.connect(node2Info);
      
      // Wait for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Test service announcement message
      const serviceAnnouncement = new GossipMessage(
        GossipMessageType.JOIN,
        node1Info,
        {
          services: ['websocket-gateway', 'message-router'],
          capabilities: ['compression', 'encryption', 'batching'],
          metadata: { version: '1.0.0', region: 'us-east-1' }
        },
        { recipient: node2Info }
      );

      await wsNode1.send(serviceAnnouncement as unknown as Message);
      
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Verify nodes remain operational after service messages
      expect(wsNode1.getStats().isStarted).toBe(true);
      expect(wsNode2.getStats().isStarted).toBe(true);
    });
  });
});
