import { TCPAdapter } from '../TCPAdapter';
import { NodeId, Message, MessageType } from '../../../types';

describe('TCPAdapter', () => {
  let adapter1: TCPAdapter;
  let adapter2: TCPAdapter;
  let node1: NodeId;
  let node2: NodeId;

  beforeEach(() => {
    node1 = { id: 'node1', address: '127.0.0.1', port: 3001 };
    node2 = { id: 'node2', address: '127.0.0.1', port: 3002 };
    
    adapter1 = new TCPAdapter(node1);
    adapter2 = new TCPAdapter(node2);
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

    it('should auto-connect on first send', async () => {
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: { test: 'data' },
        sender: node1,
        timestamp: Date.now()
      };

      expect(adapter1.getConnectedNodes()).toEqual([]);

      await adapter1.send(message, node2);
      
      const connectedNodes = adapter1.getConnectedNodes();
      expect(connectedNodes).toHaveLength(1);
      expect(connectedNodes[0].id).toBe(node2.id);
    });

    it('should maintain persistent connections', async () => {
      const message1: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      const message2: Message = {
        id: 'msg2',
        type: MessageType.PONG,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      await adapter1.send(message1, node2);
      expect(adapter1.getConnectedNodes()).toHaveLength(1);

      await adapter1.send(message2, node2);
      expect(adapter1.getConnectedNodes()).toHaveLength(1); // Should reuse connection
    });

    it('should handle connection to multiple nodes', async () => {
      const node3: NodeId = { id: 'node3', address: '127.0.0.1', port: 3003 };
      
      const message1: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      await adapter1.send(message1, node2);
      await adapter1.send(message1, node3);
      
      const connectedNodes = adapter1.getConnectedNodes();
      expect(connectedNodes).toHaveLength(2);
      expect(connectedNodes.map(n => n.id)).toContain(node2.id);
      expect(connectedNodes.map(n => n.id)).toContain(node3.id);
    });

    it('should disconnect from a node', async () => {
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      await adapter1.send(message, node2);
      expect(adapter1.getConnectedNodes()).toHaveLength(1);

      await adapter1.disconnect(node2);
      expect(adapter1.getConnectedNodes()).toEqual([]);
    });

    it('should handle disconnect from non-connected node', async () => {
      await adapter1.disconnect(node2); // Should not throw
      expect(adapter1.getConnectedNodes()).toEqual([]);
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
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(messageHandler).toHaveBeenCalledWith(message);
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
        .rejects.toThrow('TCP server not started');
    });

    it('should handle bidirectional communication', async () => {
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
      
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      // Should handle gracefully without throwing
      await adapter1.send(message, invalidNode);
      expect(adapter1.getConnectedNodes()).toHaveLength(1); // Connection attempt was made
    });

    it('should emit connection events', async () => {
      const connectedSpy = jest.fn();
      const disconnectedSpy = jest.fn();
      
      (adapter1 as any).on('connected', connectedSpy);
      (adapter1 as any).on('disconnected', disconnectedSpy);

      await adapter1.start();
      
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      await adapter1.send(message, node2); // Auto-connect
      expect(connectedSpy).toHaveBeenCalledWith(node2);

      await adapter1.disconnect(node2);
      expect(disconnectedSpy).toHaveBeenCalledWith(node2);
    });
  });

  describe('cleanup', () => {
    it('should close all connections on stop', async () => {
      await adapter1.start();
      
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      await adapter1.send(message, node2);
      expect(adapter1.getConnectedNodes()).toHaveLength(1);

      await adapter1.stop();
      expect(adapter1.getConnectedNodes()).toEqual([]);
    });

    it('should handle stop with active connections', async () => {
      await adapter1.start();
      await adapter2.start();
      
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      await adapter1.send(message, node2);
      await adapter2.send(message, node1);

      // Both should stop cleanly
      await adapter1.stop();
      await adapter2.stop();

      expect(adapter1.getConnectedNodes()).toEqual([]);
      expect(adapter2.getConnectedNodes()).toEqual([]);
    });
  });

  describe('connection state', () => {
    beforeEach(async () => {
      await adapter1.start();
    });

    it('should check connection status correctly', async () => {
      expect(adapter1.isConnected(node2)).toBe(false);

      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      await adapter1.send(message, node2);
      expect(adapter1.isConnected(node2)).toBe(true);

      await adapter1.disconnect(node2);
      expect(adapter1.isConnected(node2)).toBe(false);
    });
  });
});
