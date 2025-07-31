/**
 * Lifecycle management interface for cluster operations
 */
export interface IClusterLifecycle {
  /**
   * Start the cluster node and initialize all components
   */
  start(): Promise<void>;

  /**
   * Stop the cluster node and cleanup resources
   */
  stop(): Promise<void>;

  /**
   * Gracefully leave the cluster with optional timeout
   * @param timeout - Maximum time to wait for graceful departure (default: 5000ms)
   */
  leave(timeout?: number): Promise<void>;

  /**
   * Drain a specific node from the cluster
   * @param nodeId - ID of the node to drain (optional, defaults to local node)
   */
  drainNode(nodeId?: string): Promise<void>;

  /**
   * Trigger cluster rebalancing by rebuilding the hash ring
   */
  rebalanceCluster(): Promise<void>;
}

/**
 * Configuration for lifecycle management
 */
export interface LifecycleConfig {
  /**
   * Timeout for graceful shutdown operations
   */
  shutdownTimeout: number;

  /**
   * Timeout for node draining operations
   */
  drainTimeout: number;

  /**
   * Whether to enable automatic rebalancing
   */
  enableAutoRebalance: boolean;

  /**
   * Threshold for triggering rebalancing (0.0 to 1.0)
   */
  rebalanceThreshold: number;

  /**
   * Whether to enable graceful shutdown
   */
  enableGracefulShutdown: boolean;

  /**
   * Maximum time to wait during graceful shutdown
   */
  maxShutdownWait: number;
}

/**
 * Lifecycle event types
 */
export interface LifecycleEvents {
  'lifecycle-started': [];
  'lifecycle-stopped': [];
  'node-left': [nodeId: string];
  'node-drained': [nodeId: string];
  'cluster-rebalanced': [{ timestamp: number; nodeCount: number }];
  'version-incremented': [{ nodeId: string; version: number }];
}
