import { WebSocketAdapter } from '../WebSocketAdapter';
import { NodeId, Message, MessageType } from '../../../types';

describe('WebSocketAdapter', () => {
  let adapter1: WebSocketAdapter;
  let adapter2: WebSocketAdapter;
  let node1: NodeId;
  let node2: NodeId;

  beforeEach(() => {
    node1 = { id: 'node1', address: '127.0.0.1', port: 3001 };
    node2 = { id: 'node2', address: '127.0.0.1', port: 3002 };
    
    adapter1 = new WebSocketAdapter(node1);
    adapter2 = new WebSocketAdapter(node2);
  });

  afterEach(async () => {
    await adapter1.stop();
    await adapter2.stop();
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

  describe('connection management', () => {
    beforeEach(async () => {
      await adapter1.start();
      await adapter2.start();
    });

    it('should connect to a node', async () => {
      await adapter1.connect(node2);
      
      const connectedNodes = adapter1.getConnectedNodes();
      expect(connectedNodes).toContain(node2);
    });

    it('should disconnect from a node', async () => {
      await adapter1.connect(node2);
      expect(adapter1.getConnectedNodes()).toContain(node2);

      await adapter1.disconnect(node2);
      expect(adapter1.getConnectedNodes()).not.toContain(node2);
    });

    it('should handle multiple connections', async () => {
      const node3: NodeId = { id: 'node3', address: '127.0.0.1', port: 3003 };
      
      await adapter1.connect(node2);
      await adapter1.connect(node3);
      
      const connectedNodes = adapter1.getConnectedNodes();
      expect(connectedNodes).toHaveLength(2);
      expect(connectedNodes).toContain(node2);
      expect(connectedNodes).toContain(node3);
    });

    it('should handle disconnect from non-connected node', async () => {
      await adapter1.disconnect(node2); // Should not throw
      expect(adapter1.getConnectedNodes()).toEqual([]);
    });

    it('should handle duplicate connections gracefully', async () => {
      await adapter1.connect(node2);
      await adapter1.connect(node2); // Should not duplicate
      
      const connectedNodes = adapter1.getConnectedNodes();
      expect(connectedNodes.filter(n => n.id === node2.id)).toHaveLength(1);
    });
  });

  describe('messaging', () => {
    beforeEach(async () => {
      await adapter1.start();
      await adapter2.start();
      await adapter1.connect(node2);
    });

    it('should send message to connected node', async () => {
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
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(messageHandler).toHaveBeenCalledWith(message);
    });

    it('should throw error when sending to non-connected node', async () => {
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      const nonConnectedNode: NodeId = { id: 'node3', address: '127.0.0.1', port: 3003 };
      
      await expect(adapter1.send(message, nonConnectedNode))
        .rejects.toThrow('Not connected to node node3');
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
        .rejects.toThrow('WebSocket server not started');
    });

    it('should handle bidirectional communication', async () => {
      await adapter2.connect(node1);

      const message1: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: { from: 'node1' },
        sender: node1,
        timestamp: Date.now()
      };

      const message2: Message = {
        id: 'msg2',
        type: MessageType.PONG,
        data: { from: 'node2' },
        sender: node2,
        timestamp: Date.now()
      };

      const messageHandler1 = jest.fn();
      const messageHandler2 = jest.fn();

      adapter1.onMessage(messageHandler1);
      adapter2.onMessage(messageHandler2);

      await adapter1.send(message1, node2);
      await adapter2.send(message2, node1);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(messageHandler1).toHaveBeenCalledWith(message2);
      expect(messageHandler2).toHaveBeenCalledWith(message1);
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
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(messageHandler).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle connection errors gracefully', async () => {
      await adapter1.start();
      
      // Mock a connection error scenario
      const invalidNode: NodeId = { id: 'invalid', address: 'invalid-address', port: -1 };
      
      // Should not throw but log the error
      await adapter1.connect(invalidNode);
      expect(adapter1.getConnectedNodes()).not.toContain(invalidNode);
    });

    it('should emit connection events', async () => {
      const connectedSpy = jest.fn();
      const disconnectedSpy = jest.fn();
      
      (adapter1 as any).on('connected', connectedSpy);
      (adapter1 as any).on('disconnected', disconnectedSpy);

      await adapter1.start();
      await adapter1.connect(node2);
      
      expect(connectedSpy).toHaveBeenCalledWith(node2);

      await adapter1.disconnect(node2);
      expect(disconnectedSpy).toHaveBeenCalledWith(node2);
    });
  });

  describe('cleanup', () => {
    it('should disconnect all connections on stop', async () => {
      await adapter1.start();
      await adapter1.connect(node2);
      
      expect(adapter1.getConnectedNodes()).toContain(node2);

      await adapter1.stop();
      expect(adapter1.getConnectedNodes()).toEqual([]);
    });

    it('should handle stop with active connections', async () => {
      await adapter1.start();
      await adapter2.start();
      
      await adapter1.connect(node2);
      await adapter2.connect(node1);

      // Both should stop cleanly
      await adapter1.stop();
      await adapter2.stop();

      expect(adapter1.getConnectedNodes()).toEqual([]);
      expect(adapter2.getConnectedNodes()).toEqual([]);
    });
  });
});
