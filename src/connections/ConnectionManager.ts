import { EventEmitter } from 'events';
import { Connection } from './Connection';
import { Session } from './Session';
import { SendFunction, SessionMetadata, ConnectionConfig, MessageRouterFunction } from './types';

export class ConnectionManager extends EventEmitter {
  private connections = new Map<string, Connection>();
  private tagIndex = new Map<string, Map<string, Set<Connection>>>(); // tagKey -> tagValue -> connections
  private readonly defaultConfig: ConnectionConfig;

  constructor(config: ConnectionConfig = {}) {
    super();
    this.defaultConfig = {
      heartbeatInterval: 30000,
      timeoutMs: 60000,
      maxMessageSize: 64 * 1024,
      ...config
    };
  }

  createConnection(
    id: string, 
    sendFn: SendFunction, 
    metadata: SessionMetadata = {},
    config?: ConnectionConfig
  ): Connection {
    if (this.connections.has(id)) {
      throw new Error(`Connection ${id} already exists`);
    }

    const session = new Session(id, metadata);
    const conn = new Connection(id, sendFn, session, { ...this.defaultConfig, ...config });

    // Set up event handlers
    conn.on('closed', (reason) => this.handleConnectionClosed(id, reason));
    conn.on('error', (error) => this.handleConnectionError(id, error));
    conn.on('message-received', (message) => this.handleMessageReceived(id, message));

    this.connections.set(id, conn);
    this.updateIndexes(conn);

    this.emit('connection-created', conn);
    return conn;
  }

  removeConnection(id: string): boolean {
    const conn = this.connections.get(id);
    if (!conn) return false;

    this.removeFromIndexes(conn);
    this.connections.delete(id);
    
    if (!conn.session.isClosed()) {
      conn.close('removed');
    }

    this.emit('connection-removed', id);
    return true;
  }

  getConnection(id: string): Connection | undefined {
    return this.connections.get(id);
  }

  getAllConnections(): Connection[] {
    return Array.from(this.connections.values());
  }

  getActiveConnections(): Connection[] {
    return this.getAllConnections().filter(conn => conn.isActive());
  }

  getConnectionsByTag(tagKey: string, tagValue: string): Connection[] {
    const tagMap = this.tagIndex.get(tagKey);
    if (!tagMap) return [];
    
    const connections = tagMap.get(tagValue);
    if (!connections) return [];
    
    return Array.from(connections)
      .filter(conn => conn.isActive());
  }

  getAllConnectionsWithTag(tagKey: string): Connection[] {
    const tagMap = this.tagIndex.get(tagKey);
    if (!tagMap) return [];
    
    const allConnections = new Set<Connection>();
    for (const connections of tagMap.values()) {
      connections.forEach(conn => allConnections.add(conn));
    }
    
    return Array.from(allConnections)
      .filter(conn => conn.isActive());
  }

  // Backward compatibility helpers
  getConnectionsByUser(userId: string): Connection[] {
    return this.getConnectionsByTag('userId', userId);
  }

  broadcast(message: object, filter?: (conn: Connection) => boolean): number {
    let sentCount = 0;
    
    for (const conn of this.connections.values()) {
      if (conn.isActive() && (!filter || filter(conn))) {
        try {
          conn.send(message);
          sentCount++;
        } catch (error) {
          this.emit('broadcast-error', { connectionId: conn.id, error });
        }
      }
    }

    this.emit('broadcast-sent', { message, sentCount });
    return sentCount;
  }

  broadcastByTag(tagKey: string, tagValue: string, message: object, excludeConnectionId?: string): number {
    const connections = this.getConnectionsByTag(tagKey, tagValue);
    let sentCount = 0;

    for (const conn of connections) {
      if (conn.isActive() && conn.id !== excludeConnectionId) {
        try {
          conn.send(message);
          sentCount++;
        } catch (error) {
          this.emit('broadcast-error', { connectionId: conn.id, error });
        }
      }
    }

    this.emit('tag-broadcast-sent', { tagKey, tagValue, message, sentCount });
    return sentCount;
  }

  broadcastByTags(tags: Record<string, string>, message: object, excludeConnectionId?: string): number {
    const matchingConnections = this.getAllConnections().filter(conn => {
      return Object.entries(tags).every(([key, value]) => 
        conn.session.hasTag(key, value)
      );
    });

    let sentCount = 0;
    for (const conn of matchingConnections) {
      if (conn.isActive() && conn.id !== excludeConnectionId) {
        try {
          conn.send(message);
          sentCount++;
        } catch (error) {
          this.emit('broadcast-error', { connectionId: conn.id, error });
        }
      }
    }

    this.emit('tags-broadcast-sent', { tags, message, sentCount });
    return sentCount;
  }

  // Backward compatibility methods
  broadcastToUser(userId: string, message: object): number {
    return this.broadcastByTag('userId', userId, message);
  }

  getStats() {
    const allConnections = this.getAllConnections();
    const uniqueUsers = new Set(
      allConnections.map(conn => conn.session.getTag('userId')).filter(Boolean)
    ).size;

    return {
      totalConnections: allConnections.length,
      activeConnections: allConnections.filter(conn => conn.isActive()).length,
      uniqueUsers,
    };
  }

  cleanup(maxIdleTime: number = 300000): number { // 5 minutes default
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, conn] of this.connections) {
      if (conn.getIdleTime() > maxIdleTime) {
        toRemove.push(id);
      }
    }

    toRemove.forEach(id => this.removeConnection(id));
    this.emit('cleanup-completed', { removed: toRemove.length });
    
    return toRemove.length;
  }

  getSession(connectionId: string): Session | undefined {
    return this.connections.get(connectionId)?.session;
  }

  updateConnectionIndex(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    // Remove from old indexes first
    this.removeFromIndexes(connection);
    // Re-add with current tags
    this.updateIndexes(connection);
  }

  private updateIndexes(connection: Connection) {
    // Update tag-based indexes
    const session = connection.session;
    const tags = session.getTags();
    
    Object.entries(tags).forEach(([tagKey, tagValues]) => {
      if (!this.tagIndex.has(tagKey)) {
        this.tagIndex.set(tagKey, new Map());
      }
      const tagMap = this.tagIndex.get(tagKey)!;
      
      // Handle both string and string[] values
      const values = Array.isArray(tagValues) ? tagValues : [tagValues];
      values.forEach((value: string) => {
        if (!tagMap.has(value)) {
          tagMap.set(value, new Set());
        }
        tagMap.get(value)!.add(connection);
      });
    });
  }

  private removeFromIndexes(connection: Connection) {
    // Remove from tag-based indexes
    const session = connection.session;
    const tags = session.getTags();
    
    Object.entries(tags).forEach(([tagKey, tagValues]) => {
      const tagMap = this.tagIndex.get(tagKey);
      if (!tagMap) return;
      
      // Handle both string and string[] values
      const values = Array.isArray(tagValues) ? tagValues : [tagValues];
      values.forEach((value: string) => {
        const connections = tagMap.get(value);
        if (connections) {
          connections.delete(connection);
          if (connections.size === 0) {
            tagMap.delete(value);
          }
        }
      });
      
      // Clean up empty tag keys
      if (tagMap.size === 0) {
        this.tagIndex.delete(tagKey);
      }
    });
  }

  private handleConnectionClosed(id: string, reason?: string): void {
    this.emit('connection-closed', { connectionId: id, reason });
    this.removeConnection(id);
  }

  private handleConnectionError(id: string, error: Error): void {
    this.emit('connection-error', { connectionId: id, error });
  }

  private handleMessageReceived(id: string, message: any): void {
    this.emit('message-received', { connectionId: id, message });
  }
}
