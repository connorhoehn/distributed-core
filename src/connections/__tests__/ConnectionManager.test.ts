import { ConnectionManager } from '../ConnectionManager';
import { Connection } from '../Connection';
import { Session } from '../Session';

describe('ConnectionManager', () => {
  let connectionManager: ConnectionManager;
  let mockSendFn: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager = new ConnectionManager();
    mockSendFn = jest.fn();
  });

  afterEach(() => {
    // Clean up all connections to prevent timer leaks
    const connections = connectionManager.getAllConnections();
    connections.forEach(conn => {
      conn.close('test cleanup');
    });
  });

  describe('basic connection management', () => {
    it('should create and retrieve connections', () => {
      const connection = connectionManager.createConnection('conn-1', mockSendFn, {
        userId: 'user-1',
        roomId: 'room-1'
      });
      
      expect(connection).toBeDefined();
      expect(connection.id).toBe('conn-1');
      
      const retrieved = connectionManager.getConnection('conn-1');
      expect(retrieved).toBe(connection);
    });

    it('should not allow duplicate connection IDs', () => {
      connectionManager.createConnection('conn-1', mockSendFn);
      
      expect(() => {
        connectionManager.createConnection('conn-1', mockSendFn);
      }).toThrow('Connection conn-1 already exists');
    });

    it('should remove connections', () => {
      connectionManager.createConnection('conn-1', mockSendFn);
      expect(connectionManager.getConnection('conn-1')).toBeDefined();
      
      const removed = connectionManager.removeConnection('conn-1');
      expect(removed).toBe(true);
      expect(connectionManager.getConnection('conn-1')).toBeUndefined();
    });

    it('should return false when removing non-existent connection', () => {
      const removed = connectionManager.removeConnection('non-existent');
      expect(removed).toBe(false);
    });

    it('should get all connections', () => {
      connectionManager.createConnection('conn-1', mockSendFn);
      connectionManager.createConnection('conn-2', mockSendFn);
      
      const connections = connectionManager.getAllConnections();
      expect(connections).toHaveLength(2);
    });
  });

  describe('tag-based indexing', () => {
    it('should index connections by tags when created', () => {
      const connection = connectionManager.createConnection('conn-1', mockSendFn, {
        userId: 'user-1',
        roomId: 'room-1'
      });
      
      // Set additional tags on the session
      connection.session.setTag('role', ['admin', 'moderator']);
      
      // Update indexes after setting additional tags
      connectionManager.updateConnectionIndex('conn-1');
      
      const userConnections = connectionManager.getConnectionsByTag('userId', 'user-1');
      expect(userConnections).toHaveLength(1);
      
      const roomConnections = connectionManager.getConnectionsByTag('room', 'room-1');
      expect(roomConnections).toHaveLength(1);
      
      const adminConnections = connectionManager.getConnectionsByTag('role', 'admin');
      expect(adminConnections).toHaveLength(1);
    });

    it('should handle multiple connections with same tags', () => {
      const conn1 = connectionManager.createConnection('conn-1', mockSendFn, { userId: 'user-1', roomId: 'room-1' });
      const conn2 = connectionManager.createConnection('conn-2', mockSendFn, { userId: 'user-1', roomId: 'room-2' });
      
      const userConnections = connectionManager.getConnectionsByTag('userId', 'user-1');
      expect(userConnections).toHaveLength(2);
      
      const room1Connections = connectionManager.getConnectionsByTag('room', 'room-1');
      expect(room1Connections).toHaveLength(1);
      
      const room2Connections = connectionManager.getConnectionsByTag('room', 'room-2');
      expect(room2Connections).toHaveLength(1);
    });

    it('should get all connections with a specific tag key', () => {
      connectionManager.createConnection('conn-1', mockSendFn, { roomId: 'room-1' });
      connectionManager.createConnection('conn-2', mockSendFn, { roomId: 'room-2' });
      
      const allRoomConnections = connectionManager.getAllConnectionsWithTag('room');
      expect(allRoomConnections).toHaveLength(2);
    });
  });

  describe('backward compatibility methods', () => {
    it('should support getConnectionsByUser', () => {
      const connection = connectionManager.createConnection('conn-1', mockSendFn, { userId: 'user-1' });
      
      const connections = connectionManager.getConnectionsByUser('user-1');
      expect(connections).toHaveLength(1);
      expect(connections[0]).toBe(connection);
    });
  });

  describe('broadcasting', () => {
    it('should broadcast by tag', () => {
      const connection = connectionManager.createConnection('conn-1', mockSendFn, { roomId: 'room-1' });
      
      const message = { type: 'test', data: 'hello' };
      const count = connectionManager.broadcastByTag('room', 'room-1', message);
      
      expect(count).toBe(1);
      expect(mockSendFn).toHaveBeenCalledWith(JSON.stringify(message));
    });

    it('should broadcast by multiple tags', () => {
      const connection = connectionManager.createConnection('conn-1', mockSendFn, { userId: 'user-1', roomId: 'room-1' });
      
      const message = { type: 'test', data: 'hello' };
      const count = connectionManager.broadcastByTags({ userId: 'user-1', room: 'room-1' }, message);
      
      expect(count).toBe(1);
      expect(mockSendFn).toHaveBeenCalledWith(JSON.stringify(message));
    });

    it('should not broadcast to excluded connections', () => {
      const connection = connectionManager.createConnection('conn-1', mockSendFn);
      connection.session.setTag('room', 'room-1');
      
      const message = { type: 'test', data: 'hello' };
      const count = connectionManager.broadcastByTag('room', 'room-1', message, 'conn-1');
      
      expect(count).toBe(0);
      expect(mockSendFn).not.toHaveBeenCalled();
    });

    it('should support backward compatibility broadcast methods', () => {
      const connection = connectionManager.createConnection('conn-1', mockSendFn, { userId: 'user-1' });
      
      const message = { type: 'test', data: 'hello' };
      
      const userCount = connectionManager.broadcastToUser('user-1', message);
      expect(userCount).toBe(1);
      
      expect(mockSendFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('statistics', () => {
    it('should return correct stats for empty manager', () => {
      const stats = connectionManager.getStats();
      
      expect(stats).toEqual({
        totalConnections: 0,
        activeConnections: 0,
        uniqueUsers: 0,
      });
    });

    it('should return correct stats with connections', () => {
      const conn1 = connectionManager.createConnection('conn-1', mockSendFn);
      const conn2 = connectionManager.createConnection('conn-2', mockSendFn);
      const conn3 = connectionManager.createConnection('conn-3', mockSendFn);
      
      conn1.session.setTag('userId', 'user-1');
      conn1.session.setTag('team', 'team-alpha');
      
      conn2.session.setTag('userId', 'user-2');
      conn2.session.setTag('team', 'team-alpha');
      
      conn3.session.setTag('userId', 'user-1');
      conn3.session.setTag('team', 'team-beta');
      
      const stats = connectionManager.getStats();
      
      expect(stats.totalConnections).toBe(3);
      expect(stats.activeConnections).toBe(3);
      expect(stats.uniqueUsers).toBe(2); // user-1, user-2
    });
  });
});
