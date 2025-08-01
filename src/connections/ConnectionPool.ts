import { EventEmitter } from 'events';
import { Connection } from '../connections/Connection';

export interface ConnectionPoolOptions {
  minConnections?: number;
  maxConnections?: number;
  acquireTimeout?: number;
  idleTimeout?: number;
  maxAge?: number;
  healthCheckInterval?: number;
  retryDelay?: number;
  maxRetries?: number;
  enableLogging?: boolean;
}

export interface PoolConnection {
  connection: Connection;
  id: string;
  createdAt: number;
  lastUsed: number;
  inUse: boolean;
  healthChecks: number;
  isHealthy: boolean;
}

export interface PoolStats {
  totalConnections: number;
  inUseConnections: number;
  idleConnections: number;
  queuedRequests: number;
  totalAcquired: number;
  totalReleased: number;
  totalCreated: number;
  totalDestroyed: number;
  averageAcquireTime: number;
}

/**
 * Advanced connection pool with health monitoring, aging, and lifecycle management
 */
export class ConnectionPool extends EventEmitter {
  private connections = new Map<string, PoolConnection>();
  private availableConnections: string[] = [];
  private waitingQueue: Array<{
    resolve: (connection: Connection) => void;
    reject: (error: Error) => void;
    timestamp: number;
    timeout: NodeJS.Timeout;
  }> = [];
  
  private healthCheckTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private stats = {
    totalAcquired: 0,
    totalReleased: 0,
    totalCreated: 0,
    totalDestroyed: 0,
    acquireTimes: [] as number[]
  };
  
  private readonly nodeId: string;
  private readonly createConnection: () => Promise<Connection>;
  private readonly options: Required<ConnectionPoolOptions>;

  constructor(
    nodeId: string,
    createConnection: () => Promise<Connection>,
    options: ConnectionPoolOptions = {}
  ) {
    super();
    
    this.nodeId = nodeId;
    this.createConnection = createConnection;
    this.options = {
      minConnections: options.minConnections || 2,
      maxConnections: options.maxConnections || 10,
      acquireTimeout: options.acquireTimeout || 30000,
      idleTimeout: options.idleTimeout || 300000, // 5 minutes
      maxAge: options.maxAge || 3600000, // 1 hour
      healthCheckInterval: options.healthCheckInterval || 60000, // 1 minute
      retryDelay: options.retryDelay || 1000,
      maxRetries: options.maxRetries || 3,
      enableLogging: options.enableLogging !== false
    };

    this.log(`Connection pool initialized for node ${nodeId}`);
  }

  /**
   * Initialize the pool
   */
  async initialize(): Promise<void> {
    // Create minimum connections
    const initPromises: Promise<void>[] = [];
    for (let i = 0; i < this.options.minConnections; i++) {
      initPromises.push(this.createAndAddConnection());
    }

    try {
      await Promise.all(initPromises);
      this.startBackgroundTasks();
      this.emit('initialized', { minConnections: this.options.minConnections });
      this.log('Pool initialized successfully');
    } catch (error) {
      this.emit('initialization-error', error);
      throw error;
    }
  }

  /**
   * Acquire connection from pool
   */
  async acquire(): Promise<Connection> {
    const startTime = Date.now();
    
    try {
      const connection = await this.acquireConnection();
      const acquireTime = Date.now() - startTime;
      
      this.stats.totalAcquired++;
      this.stats.acquireTimes.push(acquireTime);
      
      // Keep only last 100 acquire times for average calculation
      if (this.stats.acquireTimes.length > 100) {
        this.stats.acquireTimes.shift();
      }
      
      this.emit('connection-acquired', { 
        connectionId: this.getConnectionId(connection),
        acquireTime,
        poolSize: this.connections.size
      });
      
      return connection;
      
    } catch (error) {
      this.emit('acquire-error', { error, acquireTime: Date.now() - startTime });
      throw error;
    }
  }

  /**
   * Internal connection acquisition logic
   */
  private async acquireConnection(): Promise<Connection> {
    // Try to get available connection immediately
    const availableId = this.getAvailableConnection();
    if (availableId) {
      const poolConn = this.connections.get(availableId)!;
      poolConn.inUse = true;
      poolConn.lastUsed = Date.now();
      return poolConn.connection;
    }

    // Try to create new connection if under limit
    if (this.connections.size < this.options.maxConnections) {
      try {
        return await this.createAndUseConnection();
      } catch (error) {
        this.log(`Failed to create new connection: ${error}`);
        // Fall through to wait for available connection
      }
    }

    // Wait for available connection
    return this.waitForConnection();
  }

  /**
   * Get available connection ID
   */
  private getAvailableConnection(): string | null {
    for (const connectionId of this.availableConnections) {
      const poolConn = this.connections.get(connectionId);
      if (poolConn && !poolConn.inUse && poolConn.isHealthy) {
        // Remove from available list
        const index = this.availableConnections.indexOf(connectionId);
        this.availableConnections.splice(index, 1);
        return connectionId;
      }
    }
    return null;
  }

  /**
   * Create new connection and use immediately
   */
  private async createAndUseConnection(): Promise<Connection> {
    const connection = await this.createConnection();
    const poolConn = this.addConnectionToPool(connection);
    poolConn.inUse = true;
    poolConn.lastUsed = Date.now();
    return connection;
  }

  /**
   * Wait for connection to become available
   */
  private waitForConnection(): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Remove from waiting queue
        const index = this.waitingQueue.findIndex(item => item.resolve === resolve);
        if (index >= 0) {
          this.waitingQueue.splice(index, 1);
        }
        reject(new Error(`Connection acquire timeout after ${this.options.acquireTimeout}ms`));
      }, this.options.acquireTimeout);

      this.waitingQueue.push({
        resolve,
        reject,
        timestamp: Date.now(),
        timeout
      });
    });
  }

  /**
   * Release connection back to pool
   */
  release(connection: Connection): void {
    const connectionId = this.getConnectionId(connection);
    const poolConn = this.connections.get(connectionId);
    
    if (!poolConn) {
      this.log(`Warning: Releasing unknown connection ${connectionId}`);
      return;
    }

    if (!poolConn.inUse) {
      this.log(`Warning: Releasing connection that wasn't in use ${connectionId}`);
      return;
    }

    poolConn.inUse = false;
    poolConn.lastUsed = Date.now();
    this.stats.totalReleased++;

    // Check if connection is still healthy
    if (poolConn.isHealthy && this.isConnectionValid(poolConn)) {
      this.availableConnections.push(connectionId);
      
      // Process waiting queue
      this.processWaitingQueue();
      
      this.emit('connection-released', { 
        connectionId,
        poolSize: this.connections.size,
        availableCount: this.availableConnections.length
      });
    } else {
      // Remove unhealthy connection
      this.removeConnection(connectionId);
    }
  }

  /**
   * Process waiting queue
   */
  private processWaitingQueue(): void {
    while (this.waitingQueue.length > 0 && this.availableConnections.length > 0) {
      const waiter = this.waitingQueue.shift()!;
      const connectionId = this.availableConnections.shift()!;
      const poolConn = this.connections.get(connectionId)!;
      
      clearTimeout(waiter.timeout);
      poolConn.inUse = true;
      poolConn.lastUsed = Date.now();
      
      waiter.resolve(poolConn.connection);
    }
  }

  /**
   * Create and add connection to pool
   */
  private async createAndAddConnection(): Promise<void> {
    try {
      const connection = await this.createConnection();
      this.addConnectionToPool(connection);
      this.stats.totalCreated++;
      
      this.emit('connection-created', { 
        connectionId: this.getConnectionId(connection),
        poolSize: this.connections.size
      });
      
    } catch (error) {
      this.emit('connection-creation-error', error);
      throw error;
    }
  }

  /**
   * Add connection to pool tracking
   */
  private addConnectionToPool(connection: Connection): PoolConnection {
    const connectionId = this.getConnectionId(connection);
    
    const poolConn: PoolConnection = {
      connection,
      id: connectionId,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      inUse: false,
      healthChecks: 0,
      isHealthy: true
    };

    this.connections.set(connectionId, poolConn);
    this.availableConnections.push(connectionId);
    
    // Set up connection event handlers
    connection.on('error', () => this.handleConnectionError(connectionId));
    connection.on('close', () => this.handleConnectionClose(connectionId));
    
    return poolConn;
  }

  /**
   * Handle connection error
   */
  private handleConnectionError(connectionId: string): void {
    const poolConn = this.connections.get(connectionId);
    if (poolConn) {
      poolConn.isHealthy = false;
      this.emit('connection-error', { connectionId });
      
      if (!poolConn.inUse) {
        this.removeConnection(connectionId);
      }
    }
  }

  /**
   * Handle connection close
   */
  private handleConnectionClose(connectionId: string): void {
    this.removeConnection(connectionId);
    this.emit('connection-closed', { connectionId });
  }

  /**
   * Remove connection from pool
   */
  private removeConnection(connectionId: string): void {
    const poolConn = this.connections.get(connectionId);
    if (!poolConn) return;

    // Remove from available connections
    const index = this.availableConnections.indexOf(connectionId);
    if (index >= 0) {
      this.availableConnections.splice(index, 1);
    }

    // Close connection if not already closed
    try {
      if (poolConn.connection && typeof poolConn.connection.close === 'function') {
        poolConn.connection.close('pool-removal');
      }
    } catch (error) {
      this.log(`Error closing connection ${connectionId}: ${error}`);
    }

    this.connections.delete(connectionId);
    this.stats.totalDestroyed++;
    
    this.emit('connection-removed', { 
      connectionId,
      poolSize: this.connections.size
    });

    // Ensure minimum connections
    this.ensureMinimumConnections();
  }

  /**
   * Ensure minimum connections are maintained
   */
  private async ensureMinimumConnections(): Promise<void> {
    const availableCount = this.connections.size - this.getInUseCount();
    const needed = this.options.minConnections - availableCount;
    
    if (needed > 0 && this.connections.size < this.options.maxConnections) {
      const createCount = Math.min(needed, this.options.maxConnections - this.connections.size);
      
      for (let i = 0; i < createCount; i++) {
        try {
          await this.createAndAddConnection();
        } catch (error) {
          this.log(`Failed to create minimum connection: ${error}`);
          break; // Stop trying if creation fails
        }
      }
    }
  }

  /**
   * Start background tasks
   */
  private startBackgroundTasks(): void {
    // Health check timer
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.options.healthCheckInterval);

    // Cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, this.options.idleTimeout / 4); // Check 4 times per idle timeout

    this.healthCheckTimer.unref();
    this.cleanupTimer.unref();
  }

  /**
   * Perform health check on all connections
   */
  private async performHealthCheck(): Promise<void> {
    const healthPromises: Promise<void>[] = [];

    for (const [connectionId, poolConn] of this.connections) {
      if (!poolConn.inUse) {
        healthPromises.push(this.checkConnectionHealth(connectionId, poolConn));
      }
    }

    await Promise.allSettled(healthPromises);
  }

  /**
   * Check individual connection health
   */
  private async checkConnectionHealth(connectionId: string, poolConn: PoolConnection): Promise<void> {
    try {
      poolConn.healthChecks++;
      
      // Simple health check - check if connection is still active
      if (poolConn.connection && typeof poolConn.connection.isActive === 'function') {
        poolConn.isHealthy = poolConn.connection.isActive();
      } else {
        poolConn.isHealthy = true; // Assume healthy if no check available
      }
      
      if (!poolConn.isHealthy) {
        this.removeConnection(connectionId);
      }
      
    } catch (error) {
      poolConn.isHealthy = false;
      this.removeConnection(connectionId);
    }
  }

  /**
   * Perform cleanup of old/idle connections
   */
  private performCleanup(): void {
    const now = Date.now();
    const connectionsToRemove: string[] = [];

    for (const [connectionId, poolConn] of this.connections) {
      if (poolConn.inUse) continue;

      // Check age
      if (now - poolConn.createdAt > this.options.maxAge) {
        connectionsToRemove.push(connectionId);
        continue;
      }

      // Check idle time (only if we have more than minimum)
      if (this.connections.size > this.options.minConnections &&
          now - poolConn.lastUsed > this.options.idleTimeout) {
        connectionsToRemove.push(connectionId);
      }
    }

    for (const connectionId of connectionsToRemove) {
      this.removeConnection(connectionId);
    }

    if (connectionsToRemove.length > 0) {
      this.emit('cleanup-completed', { removedCount: connectionsToRemove.length });
    }
  }

  /**
   * Check if connection is still valid
   */
  private isConnectionValid(poolConn: PoolConnection): boolean {
    const now = Date.now();
    
    // Check age
    if (now - poolConn.createdAt > this.options.maxAge) {
      return false;
    }

    return true;
  }

  /**
   * Get connection ID
   */
  private getConnectionId(connection: Connection): string {
    // Use connection's ID if available, otherwise generate one
    return (connection as any).id || `conn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get number of in-use connections
   */
  private getInUseCount(): number {
    return Array.from(this.connections.values()).filter(conn => conn.inUse).length;
  }

  /**
   * Get pool statistics
   */
  getStats(): PoolStats {
    const avgAcquireTime = this.stats.acquireTimes.length > 0
      ? this.stats.acquireTimes.reduce((sum, time) => sum + time, 0) / this.stats.acquireTimes.length
      : 0;

    return {
      totalConnections: this.connections.size,
      inUseConnections: this.getInUseCount(),
      idleConnections: this.connections.size - this.getInUseCount(),
      queuedRequests: this.waitingQueue.length,
      totalAcquired: this.stats.totalAcquired,
      totalReleased: this.stats.totalReleased,
      totalCreated: this.stats.totalCreated,
      totalDestroyed: this.stats.totalDestroyed,
      averageAcquireTime: avgAcquireTime
    };
  }

  /**
   * Get pool health status
   */
  getHealthStatus(): {
    healthy: boolean;
    details: {
      totalConnections: number;
      healthyConnections: number;
      unhealthyConnections: number;
      queuedRequests: number;
      utilizationRate: number;
    };
  } {
    const healthyConnections = Array.from(this.connections.values())
      .filter(conn => conn.isHealthy).length;
    const unhealthyConnections = this.connections.size - healthyConnections;
    const utilizationRate = this.connections.size > 0 
      ? this.getInUseCount() / this.connections.size 
      : 0;

    return {
      healthy: healthyConnections >= this.options.minConnections && this.waitingQueue.length === 0,
      details: {
        totalConnections: this.connections.size,
        healthyConnections,
        unhealthyConnections,
        queuedRequests: this.waitingQueue.length,
        utilizationRate
      }
    };
  }

  /**
   * Update pool options
   */
  updateOptions(newOptions: Partial<ConnectionPoolOptions>): void {
    Object.assign(this.options, newOptions);
    this.emit('options-updated', { options: this.options });
    this.log('Pool options updated');
  }

  /**
   * Log message if logging is enabled
   */
  private log(message: string): void {
    if (this.options.enableLogging) {
      console.log(`[ConnectionPool:${this.nodeId}] ${message}`);
    }
  }

  /**
   * Drain and close pool
   */
  async drain(): Promise<void> {
    this.log('Draining connection pool...');

    // Stop background tasks
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Reject all waiting requests
    for (const waiter of this.waitingQueue) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('Pool is draining'));
    }
    this.waitingQueue = [];

    // Close all connections
    const closePromises: Promise<void>[] = [];
    for (const [connectionId, poolConn] of this.connections) {
      if (poolConn.connection && typeof poolConn.connection.close === 'function') {
        try {
          poolConn.connection.close('pool-draining');
          closePromises.push(Promise.resolve());
        } catch (error) {
          this.log(`Error closing connection ${connectionId}: ${error}`);
          closePromises.push(Promise.resolve());
        }
      }
    }

    await Promise.allSettled(closePromises);
    
    this.connections.clear();
    this.availableConnections = [];

    this.emit('drained');
    this.log('Pool drained successfully');
  }

  /**
   * Destroy pool and cleanup resources
   */
  async destroy(): Promise<void> {
    await this.drain();
    this.removeAllListeners();
    this.emit('destroyed');
    this.log('Pool destroyed');
  }
}
