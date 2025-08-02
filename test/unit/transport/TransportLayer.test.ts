import { GossipMessage, MessageType, MessageFactory } from '../../../src/transport/GossipMessage';
import { TCPAdapter } from '../../../src/transport/adapters/TCPAdapter';

describe('Transport Layer Phase 2B', () => {
  describe('GossipMessage', () => {
    test('should create and serialize messages', () => {
      const sender = { id: 'node1', address: '127.0.0.1', port: 8080 };
      const message = MessageFactory.heartbeat(sender, { status: 'alive' });
      
      expect(message.header.type).toBe(MessageType.HEARTBEAT);
      expect(message.header.sender.id).toBe('node1');
      expect(message.payload.data.status).toBe('alive');
      
      // Test serialization
      const serialized = message.serialize();
      const deserialized = GossipMessage.deserialize(serialized);
      
      expect(deserialized.header.id).toBe(message.header.id);
      expect(deserialized.payload.data.status).toBe('alive');
    });

    test('should handle message lifecycle', () => {
      const sender = { id: 'node1', address: '127.0.0.1', port: 8080 };
      const recipient = { id: 'node2', address: '127.0.0.1', port: 8081 };
      
      const message = MessageFactory.data(sender, { hello: 'world' }, recipient);
      
      expect(message.isExpired()).toBe(false);
      expect(message.isDelivered()).toBe(false);
      expect(message.isForRecipient(recipient)).toBe(true);
      expect(message.isBroadcast()).toBe(false);
      
      message.markDelivered();
      expect(message.isDelivered()).toBe(true);
    });
  });

  describe('TCP Adapter', () => {
    test('should initialize with proper configuration', () => {
      const nodeId = { id: 'tcp-node', address: '127.0.0.1', port: 9090 };
      const adapter = new TCPAdapter(nodeId, { 
        port: 9090, 
        maxConnections: 50, 
        enableLogging: false 
      });
      
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(false);
      expect(stats.port).toBe(9090);
      expect(stats.activeConnections).toBe(0);
    });
  });
});
