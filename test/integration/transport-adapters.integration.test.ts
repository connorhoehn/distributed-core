import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';
import { MessageType, Message } from '../../src/types';

describe('Transport Adapters Integration', () => {
  const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };
  const nodeB = { id: 'node-b', address: '127.0.0.1', port: 8081 };

  afterEach(() => {
    // Clear in-memory registry between tests
    InMemoryAdapter.clearRegistry();
  });

  describe('InMemory Adapter Integration', () => {
    let adapterA: InMemoryAdapter;
    let adapterB: InMemoryAdapter;

    beforeEach(async () => {
      adapterA = new InMemoryAdapter(nodeA);
      adapterB = new InMemoryAdapter(nodeB);
      await adapterA.start();
      await adapterB.start();
    });

    afterEach(async () => {
      await adapterA.stop();
      await adapterB.stop();
    });

    test('should enable bidirectional communication', async () => {
      let messageFromA: Message | null = null;
      let messageFromB: Message | null = null;

      // Set up message handlers
      adapterA.onMessage((message) => {
        messageFromA = message;
      });

      adapterB.onMessage((message) => {
        messageFromB = message;
      });

      // Send message A -> B
      const messageAtoB: Message = {
        id: 'msg-a-to-b',
        type: MessageType.PING,
        data: { content: 'hello from A' },
        sender: nodeA,
        timestamp: Date.now()
      };

      await adapterA.send(messageAtoB, nodeB);

      // Send message B -> A
      const messageBtoA: Message = {
        id: 'msg-b-to-a',
        type: MessageType.PONG,
        data: { content: 'hello from B' },
        sender: nodeB,
        timestamp: Date.now()
      };

      await adapterB.send(messageBtoA, nodeA);

      // Wait for message delivery
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify messages were received
      expect(messageFromB).toBeDefined();
      expect((messageFromB as any)?.type).toBe(MessageType.PING);
      expect((messageFromB as any)?.data.content).toBe('hello from A');

      expect(messageFromA).toBeDefined();
      expect((messageFromA as any)?.type).toBe(MessageType.PONG);
      expect((messageFromA as any)?.data.content).toBe('hello from B');
    });

    test('should handle multiple nodes in network', async () => {
      const nodeC = { id: 'node-c', address: '127.0.0.1', port: 8082 };
      const adapterC = new InMemoryAdapter(nodeC);
      await adapterC.start();

      let messagesReceived = 0;
      
      adapterC.onMessage(() => {
        messagesReceived++;
      });

      // Send messages from A and B to C
      const messageFromA: Message = {
        id: 'msg-from-a',
        type: MessageType.GOSSIP,
        data: { content: 'broadcast from A' },
        sender: nodeA,
        timestamp: Date.now()
      };

      const messageFromB: Message = {
        id: 'msg-from-b',
        type: MessageType.GOSSIP,
        data: { content: 'broadcast from B' },
        sender: nodeB,
        timestamp: Date.now()
      };

      await adapterA.send(messageFromA, nodeC);
      await adapterB.send(messageFromB, nodeC);

      // Wait for message delivery
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(messagesReceived).toBe(2);

      await adapterC.stop();
    });

    test('should track connected nodes correctly', async () => {
      const connectedFromA = adapterA.getConnectedNodes();
      const connectedFromB = adapterB.getConnectedNodes();

      expect(connectedFromA.length).toBe(1);
      expect(connectedFromB.length).toBe(1);
      expect(connectedFromA[0].id).toBe('node-b');
      expect(connectedFromB[0].id).toBe('node-a');
    });
  });
});
