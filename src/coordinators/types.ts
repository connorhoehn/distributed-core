/**
 * Core framework types for the distributed cluster coordination system
 */

export type CoordinatorType = 'in-memory' | 'gossip' | 'etcd' | 'zookeeper';
export type TransportType = 'ws' | 'tcp' | 'udp' | 'in-memory';

/**
 * Range identifier for work partitioning
 */
export type RangeId = string;

/**
 * Ring identifier for service types
 */
export type RingId = string;

/**
 * Cluster information passed to handlers
 */
export interface ClusterInfo {
  nodeId: string;
  members: string[];
  totalRanges: number;
  assignedRanges: RangeId[];
  ringId: RingId;
}

/**
 * Message structure for inter-node communication
 */
export interface ClusterMessage {
  id: string;
  type: string;
  payload: any;
  sourceNodeId: string;
  targetRangeId?: RangeId;
  timestamp: number;
}

/**
 * Handler interface for processing range-specific work
 */
export interface RangeHandler {
  /**
   * Called when this node acquires ownership of a range
   */
  onJoin(rangeId: RangeId, clusterInfo: ClusterInfo): Promise<void>;

  /**
   * Called when a message is routed to this handler's range
   */
  onMessage(message: ClusterMessage): Promise<void>;

  /**
   * Called when this node releases ownership of a range
   */
  onLeave(rangeId: RangeId): Promise<void>;

  /**
   * Optional: Called when cluster topology changes
   */
  onTopologyChange?(clusterInfo: ClusterInfo): Promise<void>;
}

/**
 * Lease information for range ownership
 */
export interface RangeLease {
  rangeId: RangeId;
  nodeId: string;
  acquiredAt: number;
  expiresAt: number;
  version: number;
}

/**
 * Cluster view from coordinator perspective
 */
export interface ClusterView {
  nodes: Map<string, NodeStatus>;
  leases: Map<RangeId, RangeLease>;
  ringId: RingId;
  version: number;
  lastUpdated: number;
}

/**
 * Node status in the cluster
 */
export interface NodeStatus {
  nodeId: string;
  lastSeen: number;
  metadata: Record<string, any>;
  isAlive: boolean;
}

/**
 * Logging configuration for framework components
 */
export interface LoggingConfig {
  enableFrameworkLogs?: boolean;  // Framework coordination logs (default: true)
  enableCoordinatorLogs?: boolean; // Coordinator-specific logs (default: true)
  enableTestMode?: boolean;       // Test mode for cleaner output (default: false)
}

/**
 * Configuration for cluster node creation
 */
export interface ClusterNodeConfig {
  ringId: RingId;
  rangeHandler: RangeHandler;
  coordinator: CoordinatorType;
  transport: TransportType;
  seedNodes?: string[];
  nodeId?: string;
  metadata?: Record<string, any>;
  coordinatorConfig?: Record<string, any>;
  transportConfig?: Record<string, any>;
  logging?: LoggingConfig;
}

/**
 * Events emitted by the cluster framework
 */
export interface ClusterFrameworkEvents {
  'node-joined': [string];
  'node-left': [string];
  'range-acquired': [RangeId];
  'range-released': [RangeId];
  'topology-changed': [ClusterView];
  'lease-conflict': [RangeId, string];
  'coordinator-error': [Error];
}

/**
 * Core coordinator interface that all implementations must follow
 */
export interface IClusterCoordinator {
  /**
   * Initialize the coordinator
   */
  initialize(nodeId: string, ringId: RingId, config?: Record<string, any>): Promise<void>;

  /**
   * Join the cluster
   */
  joinCluster(seedNodes: string[]): Promise<void>;

  /**
   * Leave the cluster gracefully
   */
  leaveCluster(): Promise<void>;

  /**
   * Attempt to acquire a lease for a range
   */
  acquireLease(rangeId: RangeId): Promise<boolean>;

  /**
   * Release a lease for a range
   */
  releaseLease(rangeId: RangeId): Promise<void>;

  /**
   * Get current cluster view
   */
  getClusterView(): Promise<ClusterView>;

  /**
   * Get all ranges this node currently owns
   */
  getOwnedRanges(): Promise<RangeId[]>;

  /**
   * Check if this node owns a specific range
   */
  ownsRange(rangeId: RangeId): Promise<boolean>;

  /**
   * Start periodic operations (heartbeats, lease renewals, etc.)
   */
  start(): Promise<void>;

  /**
   * Stop periodic operations
   */
  stop(): Promise<void>;

  /**
   * Event emitter interface
   */
  on(event: keyof ClusterFrameworkEvents, listener: (...args: any[]) => void): void;
  off(event: keyof ClusterFrameworkEvents, listener: (...args: any[]) => void): void;
  emit(event: keyof ClusterFrameworkEvents, ...args: any[]): boolean;
}

/**
 * Range allocation strategy
 */
export interface RangeAllocationStrategy {
  /**
   * Calculate range assignments for the cluster
   */
  allocateRanges(nodes: string[], totalRanges: number): Map<string, RangeId[]>;

  /**
   * Handle rebalancing when nodes join/leave
   */
  rebalance(currentView: ClusterView, addedNodes: string[], removedNodes: string[]): Map<string, RangeId[]>;
}

/**
 * Transport layer interface for message delivery
 */
export interface ITransport {
  /**
   * Initialize transport
   */
  initialize(nodeId: string, config?: Record<string, any>): Promise<void>;

  /**
   * Send message to specific node
   */
  sendToNode(targetNodeId: string, message: ClusterMessage): Promise<void>;

  /**
   * Broadcast message to all nodes
   */
  broadcast(message: ClusterMessage): Promise<void>;

  /**
   * Start listening for messages
   */
  startListening(onMessage: (message: ClusterMessage) => Promise<void>): Promise<void>;

  /**
   * Stop transport
   */
  stop(): Promise<void>;

  /**
   * Get transport-specific connection info
   */
  getConnectionInfo(): Record<string, any>;
}
