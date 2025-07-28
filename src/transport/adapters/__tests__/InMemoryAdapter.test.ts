import { InMemoryAdapter } from '../InMemoryAdapter';
import { NodeId, Message, MessageType } from '../../../types';

describe('InMemoryAdapter', () => {
  let adapter1: InMemoryAdapter;
  let adapter2: InMemoryAdapter;
  let node1: NodeId;
  let node2: NodeId;

  beforeEach(() => {
    InMemoryAdapter.clearRegistry();
    
    node1 = { id: 'node1', address: '127.0.0.1', port: 3001 };
    node2 = { id: 'node2', address: '127.0.0.1', port: 3002 };
    
    adapter1 = new InMemoryAdapter(node1);
    adapter2 = new InMemoryAdapter(node2);
  });

  afterEach(async () => {
    await adapter1.stop();
    await adapter2.stop();
    InMemoryAdapter.clearRegistry();
  });

  describe('lifecycle', () => {
    it('should start successfully', async () => {
      const startedSpy = jest.fn();
      (adapter1 as any).on('started', startedSpy);

      await adapter1.start();
      expect(startedSpy).toHaveBeenCalled();
    });

    it('should stop successfully', async () => {
      const stoppedSpy = jest.fn();
      (adapter1 as any).on('stopped', stoppedSpy);

      await adapter1.start();
      await adapter1.stop();
      
      expect(stoppedSpy).toHaveBeenCalled();
    });

    it('should handle multiple start calls gracefully', async () => {
      await adapter1.start();
      await adapter1.start(); // Should not throw
      
      expect(adapter1.getConnectedNodes()).toEqual([]);
    });

    it('should handle stop without start', async () => {
      await adapter1.stop(); // Should not throw
    });
  });

  describe('messaging', () => {
    beforeEach(async () => {
      await adapter1.start();
      await adapter2.start();
    });

    it('should send message between adapters', async () => {
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: { test: 'data' },
        sender: node1,
        timestamp: Date.now()
      };

      const messageHandler = jest.fn();
      adapter2.onMessage(messageHandler);

      await adapter1.send(message, node2);

      // Wait for async delivery
      await new Promise(resolve => setTimeout(resolve, 0));
      
      expect(messageHandler).toHaveBeenCalledWith(message);
    });

    it('should throw error when sending to non-existent node', async () => {
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      const nonExistentNode: NodeId = { id: 'ghost', address: '127.0.0.1', port: 9999 };
      
      await expect(adapter1.send(message, nonExistentNode))
        .rejects.toThrow('Target node ghost not found');
    });

    it('should throw error when sending from stopped adapter', async () => {
      await adapter1.stop();

      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      await expect(adapter1.send(message, node2))
        .rejects.toThrow('Adapter not started');
    });

    it('should remove message listeners', async () => {
      const messageHandler = jest.fn();
      adapter2.onMessage(messageHandler);
      adapter2.removeMessageListener(messageHandler);

      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      await adapter1.send(message, node2);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(messageHandler).not.toHaveBeenCalled();
    });
  });

  describe('registry management', () => {
    it('should track connected nodes', async () => {
      expect(adapter1.getConnectedNodes()).toEqual([]);

      await adapter1.start();
      expect(adapter1.getConnectedNodes()).toEqual([]);

      await adapter2.start();
      expect(adapter1.getConnectedNodes()).toEqual([node2]);
      expect(adapter2.getConnectedNodes()).toEqual([node1]);
    });

    it('should remove nodes from registry on stop', async () => {
      await adapter1.start();
      await adapter2.start();

      expect(adapter1.getConnectedNodes()).toEqual([node2]);

      await adapter2.stop();
      expect(adapter1.getConnectedNodes()).toEqual([]);
    });

    it('should clear entire registry', async () => {
      await adapter1.start();
      await adapter2.start();

      expect(adapter1.getConnectedNodes()).toEqual([node2]);

      InMemoryAdapter.clearRegistry();
      expect(adapter1.getConnectedNodes()).toEqual([]);
    });
  });

  describe('multiple nodes', () => {
    it('should handle multiple nodes communication', async () => {
      const node3: NodeId = { id: 'node3', address: '127.0.0.1', port: 3003 };
      const adapter3 = new InMemoryAdapter(node3);

      await adapter1.start();
      await adapter2.start();
      await adapter3.start();

      const messageHandler1 = jest.fn();
      const messageHandler2 = jest.fn();
      const messageHandler3 = jest.fn();

      adapter1.onMessage(messageHandler1);
      adapter2.onMessage(messageHandler2);
      adapter3.onMessage(messageHandler3);

      const message: Message = {
        id: 'broadcast',
        type: MessageType.MEMBERSHIP_UPDATE,
        data: { nodes: ['node1', 'node2', 'node3'] },
        sender: node1,
        timestamp: Date.now()
      };

      // Send from node1 to node2 and node3
      await adapter1.send(message, node2);
      await adapter1.send(message, node3);

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(messageHandler1).not.toHaveBeenCalled(); // sender doesn't receive
      expect(messageHandler2).toHaveBeenCalledWith(message);
      expect(messageHandler3).toHaveBeenCalledWith(message);

      await adapter3.stop();
    });
  });
});
