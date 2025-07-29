import { Connection } from '../Connection';
import { Session } from '../Session';

// For Buffer support in tests
declare const Buffer: any;

describe('Connection', () => {
  let connection: Connection;
  let session: Session;
  let sentMessages: any[];
  let sendFn: jest.Mock;

  beforeEach(() => {
    sentMessages = [];
    sendFn = jest.fn((data) => sentMessages.push(data));
    session = new Session('test-session');
    connection = new Connection('conn-1', sendFn, session, {
      heartbeatInterval: 100,
      timeoutMs: 500,
      maxMessageSize: 1024
    });
  });

  afterEach((done) => {
    // Clean up connection to prevent timer leaks
    if (connection && !connection.session.isClosed()) {
      connection.close('test cleanup');
    }
    // Small delay to ensure cleanup completes
    setTimeout(done, 5);
  });

  describe('initialization', () => {
    it('should create connection with correct properties', () => {
      expect(connection.id).toBe('conn-1');
      expect(connection.session).toBe(session);
      expect(connection.isActive()).toBe(true);
      expect(connection.getStatus()).toBe('active');
    });

    it('should start with empty stats', () => {
      const stats = connection.getStats();
      expect(stats.messagesSent).toBe(0);
      expect(stats.messagesReceived).toBe(0);
      expect(stats.bytesTransferred).toBe(0);
      expect(stats.errors).toBe(0);
    });
  });

  describe('message sending', () => {
    it('should send JSON messages', () => {
      const message = { type: 'test', data: 'hello' };
      connection.send(message);

      expect(sendFn).toHaveBeenCalledWith(JSON.stringify(message));
      
      const stats = connection.getStats();
      expect(stats.messagesSent).toBe(1);
      expect(stats.bytesTransferred).toBeGreaterThan(0);
    });

    it('should send raw data', () => {
      const data = 'raw string data';
      connection.sendRaw(data);

      expect(sendFn).toHaveBeenCalledWith(data);
      
      const stats = connection.getStats();
      expect(stats.messagesSent).toBe(1);
      expect(stats.bytesTransferred).toBe(data.length);
    });

    it('should send buffer data', () => {
      const buffer = Buffer.from('buffer data');
      connection.sendRaw(buffer);

      expect(sendFn).toHaveBeenCalledWith(buffer);
      
      const stats = connection.getStats();
      expect(stats.messagesSent).toBe(1);
      expect(stats.bytesTransferred).toBe(buffer.byteLength);
    });

    it('should reject oversized messages', () => {
      const largeMessage = { data: 'x'.repeat(2000) }; // Exceeds 1024 byte limit
      
      expect(() => connection.send(largeMessage)).toThrow('Message size');
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('should reject messages on closed connection', () => {
      connection.close();
      
      expect(() => connection.send({ test: 'message' })).toThrow('Cannot send message on closed connection');
    });

    it('should emit events on send', (done) => {
      const message = { type: 'test' };
      
      connection.on('message-sent', (sentMessage) => {
        expect(sentMessage).toEqual(message);
        done();
      });

      connection.send(message);
    });
  });

  describe('message receiving', () => {
    it('should handle received messages', () => {
      const message = { type: 'incoming', data: 'test' };
      
      connection.onMessageReceived(message);
      
      const stats = connection.getStats();
      expect(stats.messagesReceived).toBe(1);
      expect(stats.bytesTransferred).toBeGreaterThan(0);
    });

    it('should emit events on receive', (done) => {
      const message = { type: 'test' };
      
      connection.on('message-received', (receivedMessage) => {
        expect(receivedMessage).toEqual(message);
        done();
      });

      connection.onMessageReceived(message);
    });

    it('should update activity on receive', (done) => {
      const originalActivity = connection.getStats().lastActivity;
      
      setTimeout(() => {
        connection.onMessageReceived({ type: 'test' });
        expect(connection.getStats().lastActivity).toBeGreaterThan(originalActivity);
        done();
      }, 10);
    });
  });

  describe('heartbeat and ping/pong', () => {
    it('should send ping messages', () => {
      connection.ping();
      
      expect(sendFn).toHaveBeenCalledWith(
        expect.stringContaining('"type":"ping"')
      );
    });

    it('should send pong responses', () => {
      connection.pong('test-data');
      
      expect(sendFn).toHaveBeenCalledWith(
        expect.stringContaining('"type":"pong"')
      );
    });

    it('should auto-ping on heartbeat interval', (done) => {
      // Wait for at least one heartbeat cycle
      setTimeout(() => {
        expect(sendFn).toHaveBeenCalledWith(
          expect.stringContaining('"type":"ping"')
        );
        done();
      }, 150);
    });
  });

  describe('connection lifecycle', () => {
    it('should close connection', () => {
      // Create a separate connection for this test to avoid afterEach interference
      const testSession = new Session('close-test-session');
      const testConnection = new Connection('close-test-conn', sendFn, testSession, {
        heartbeatInterval: 100,
        timeoutMs: 500,
        maxMessageSize: 1024
      });

      expect(testConnection.getStatus()).toBe('active');
      expect(testConnection.isActive()).toBe(true);
      expect(testSession.isClosed()).toBe(false);

      testConnection.close('test close');

      expect(testConnection.getStatus()).toBe('closed');
      expect(testConnection.isActive()).toBe(false);
      expect(testSession.isClosed()).toBe(true);
    });

    it('should handle timeout', (done) => {
      connection.on('timeout', () => {
        // The connection should be closed after timeout
        setTimeout(() => {
          expect(connection.getStatus()).toBe('closed');
          done();
        }, 1);
      });

      // Don't send any activity, should timeout
    }, 1000);

    it('should reset timeout on activity', (done) => {
      // Wait for some idle time to accumulate
      setTimeout(() => {
        const idleTimeBefore = connection.getIdleTime();
        expect(idleTimeBefore).toBeGreaterThan(5); // Should have some idle time
        
        connection.markActivity();
        const idleTimeAfter = connection.getIdleTime();
        
        expect(idleTimeAfter).toBeLessThan(idleTimeBefore);
        expect(idleTimeAfter).toBeLessThan(5); // Should be very small after activity
        done();
      }, 10);
    });
  });

  describe('error handling', () => {
    it('should handle send errors', (done) => {
      const errorSendFn = jest.fn(() => {
        throw new Error('Send failed');
      });
      
      const errorConnection = new Connection('error-conn', errorSendFn, session);
      
      errorConnection.on('error', (error) => {
        expect(error.message).toBe('Send failed');
        errorConnection.close(); // Clean up this connection
        done();
      });

      expect(() => errorConnection.send({ test: 'message' })).toThrow('Send failed');
    });

    it('should track errors in stats', () => {
      const errorSendFn = jest.fn(() => {
        throw new Error('Send failed');
      });
      
      const errorConnection = new Connection('error-conn', errorSendFn, session);
      
      try {
        errorConnection.send({ test: 'message' });
      } catch (e) {
        // Expected
      }

      const stats = errorConnection.getStats();
      expect(stats.errors).toBe(1);
      
      errorConnection.close(); // Clean up this connection
    });
  });

  describe('stats and monitoring', () => {
    it('should track message statistics', () => {
      connection.send({ type: 'out1' });
      connection.send({ type: 'out2' });
      connection.onMessageReceived({ type: 'in1' });
      
      const stats = connection.getStats();
      expect(stats.messagesSent).toBe(2);
      expect(stats.messagesReceived).toBe(1);
      expect(stats.bytesTransferred).toBeGreaterThan(0);
    });

    it('should calculate idle time', () => {
      const idleTime = connection.getIdleTime();
      expect(idleTime).toBeGreaterThanOrEqual(0);
      expect(idleTime).toBeLessThan(100); // Should be very recent
    });

    it('should provide immutable stats', () => {
      const stats = connection.getStats();
      const originalSent = stats.messagesSent;
      
      (stats as any).messagesSent = 999;
      
      const newStats = connection.getStats();
      expect(newStats.messagesSent).toBe(originalSent);
    });
  });

  describe('configuration', () => {
    it('should respect custom config', () => {
      const customConn = new Connection('custom', sendFn, session, {
        maxMessageSize: 100,
        heartbeatInterval: 50,
        timeoutMs: 200
      });

      const largeMessage = { data: 'x'.repeat(150) };
      expect(() => customConn.send(largeMessage)).toThrow('Message size');
      
      customConn.close();
    });

    it('should use default config when none provided', () => {
      const defaultConn = new Connection('default', sendFn, session);
      
      // Should not throw with reasonable message size
      defaultConn.send({ data: 'x'.repeat(1000) });
      
      defaultConn.close();
    });
  });
});
