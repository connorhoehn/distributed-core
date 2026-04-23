import { EventEmitter } from 'events';
import { IClusterManagerContext, IRequiresContext } from '../core/IClusterManagerContext';
import { ClusterHealth, ClusterTopology, ClusterMetadata, MembershipEntry } from '../types';

/**
 * Real-time performance tracking interface
 */
export interface PerformanceMetrics {
  membershipSize: number;
  gossipRate: number;
  failureDetectionLatency: number;
  averageHeartbeatInterval: number;
  messageRate: number;
  messageLatency: number;
  networkThroughput: number;
  cpuUsage?: number;
  memoryUsage?: number;
  timestamp: number;
}

/**
 * Vector clock for causal ordering
 */
export interface VectorClock {
  [nodeId: string]: number;
}

/**
 * Logical service tracking interface (enhanced for anti-entropy)
 */
export interface LogicalService {
  id: string;
  type: string;
  nodeId: string;
  rangeId?: string;
  metadata: Record<string, any>;
  stats: Record<string, number>;
  lastUpdated: number;
  // Anti-entropy fields
  vectorClock: VectorClock;
  version: number;
  checksum: string;
  conflictPolicy?: string;
}

/**
 * State conflict detection
 */
export interface StateConflict {
  serviceId: string;
  conflictType: 'version' | 'stats' | 'metadata' | 'missing';
  nodes: string[];
  values: Map<string, any>;
  resolutionStrategy: string;
  severity: 'low' | 'medium' | 'high';
}

/**
 * Real-time cluster state interface
 */
export interface ClusterState {
  health: ClusterHealth;
  topology: ClusterTopology;
  metadata: ClusterMetadata;
  performance: PerformanceMetrics;
  logicalServices: LogicalService[];
  lastUpdated: number;
}

/**
 * ClusterIntrospection provides health monitoring, analytics, and metadata services
 * 
 * Responsibilities:
 * - Real-time cluster health metrics and monitoring
 * - Topology analysis and reporting
 * - Performance metrics collection and tracking
 * - Logical service registry and monitoring
 * - State aggregation for external systems
 */
export class ClusterIntrospection extends EventEmitter implements IRequiresContext {
  private context?: IClusterManagerContext;
  private logicalServices = new Map<string, LogicalService>();
  private performanceHistory: PerformanceMetrics[] = [];
  private maxHistorySize = 100;
  private metricsInterval?: NodeJS.Timeout;
  private lastGossipCount = 0;
  private lastMessageCount = 0;
  private membershipChangeTimestamps: number[] = [];
  private trackingStartTime: number = Date.now();

  constructor() {
    super();
  }

  /**
   * Set the cluster manager context for delegation
   */
  setContext(context: IClusterManagerContext): void {
    this.context = context;
    // Don't automatically start tracking - wait for cluster to start
  }

  /**
   * Start real-time metrics collection (called when cluster starts)
   */
  startTracking(): void {
    if (!this.metricsInterval && this.context) {
      this.setupRealTimeTracking();
    }
  }

  /**
   * Start real-time metrics collection
   */
  private setupRealTimeTracking(): void {
    // Collect performance metrics every 5 seconds
    this.metricsInterval = setInterval(() => {
      const metrics = this.collectCurrentMetrics();
      this.performanceHistory.push(metrics);
      
      // Keep only recent history
      if (this.performanceHistory.length > this.maxHistorySize) {
        this.performanceHistory.shift();
      }
      
      // Emit real-time updates for external systems
      this.emit('metrics-updated', metrics);
      this.emit('state-changed', this.getCurrentState());
    }, 5000);

    // Prevent Jest from hanging on this timer
    this.metricsInterval.unref();

    // Listen for cluster events through the membership table
    if (this.context) {
      this.context.membership.on('member-joined', () => {
        this.membershipChangeTimestamps.push(Date.now());
        if (this.membershipChangeTimestamps.length > 500) this.membershipChangeTimestamps.shift();
        this.emit('topology-changed', this.getTopology());
      });

      this.context.membership.on('member-left', () => {
        this.membershipChangeTimestamps.push(Date.now());
        if (this.membershipChangeTimestamps.length > 500) this.membershipChangeTimestamps.shift();
        this.emit('topology-changed', this.getTopology());
      });

      this.context.membership.on('membership-updated', () => {
        this.emit('health-changed', this.getClusterHealth());
      });
    }
  }

  /**
   * Stop real-time tracking
   */
  destroy(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = undefined;
    }
    this.removeAllListeners();
  }

  /**
   * Generate checksum for service data
   */
  private generateChecksum(service: Omit<LogicalService, 'checksum' | 'vectorClock' | 'version'>): string {
    const data = JSON.stringify({
      metadata: service.metadata,
      stats: service.stats,
      lastUpdated: service.lastUpdated
    });
    // Simple hash function - in production use crypto.createHash
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }

  /**
   * Initialize vector clock for new service
   */
  private initializeVectorClock(): VectorClock {
    if (!this.context) {
      throw new Error('ClusterIntrospection not initialized with context');
    }
    const clock: VectorClock = {};
    clock[this.context.localNodeId] = 1;
    return clock;
  }

  /**
   * Increment vector clock for service update
   */
  private incrementVectorClock(service: LogicalService): VectorClock {
    if (!this.context) {
      throw new Error('ClusterIntrospection not initialized with context');
    }
    const nodeId = this.context.localNodeId;
    const newClock = { ...service.vectorClock };
    newClock[nodeId] = (newClock[nodeId] || 0) + 1;
    return newClock;
  }

  /**
   * Register a logical service (e.g., chat rooms, game sessions)
   */
  registerLogicalService(service: Omit<LogicalService, 'vectorClock' | 'version' | 'checksum'>): void {
    const enhancedService: LogicalService = {
      ...service,
      lastUpdated: Date.now(),
      vectorClock: this.initializeVectorClock(),
      version: 1,
      checksum: '',
      conflictPolicy: service.conflictPolicy || 'last-writer-wins'
    };
    
    // Generate checksum after all fields are set
    enhancedService.checksum = this.generateChecksum(enhancedService);
    
    this.logicalServices.set(enhancedService.id, enhancedService);
    this.emit('service-registered', enhancedService);
  }

  /**
   * Unregister a logical service
   */
  unregisterLogicalService(serviceId: string): void {
    const service = this.logicalServices.get(serviceId);
    if (service) {
      this.logicalServices.delete(serviceId);
      this.emit('service-unregistered', service);
    }
  }

  /**
   * Update logical service stats
   */
  updateLogicalService(serviceId: string, stats: Record<string, number>, metadata?: Record<string, any>): void {
    const service = this.logicalServices.get(serviceId);
    if (service) {
      // Update data
      service.stats = { ...service.stats, ...stats };
      if (metadata) {
        service.metadata = { ...service.metadata, ...metadata };
      }
      service.lastUpdated = Date.now();
      
      // Update anti-entropy fields
      service.vectorClock = this.incrementVectorClock(service);
      service.version += 1;
      service.checksum = this.generateChecksum(service);
      
      this.emit('service-updated', service);
    }
  }

  /**
   * Get all logical services
   */
  getLogicalServices(): LogicalService[] {
    return Array.from(this.logicalServices.values());
  }

  /**
   * Get logical services by type (e.g., 'chat-room', 'game-session')
   */
  getLogicalServicesByType(type: string): LogicalService[] {
    return Array.from(this.logicalServices.values()).filter(service => service.type === type);
  }

  /**
   * Get logical services for a specific node
   */
  getLogicalServicesByNode(nodeId: string): LogicalService[] {
    return Array.from(this.logicalServices.values()).filter(service => service.nodeId === nodeId);
  }

  /**
   * Collect current performance metrics
   */
  private collectCurrentMetrics(): PerformanceMetrics {
    if (!this.context) {
      throw new Error('ClusterIntrospection requires context to be set');
    }

    // Gossip rate: count the alive nodes the gossip strategy would target
    // per interval as a proxy for messages dispatched per second.
    const aliveCount = this.context.membership.getAliveMembers().length;
    // Each gossip round fans out to up to 3 peers; rate = fanout / interval_seconds.
    const gossipFanout = Math.min(3, Math.max(0, aliveCount - 1));
    const gossipIntervalSec = (this.context.config.gossipInterval || 1000) / 1000;
    const gossipRate = gossipIntervalSec > 0 ? gossipFanout / gossipIntervalSec : 0;

    // Message rate: derive from the number of connected peers on the transport.
    // Each connected peer sends/receives heartbeats at the configured interval.
    const connectedNodes = this.context.transport.getConnectedNodes();
    const currentMessageCount = connectedNodes.length;
    const messageRate = Math.max(0, currentMessageCount - this.lastMessageCount) / 5;
    this.lastMessageCount = currentMessageCount;

    // Failure detection latency: use the configured failure timeout from the
    // failure detector as the upper-bound detection latency.
    const fdStatus = this.context.failureDetector.getStatus();
    const failureDetectionLatency = fdStatus.config?.failureTimeout ?? 3000;

    // Heartbeat interval comes directly from the failure detector config.
    const averageHeartbeatInterval = fdStatus.config?.heartbeatInterval ?? 1000;

    // Message latency: average RTT across monitored nodes from the failure
    // detector's health statuses; fall back to 50 ms when none are available.
    const rtts = (fdStatus.healthStatuses ?? [])
      .filter((h): h is NonNullable<typeof h> => h !== null && h !== undefined)
      .map(h => h.roundTripTime)
      .filter((rtt): rtt is number => rtt !== undefined && rtt > 0);
    const messageLatency = rtts.length > 0
      ? rtts.reduce((sum: number, rtt: number) => sum + rtt, 0) / rtts.length
      : 50;

    return {
      membershipSize: this.context.membership.getAllMembers().length,
      gossipRate,
      failureDetectionLatency,
      averageHeartbeatInterval,
      messageRate,
      messageLatency,
      networkThroughput: messageRate * 1024, // Estimate bytes per second
      timestamp: Date.now()
    };
  }

  /**
   * Get current comprehensive cluster state
   */
  getCurrentState(): ClusterState {
    return {
      health: this.getClusterHealth(),
      topology: this.getTopology(),
      metadata: this.getMetadata(),
      performance: this.performanceHistory[this.performanceHistory.length - 1] || this.collectCurrentMetrics(),
      logicalServices: this.getLogicalServices(),
      lastUpdated: Date.now()
    };
  }

  /**
   * Get performance history
   */
  getPerformanceHistory(): PerformanceMetrics[] {
    return [...this.performanceHistory];
  }

  /**
   * Get cluster health metrics
   */
  getClusterHealth(): ClusterHealth {
    if (!this.context) {
      throw new Error('ClusterIntrospection requires context to be set');
    }

    const members = this.context.membership.getAllMembers();
    const alive = members.filter((m: MembershipEntry) => m.status === 'ALIVE');
    const suspect = members.filter((m: MembershipEntry) => m.status === 'SUSPECT');
    const dead = members.filter((m: MembershipEntry) => m.status === 'DEAD');

    return {
      totalNodes: members.length,
      aliveNodes: alive.length,
      suspectNodes: suspect.length,
      deadNodes: dead.length,
      healthRatio: members.length > 0 ? alive.length / members.length : 0,
      isHealthy: alive.length >= Math.ceil(members.length * 0.5), // Majority alive
      ringCoverage: 1.0, // Simplified for now, could enhance with actual ring analysis
      partitionCount: this.detectPartitionCount(members.length, alive.length)
    };
  }

  /**
   * Estimate the number of network partitions.
   *
   * A simple heuristic: if the visible alive count is below majority we
   * assume at least one partition exists. We also check whether alive nodes
   * span only a single zone while additional total nodes exist (zone-split).
   */
  private detectPartitionCount(totalMembers: number, aliveCount: number): number {
    if (!this.context) return 0;
    if (aliveCount >= Math.ceil(totalMembers / 2)) {
      // Check for zone-based split
      const aliveMembers = this.context.membership.getAliveMembers();
      const zones = new Set(aliveMembers.map(m => m.metadata?.zone || 'unknown'));
      if (zones.size === 1 && totalMembers > aliveCount) {
        return 1;
      }
      return 0;
    }
    return 1;
  }

  /**
   * Get cluster topology information
   */
  getTopology(): ClusterTopology {
    if (!this.context) {
      throw new Error('ClusterIntrospection requires context to be set');
    }

    const members = this.context.membership.getAliveMembers();
    const zones = new Map<string, MembershipEntry[]>();
    const regions = new Map<string, MembershipEntry[]>();

    members.forEach(member => {
      const zone = member.metadata?.zone || 'unknown';
      const region = member.metadata?.region || 'unknown';

      if (!zones.has(zone)) zones.set(zone, []);
      if (!regions.has(region)) regions.set(region, []);

      zones.get(zone)!.push(member);
      regions.get(region)!.push(member);
    });

    return {
      totalAliveNodes: members.length,
      rings: members.map(member => ({ nodeId: member.id, virtualNodes: 100 })), // Use default virtual nodes
      zones: Object.fromEntries(Array.from(zones.entries()).map(([zone, nodes]) => [zone, nodes.length])),
      regions: Object.fromEntries(Array.from(regions.entries()).map(([region, nodes]) => [region, nodes.length])),
      averageLoadBalance: this.calculateLoadBalance(),
      replicationFactor: 3 // Default replication factor
    };
  }

  /**
   * Calculate load balance across the ring
   */
  calculateLoadBalance(): number {
    if (!this.context) {
      return 0;
    }

    const members = this.context.membership.getAliveMembers();
    if (members.length <= 1) return 1.0;

    // Simple heuristic: perfect balance would be 1.0
    // For now, return a simplified metric based on node count
    return Math.min(1.0, members.length / 10); // Assume optimal around 10 nodes
  }

  /**
   * Get cluster metadata summary
   */
  getMetadata(): ClusterMetadata {
    if (!this.context) {
      throw new Error('ClusterIntrospection requires context to be set');
    }

    const members = this.context.membership.getAliveMembers();
    const roles = new Set<string>();
    const tags = new Map<string, Set<string>>();

    members.forEach(member => {
      if (member.metadata?.role) {
        roles.add(member.metadata.role);
      }
      
      if (member.metadata?.tags) {
        Object.entries(member.metadata.tags).forEach(([key, value]) => {
          if (!tags.has(key)) tags.set(key, new Set<string>());
          tags.get(key)!.add(value as string);
        });
      }
    });

    return {
      nodeCount: members.length,
      roles: Array.from(roles) as string[],
      tags: Object.fromEntries(Array.from(tags.entries()).map(([key, values]) => [key, Array.from(values)])),
      version: this.getLocalVersion(),
      clusterId: this.generateClusterId(),
      created: Date.now()
    };
  }

  /**
   * Generate a deterministic cluster ID based on membership
   */
  generateClusterId(): string {
    if (!this.context) {
      return 'unknown';
    }

    const sortedNodeIds = this.context.membership.getAliveMembers()
      .map(m => m.id)
      .sort()
      .join(',');
    
    // Simple hash of sorted node IDs
    let hash = 0;
    for (let i = 0; i < sortedNodeIds.length; i++) {
      const char = sortedNodeIds.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    return Math.abs(hash).toString(16);
  }

  /**
   * Check if cluster can handle node failures
   */
  canHandleFailures(nodeCount: number): boolean {
    if (!this.context) {
      return false;
    }

    const alive = this.context.membership.getAliveMembers().length;
    return alive > nodeCount && alive - nodeCount >= Math.ceil(alive * 0.5);
  }

  /**
   * Get local node version (for metadata)
   */
  private getLocalVersion(): number {
    if (!this.context) {
      return 0;
    }

    const localNode = this.context.getLocalNodeInfo();
    return localNode.version || 0;
  }

  /**
   * Analyze cluster performance metrics (enhanced version)
   */
  getPerformanceMetrics(): PerformanceMetrics {
    return this.performanceHistory[this.performanceHistory.length - 1] || this.collectCurrentMetrics();
  }

  /**
   * Get cluster stability metrics
   */
  getStabilityMetrics(): {
    churnRate: number;
    partitionCount: number;
    averageUptime: number;
    membershipStability: number;
  } {
    if (!this.context) {
      throw new Error('ClusterIntrospection requires context to be set');
    }

    const now = Date.now();
    const windowMs = 60_000; // one-minute window for churn rate

    // Churn rate: membership changes in the last minute, expressed as
    // changes-per-minute.
    const recentChanges = this.membershipChangeTimestamps.filter(
      ts => now - ts <= windowMs
    );
    // Prune old entries to avoid unbounded growth.
    this.membershipChangeTimestamps = this.membershipChangeTimestamps.filter(
      ts => now - ts <= windowMs * 5
    );
    const churnRate = recentChanges.length; // changes per minute

    // Partition count derived from health data.
    const members = this.context.membership.getAllMembers();
    const aliveCount = members.filter(m => m.status === 'ALIVE').length;
    const partitionCount = this.detectPartitionCount(members.length, aliveCount);

    // Average uptime: mean time-since-last-seen across alive members.
    const aliveMembers = this.context.membership.getAliveMembers();
    const averageUptime = aliveMembers.length > 0
      ? aliveMembers.reduce((sum, m) => sum + (now - m.lastSeen), 0) / aliveMembers.length
      : 0;

    // Membership stability: ratio of intervals without any churn event over
    // the tracking window (simple approximation).
    const elapsedSinceStart = now - this.trackingStartTime;
    const windowCount = Math.max(1, Math.floor(elapsedSinceStart / windowMs));
    const churnWindows = Math.min(
      windowCount,
      this.membershipChangeTimestamps.length
    );
    const membershipStability = Math.max(0, 1 - churnWindows / windowCount);

    return {
      churnRate,
      partitionCount,
      averageUptime,
      membershipStability
    };
  }
}
