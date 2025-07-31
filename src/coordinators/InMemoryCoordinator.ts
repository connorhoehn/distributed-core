import { EventEmitter } from 'events';
import {
  IClusterCoordinator,
  ClusterView,
  RangeId,
  RingId,
  RangeLease,
  NodeStatus,
  ClusterFrameworkEvents
} from './types';
import { createLogger, FrameworkLogger } from '../common/logger';

/**
 * In-memory coordinator for testing and development.
 * Provides fast, deterministic coordination without external dependencies.
 * 
 * Note: This coordinator is not suitable for production distributed environments
 * as it only maintains state locally and cannot coordinate across multiple processes.
 */
export class InMemoryCoordinator extends EventEmitter implements IClusterCoordinator {
  private nodeId!: string;
  private ringId!: RingId;
  private nodes = new Map<string, NodeStatus>();
  private leases = new Map<RangeId, RangeLease>();
  private ownedRanges = new Set<RangeId>();
  private started = false;
  private heartbeatInterval?: NodeJS.Timeout;
  private leaseRenewalInterval?: NodeJS.Timeout;
  private leaseCleanupInterval?: NodeJS.Timeout;
  private logger!: FrameworkLogger;
  
  // Configuration with controllable timeouts for testing
  private config = {
    heartbeatIntervalMs: 5000,
    leaseRenewalIntervalMs: 10000,
    leaseTimeoutMs: 30000,
    maxRangesPerNode: 10,
    // Test-friendly shorter intervals that can be overridden
    testMode: false
  };

  async initialize(nodeId: string, ringId: RingId, config?: Record<string, any>): Promise<void> {
    this.nodeId = nodeId;
    this.ringId = ringId;
    
    // Initialize logger with config from the parent ClusterNodeConfig
    this.logger = createLogger(config?.logging);
    
    if (config) {
      this.config = { ...this.config, ...config };
      
      // If in test mode, use much shorter intervals to prevent test timeouts
      if (config.testMode || process.env.NODE_ENV === 'test') {
        this.config.heartbeatIntervalMs = config.heartbeatIntervalMs || 100;
        this.config.leaseRenewalIntervalMs = config.leaseRenewalIntervalMs || 200;
        this.config.leaseTimeoutMs = config.leaseTimeoutMs || 1000;
        this.config.testMode = true;
      }
    }

    // Add this node to the cluster
    this.nodes.set(nodeId, {
      nodeId,
      lastSeen: Date.now(),
      metadata: {},
      isAlive: true
    });

    this.logger.coordinator(`🔧 InMemoryCoordinator initialized for node ${nodeId} in ring ${ringId}`);
    
    if (this.config.testMode) {
      this.logger.coordinator(`🧪 Test mode enabled - using shorter intervals for testing`);
    }
  }

  async joinCluster(seedNodes: string[]): Promise<void> {
    // In-memory coordinator doesn't need actual network joining
    // Just simulate the process
    this.logger.coordinator(`🚀 Node ${this.nodeId} joining cluster with seeds: ${seedNodes.join(', ')}`);
    
    // Simulate adding seed nodes to our view
    for (const seedNode of seedNodes) {
      if (seedNode !== this.nodeId && !this.nodes.has(seedNode)) {
        this.nodes.set(seedNode, {
          nodeId: seedNode,
          lastSeen: Date.now(),
          metadata: {},
          isAlive: true
        });
      }
    }

    this.emit('node-joined', this.nodeId);
  }

  async leaveCluster(): Promise<void> {
    this.logger.coordinator(`👋 Node ${this.nodeId} leaving cluster`);
    
    // Release all owned ranges
    const ranges = Array.from(this.ownedRanges);
    for (const rangeId of ranges) {
      await this.releaseLease(rangeId);
    }

    // Remove this node from the cluster
    this.nodes.delete(this.nodeId);
    this.emit('node-left', this.nodeId);
  }

  async acquireLease(rangeId: RangeId): Promise<boolean> {
    this.logger.coordinator(`🎯 Attempting to acquire lease for range ${rangeId}`);
    
    const existingLease = this.leases.get(rangeId);
    const now = Date.now();

    // Check if lease exists and is still valid
    if (existingLease && existingLease.expiresAt > now) {
      if (existingLease.nodeId === this.nodeId) {
        // We already own this lease
        this.logger.coordinator(`✅ Already own lease for range ${rangeId}`);
        return true;
      } else {
        // Another node owns the lease
        this.logger.coordinator(`❌ Range ${rangeId} is owned by ${existingLease.nodeId}`);
        this.emit('lease-conflict', rangeId, existingLease.nodeId);
        return false;
      }
    }

    // Check if we're at the max range limit
    if (this.ownedRanges.size >= this.config.maxRangesPerNode) {
      this.logger.coordinator(`⚠️ Cannot acquire range ${rangeId}: at max capacity (${this.config.maxRangesPerNode})`);
      return false;
    }

    // Acquire the lease
    const lease: RangeLease = {
      rangeId,
      nodeId: this.nodeId,
      acquiredAt: now,
      expiresAt: now + this.config.leaseTimeoutMs,
      version: existingLease ? existingLease.version + 1 : 1
    };

    this.leases.set(rangeId, lease);
    this.ownedRanges.add(rangeId);
    
    this.logger.coordinator(`🎉 Successfully acquired lease for range ${rangeId}`);
    this.emit('range-acquired', rangeId);
    return true;
  }

  async releaseLease(rangeId: RangeId): Promise<void> {
    this.logger.coordinator(`🔓 Releasing lease for range ${rangeId}`);
    
    const lease = this.leases.get(rangeId);
    if (lease && lease.nodeId === this.nodeId) {
      this.leases.delete(rangeId);
      this.ownedRanges.delete(rangeId);
      this.emit('range-released', rangeId);
      this.logger.coordinator(`✅ Released lease for range ${rangeId}`);
    } else {
      this.logger.coordinator(`⚠️ Cannot release range ${rangeId}: not owned by this node`);
    }
  }

  async getClusterView(): Promise<ClusterView> {
    return {
      nodes: new Map(this.nodes),
      leases: new Map(this.leases),
      ringId: this.ringId,
      version: Date.now(), // Simple versioning
      lastUpdated: Date.now()
    };
  }

  async getOwnedRanges(): Promise<RangeId[]> {
    return Array.from(this.ownedRanges);
  }

  async ownsRange(rangeId: RangeId): Promise<boolean> {
    return this.ownedRanges.has(rangeId);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.logger.coordinator(`🚀 Starting InMemoryCoordinator for node ${this.nodeId}`);
    this.started = true;

    // Start heartbeat to keep node alive
    this.heartbeatInterval = setInterval(() => {
      this.updateHeartbeat();
    }, this.config.heartbeatIntervalMs);

    // Start lease renewal
    this.leaseRenewalInterval = setInterval(() => {
      this.renewLeases();
    }, this.config.leaseRenewalIntervalMs);

    // Clean up expired leases periodically
    this.leaseCleanupInterval = setInterval(() => {
      this.cleanupExpiredLeases();
    }, this.config.leaseTimeoutMs / 2);
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.logger.coordinator(`🛑 Stopping InMemoryCoordinator for node ${this.nodeId}`);
    this.started = false;

    // Clear all timers to prevent loose handles
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    if (this.leaseRenewalInterval) {
      clearInterval(this.leaseRenewalInterval);
      this.leaseRenewalInterval = undefined;
    }

    if (this.leaseCleanupInterval) {
      clearInterval(this.leaseCleanupInterval);
      this.leaseCleanupInterval = undefined;
    }

    await this.leaveCluster();
  }

  private updateHeartbeat(): void {
    if (!this.started) {
      return;
    }
    
    const node = this.nodes.get(this.nodeId);
    if (node) {
      node.lastSeen = Date.now();
    }
  }

  private renewLeases(): void {
    if (!this.started) {
      return;
    }
    
    const now = Date.now();
    
    for (const rangeId of this.ownedRanges) {
      const lease = this.leases.get(rangeId);
      if (lease && lease.nodeId === this.nodeId) {
        // Renew the lease
        lease.expiresAt = Date.now() + this.config.leaseTimeoutMs;
        this.logger.coordinator(`🔄 Renewed lease for range ${rangeId}`);
        
        // Broadcast renewal
        this.broadcastLeaseUpdate && this.broadcastLeaseUpdate(lease);
      }
    }
  }

  private cleanupExpiredLeases(): void {
    if (!this.started) {
      return;
    }
    
    const now = Date.now();
    const expiredLeases: RangeId[] = [];

    for (const [rangeId, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        expiredLeases.push(rangeId);
      }
    }

    for (const rangeId of expiredLeases) {
      const lease = this.leases.get(rangeId)!;
      this.logger.coordinator(`⏰ Lease expired for range ${rangeId} (was owned by ${lease.nodeId})`);
      
      if (lease.nodeId === this.nodeId) {
        this.ownedRanges.delete(rangeId);
        this.emit('range-released', rangeId);
      }
      
      this.leases.delete(rangeId);
    }
  }

  // Optional method for lease broadcasting (used in GossipCoordinator)
  private broadcastLeaseUpdate?: (lease: RangeLease) => void;

  // EventEmitter interface is inherited
}
