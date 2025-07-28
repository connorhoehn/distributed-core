import { HTTPAdapter } from '../HTTPAdapter';
import { NodeId, Message, MessageType } from '../../../types';

describe('HTTPAdapter', () => {
  let adapter1: HTTPAdapter;
  let adapter2: HTTPAdapter;
  let node1: NodeId;
  let node2: NodeId;

  beforeEach(() => {
    node1 = { id: 'node1', address: '127.0.0.1', port: 3001 };
    node2 = { id: 'node2', address: '127.0.0.1', port: 3002 };
    
    adapter1 = new HTTPAdapter(node1);
    adapter2 = new HTTPAdapter(node2);
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

  describe('messaging', () => {
    beforeEach(async () => {
      await adapter1.start();
      await adapter2.start();
    });

    it('should send fire-and-forget message', async () => {
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

    it('should send message with response', async () => {
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: { test: 'data' },
        sender: node1,
        timestamp: Date.now()
      };

      const responseMessage: Message = {
        id: 'response1',
        type: MessageType.PONG,
        data: { response: 'pong' },
        sender: node2,
        timestamp: Date.now()
      };

      // Set up auto-response with shorter timeout
      adapter2.onMessage((msg) => {
        setTimeout(() => {
          adapter2.sendResponse(msg.id, responseMessage);
        }, 10);
      });

      const response = await adapter1.sendWithResponse(message, node2, 100);
      expect(response).toEqual(responseMessage);
    }, 1000);

    it('should timeout on sendWithResponse', async () => {
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: { test: 'data' },
        sender: node1,
        timestamp: Date.now()
      };

      // Don't set up response handler - should timeout quickly
      await expect(adapter1.sendWithResponse(message, node2, 10))
        .rejects.toThrow('Request msg1 timed out');
    }, 1000);

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
        .rejects.toThrow('HTTP server not started');
    });

    it('should handle multiple concurrent requests', async () => {
      const message1: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: { request: 1 },
        sender: node1,
        timestamp: Date.now()
      };

      const message2: Message = {
        id: 'msg2',
        type: MessageType.PING,
        data: { request: 2 },
        sender: node1,
        timestamp: Date.now()
      };

      // Set up auto-response with delay
      adapter2.onMessage(async (msg) => {
        setTimeout(() => {
          const response: Message = {
            id: `response-${msg.id}`,
            type: MessageType.PONG,
            data: { response: msg.data },
            sender: node2,
            timestamp: Date.now()
          };
          adapter2.sendResponse(msg.id, response);
        }, 10);
      });

      const [response1, response2] = await Promise.all([
        adapter1.sendWithResponse(message1, node2, 100),
        adapter1.sendWithResponse(message2, node2, 100)
      ]);

      expect(response1.data).toEqual({ response: { request: 1 } });
      expect(response2.data).toEqual({ response: { request: 2 } });
    }, 1000);

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

  describe('connection management', () => {
    beforeEach(async () => {
      await adapter1.start();
      await adapter2.start();
    });

    it('should track endpoints after sending messages', async () => {
      expect(adapter1.getConnectedNodes()).toEqual([]);

      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      await adapter1.send(message, node2);
      
      const connectedNodes = adapter1.getConnectedNodes();
      expect(connectedNodes).toHaveLength(1);
      expect(connectedNodes[0].id).toBe(node2.id);
    });

    it('should handle messages to multiple nodes', async () => {
      const node3: NodeId = { id: 'node3', address: '127.0.0.1', port: 3003 };
      
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      await adapter1.send(message, node2);
      await adapter1.send(message, node3);
      
      const connectedNodes = adapter1.getConnectedNodes();
      expect(connectedNodes).toHaveLength(2);
      expect(connectedNodes.map(n => n.id)).toContain(node2.id);
      expect(connectedNodes.map(n => n.id)).toContain(node3.id);
    });
  });

  describe('error handling', () => {
    it('should handle invalid target nodes', async () => {
      await adapter1.start();
      
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
      expect(adapter1.getConnectedNodes()).toHaveLength(1); // Request attempt was made
    });

    it('should emit request events', async () => {
      const requestSpy = jest.fn();
      const responseSpy = jest.fn();
      
      (adapter1 as any).on('request', requestSpy);
      (adapter1 as any).on('response', responseSpy);

      await adapter1.start();
      await adapter2.start();
      
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      const responseMessage: Message = {
        id: 'response1',
        type: MessageType.PONG,
        data: {},
        sender: node2,
        timestamp: Date.now()
      };

      adapter2.onMessage((msg) => {
        setTimeout(() => {
          adapter2.sendResponse(msg.id, responseMessage);
        }, 10);
      });

      await adapter1.sendWithResponse(message, node2, 100);
      
      expect(requestSpy).toHaveBeenCalledWith(message, node2);
      expect(responseSpy).toHaveBeenCalledWith(responseMessage);
    }, 1000);
  });

  describe('pending requests', () => {
    beforeEach(async () => {
      await adapter1.start();
      await adapter2.start();
    });

    it('should track pending requests', async () => {
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      // Start request but don't respond
      const responsePromise = adapter1.sendWithResponse(message, node2, 100);
      
      // Check that request is pending
      expect((adapter1 as any).pendingRequests.has('msg1')).toBe(true);

      // Wait for timeout
      await expect(responsePromise).rejects.toThrow('Request msg1 timed out');
      
      // Check that request is cleaned up
      expect((adapter1 as any).pendingRequests.has('msg1')).toBe(false);
    });

    it('should clean up pending requests on stop', async () => {
      const message: Message = {
        id: 'msg1',
        type: MessageType.PING,
        data: {},
        sender: node1,
        timestamp: Date.now()
      };

      // Start request
      const responsePromise = adapter1.sendWithResponse(message, node2, 1000);
      expect((adapter1 as any).pendingRequests.has('msg1')).toBe(true);

      // Stop adapter
      await adapter1.stop();
      
      // Request should be rejected
      await expect(responsePromise).rejects.toThrow('Request msg1 timed out');
      expect((adapter1 as any).pendingRequests.has('msg1')).toBe(false);
    });
  });

  describe('response handling', () => {
    beforeEach(async () => {
      await adapter1.start();
      await adapter2.start();
    });

    it('should handle sendResponse without pending request', () => {
      const responseMessage: Message = {
        id: 'response1',
        type: MessageType.PONG,
        data: {},
        sender: node2,
        timestamp: Date.now()
      };

      // Should not throw when no pending request exists
      expect(() => adapter2.sendResponse('nonexistent', responseMessage)).not.toThrow();
    });
  });
});
