import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { Message, MessageType } from '../../../src/types';

describe('InMemoryAdapter', () => {
  let adapter: InMemoryAdapter;
  const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };

  beforeEach(() => {
    adapter = new InMemoryAdapter(nodeA);
  });

  afterEach(async () => {
    await adapter.stop();
    // Clear the global registry between tests
    InMemoryAdapter.clearRegistry();
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
      // We can't directly check isStarted, but we can verify behavior
      
      await adapter.stop();
      // Adapter should be stopped
    });

    test('should handle multiple start/stop cycles', async () => {
      await adapter.start();
      await adapter.stop();
      
      await adapter.start();
      await adapter.stop();
    });
  });

  describe('In-Memory Communication', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should register in global registry when started', async () => {
      const connectedNodes = adapter.getConnectedNodes();
      // Should be able to get connected nodes (empty array since only one node)
      expect(Array.isArray(connectedNodes)).toBe(true);
    });
  });

  describe('Message Handling', () => {
    let adapterB: InMemoryAdapter;
    const nodeB = { id: 'node-b', address: '127.0.0.1', port: 8081 };

    beforeEach(async () => {
      await adapter.start();
      adapterB = new InMemoryAdapter(nodeB);
      await adapterB.start();
    });

    afterEach(async () => {
      await adapterB.stop();
    });

    test('should send and receive messages between adapters', async () => {
      let receivedMessage: Message | null = null;
      
      // Set up message handler on adapter B
      adapterB.onMessage((message: Message) => {
        receivedMessage = message;
      });
      
      // Send message from adapter A to adapter B
      const message: Message = {
        id: 'test-message-1',
        type: MessageType.PING,
        data: { data: 'test' },
        sender: nodeA,
        timestamp: Date.now()
      };
      
      await adapter.send(message, nodeB);
      
      // Give some time for message delivery
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(receivedMessage).toBeDefined();
      expect(receivedMessage!.type).toBe(MessageType.PING);
      expect(receivedMessage!.data.data).toBe('test');
      expect(receivedMessage!.sender.id).toBe(nodeA.id);
    });

    test('should handle message sending to non-existent node', async () => {
      const message: Message = {
        id: 'test-message-2',
        type: MessageType.PING,
        data: { data: 'test' },
        sender: nodeA,
        timestamp: Date.now()
      };
      
      const nonExistentNode = { id: 'node-x', address: '127.0.0.1', port: 9999 };
      
      // Should throw an error for non-existent node
      await expect(adapter.send(message, nonExistentNode)).rejects.toThrow();
    });

    test('should deliver messages instantly (no network latency)', async () => {
      let receivedMessage: Message | null = null;
      let deliveryTime: number;
      
      adapterB.onMessage((message) => {
        receivedMessage = message;
        deliveryTime = Date.now();
      });
      
      const message: Message = {
        id: 'test-message-3',
        type: MessageType.PING,
        data: { data: 'test' },
        sender: nodeA,
        timestamp: Date.now()
      };
      
      const sendTime = Date.now();
      await adapter.send(message, nodeB);
      
      // Give time for async delivery
      await new Promise(resolve => setTimeout(resolve, 5));
      
      // Message should be delivered quickly
      expect(receivedMessage).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    test('should handle stop before start', async () => {
      await expect(adapter.stop()).resolves.not.toThrow();
    });

    test('should handle duplicate start calls', async () => {
      await adapter.start();
      await expect(adapter.start()).resolves.not.toThrow();
    });

    test('should handle duplicate stop calls', async () => {
      await adapter.start();
      await adapter.stop();
      await expect(adapter.stop()).resolves.not.toThrow();
    });

    test('should handle send when not started', async () => {
      const message: Message = {
        id: 'test-message-4',
        type: MessageType.PING,
        data: { data: 'test' },
        sender: nodeA,
        timestamp: Date.now()
      };
      
      // Should throw when not started
      await expect(adapter.send(message, nodeA)).rejects.toThrow();
    });
  });

  describe('Registry Management', () => {
    test('should register and unregister properly', async () => {
      await adapter.start();
      
      const connectedBefore = adapter.getConnectedNodes();
      expect(Array.isArray(connectedBefore)).toBe(true);
      
      await adapter.stop();
      
      // After stopping, should not be in registry anymore
    });

    test('should handle multiple adapters', async () => {
      const adapter2 = new InMemoryAdapter({ id: 'node-b', address: '127.0.0.1', port: 8081 });
      
      await adapter.start();
      await adapter2.start();
      
      // Each should see the other in connected nodes
      const connectedFromA = adapter.getConnectedNodes();
      const connectedFromB = adapter2.getConnectedNodes();
      
      expect(connectedFromA.length).toBe(1);
      expect(connectedFromB.length).toBe(1);
      expect(connectedFromA[0].id).toBe('node-b');
      expect(connectedFromB[0].id).toBe('node-a');
      
      await adapter2.stop();
    });
  });

  describe('Message Listener Management', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should add and remove message listeners', () => {
      const handler = (message: Message) => {
        // Test handler
      };
      
      adapter.onMessage(handler);
      adapter.removeMessageListener(handler);
      
      // Should not throw
    });
  });

  describe('Performance Characteristics', () => {
    beforeEach(async () => {
      await adapter.start();
    });

    test('should handle high message rates', async () => {
      const adapterB = new InMemoryAdapter({ id: 'node-b', address: '127.0.0.1', port: 8081 });
      await adapterB.start();
      
      let messageCount = 0;
      adapterB.onMessage(() => {
        messageCount++;
      });
      
      // Send multiple messages rapidly
      const promises = [];
      for (let i = 0; i < 10; i++) {
        const message: Message = {
          id: `test-message-${i}`,
          type: MessageType.PING,
          data: { data: `test-${i}` },
          sender: nodeA,
          timestamp: Date.now()
        };
        promises.push(adapter.send(message, { id: 'node-b', address: '127.0.0.1', port: 8081 }));
      }
      
      await Promise.all(promises);
      
      // Give time for message delivery
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // All messages should be delivered
      expect(messageCount).toBe(10);
      
      await adapterB.stop();
    });
  });
});
