import { EventEmitter } from 'events';
import {
  IClusterCoordinator,
  ClusterView,
  RangeId,
  RingId,
  RangeLease,
  NodeStatus,
  ClusterFrameworkEvents
} from '../coordinators/types';
import { ClusterManager } from '../cluster/ClusterManager';
import { BootstrapConfig } from '../config/BootstrapConfig';
import { InMemoryAdapter } from '../transport/adapters/InMemoryAdapter';
import { NodeInfo } from '../types';
import { NodeId } from '../types';

/**
 * Gossip-based coordinator that uses the existing cluster infrastructure
 * for eventually consistent range coordination across nodes.
 */
export class GossipCoordinator extends EventEmitter implements IClusterCoordinator {
  private nodeId!: string;
  private ringId!: RingId;
  private clusterManager!: ClusterManager;
  private transport!: InMemoryAdapter;
  private ownedRanges = new Set<RangeId>();
  private leases = new Map<RangeId, RangeLease>();
  private started = false;
  private leaseRenewalInterval?: NodeJS.Timeout;
  
  // Configuration
  private config = {
    leaseTimeoutMs: 30000,
    leaseRenewalIntervalMs: 10000,
    maxRangesPerNode: 10,
    gossipInterval: 5000,
    enableLogging: true
  };

  async initialize(nodeId: string, ringId: RingId, config?: Record<string, any>): Promise<void> {
    this.nodeId = nodeId;
    this.ringId = ringId;
    
    if (config) {
      this.config = { ...this.config, ...config };
    }

    // Create transport layer (using in-memory for now, can be configured)
    this.transport = new InMemoryAdapter({ id: nodeId } as NodeId);

    console.log(`🔧 GossipCoordinator initialized for node ${nodeId} in ring ${ringId}`);
  }

  async joinCluster(seedNodes: string[]): Promise<void> {
    console.log(`🚀 Node ${this.nodeId} joining cluster via gossip with seeds: ${seedNodes.join(', ')}`);
    
    // Create bootstrap config with seed nodes
    const bootstrapConfig = BootstrapConfig.create({
      seedNodes: seedNodes,
      gossipInterval: this.config.gossipInterval,
      enableLogging: this.config.enableLogging,
      joinTimeout: 10000
    });

    // Initialize cluster manager with ring-specific metadata
    this.clusterManager = new ClusterManager(
      this.nodeId,
      this.transport,
      bootstrapConfig,
      100, // virtualNodesPerNode
      { 
        role: 'range-coordinator',
        tags: { 
          coordinator: 'gossip',
          ringId: this.ringId
        }
      }
    );

    // Listen for cluster events
    this.setupEventListeners();
    
    // Start cluster manager
    await this.clusterManager.start();
    
    // Wait for initial membership sync
    await this.waitForMembership();
    
    this.emit('node-joined', this.nodeId);
  }

  async leaveCluster(): Promise<void> {
    console.log(`👋 Node ${this.nodeId} leaving cluster`);
    
    // Release all owned ranges
    const ranges = Array.from(this.ownedRanges);
    for (const rangeId of ranges) {
      await this.releaseLease(rangeId);
    }

    // Stop cluster manager
    await this.clusterManager.stop();
    
    this.emit('node-left', this.nodeId);
  }

  async acquireLease(rangeId: RangeId): Promise<boolean> {
    console.log(`🎯 Attempting to acquire lease for range ${rangeId} via gossip`);
    
    // Get current cluster view to check for conflicts
    const clusterView = await this.getClusterView();
    const existingLease = clusterView.leases.get(rangeId);
    const now = Date.now();

    // Check if lease exists and is still valid
    if (existingLease && existingLease.expiresAt > now) {
      if (existingLease.nodeId === this.nodeId) {
        console.log(`✅ Already own lease for range ${rangeId}`);
        return true;
      } else {
        // Check if the owning node is still alive
        const ownerNode = clusterView.nodes.get(existingLease.nodeId);
        if (ownerNode && ownerNode.isAlive) {
          console.log(`❌ Range ${rangeId} is owned by alive node ${existingLease.nodeId}`);
          this.emit('lease-conflict', rangeId, existingLease.nodeId);
          return false;
        } else {
          console.log(`🔄 Previous owner ${existingLease.nodeId} is dead, acquiring range ${rangeId}`);
        }
      }
    }

    // Check if we're at the max range limit
    if (this.ownedRanges.size >= this.config.maxRangesPerNode) {
      console.log(`⚠️ Cannot acquire range ${rangeId}: at max capacity (${this.config.maxRangesPerNode})`);
      return false;
    }

    // Create new lease
    const lease: RangeLease = {
      rangeId,
      nodeId: this.nodeId,
      acquiredAt: now,
      expiresAt: now + this.config.leaseTimeoutMs,
      version: existingLease ? existingLease.version + 1 : 1
    };

    // Store lease locally and gossip it
    this.leases.set(rangeId, lease);
    this.ownedRanges.add(rangeId);
    
    // Broadcast lease acquisition via gossip
    await this.broadcastLeaseUpdate(lease);
    
    console.log(`🎉 Successfully acquired lease for range ${rangeId}`);
    this.emit('range-acquired', rangeId);
    return true;
  }

  async releaseLease(rangeId: RangeId): Promise<void> {
    console.log(`🔓 Releasing lease for range ${rangeId}`);
    
    const lease = this.leases.get(rangeId);
    if (lease && lease.nodeId === this.nodeId) {
      // Mark lease as released
      lease.expiresAt = Date.now() - 1;
      
      // Broadcast lease release
      await this.broadcastLeaseUpdate(lease);
      
      // Clean up locally
      this.leases.delete(rangeId);
      this.ownedRanges.delete(rangeId);
      
      this.emit('range-released', rangeId);
      console.log(`✅ Released lease for range ${rangeId}`);
    } else {
      console.log(`⚠️ Cannot release range ${rangeId}: not owned by this node`);
    }
  }

  async getClusterView(): Promise<ClusterView> {
    const membership = this.clusterManager.getMembership();
    const nodes = new Map<string, NodeStatus>();
    
    // Convert membership entries to node status
    for (const [nodeId, entry] of membership) {
      nodes.set(nodeId, {
        nodeId,
        lastSeen: entry.lastSeen,
        metadata: entry.metadata || {},
        isAlive: entry.status === 'ALIVE'
      });
    }

    // Merge lease information from all nodes
    // In a real gossip implementation, this would be collected from gossip messages
    const allLeases = new Map(this.leases);

    return {
      nodes,
      leases: allLeases,
      ringId: this.ringId,
      version: Date.now(),
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

    console.log(`🚀 Starting GossipCoordinator for node ${this.nodeId}`);
    this.started = true;

    // Start lease renewal
    this.leaseRenewalInterval = setInterval(() => {
      this.renewLeases();
    }, this.config.leaseRenewalIntervalMs);
    this.leaseRenewalInterval.unref(); // Prevent Jest hanging
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    console.log(`🛑 Stopping GossipCoordinator for node ${this.nodeId}`);
    this.started = false;

    if (this.leaseRenewalInterval) {
      clearInterval(this.leaseRenewalInterval);
      this.leaseRenewalInterval = undefined;
    }

    await this.leaveCluster();
  }

  private setupEventListeners(): void {
    this.clusterManager.on('member-joined', (nodeInfo: NodeInfo) => {
      console.log(`📥 Node joined cluster: ${nodeInfo.id}`);
      this.emit('node-joined', nodeInfo.id);
    });

    this.clusterManager.on('member-left', (nodeId: string) => {
      console.log(`📤 Node left cluster: ${nodeId}`);
      this.emit('node-left', nodeId);
      
      // Check if we need to take over any ranges from the departed node
      this.handleNodeDeparture(nodeId);
    });

    this.clusterManager.on('membership-updated', () => {
      this.emit('topology-changed', {} as ClusterView); // Will be populated by getClusterView()
    });
  }

  private async waitForMembership(): Promise<void> {
    // Wait a bit for initial gossip to propagate
    await new Promise(resolve => {
      const timer = setTimeout(resolve, this.config.gossipInterval * 2);
      timer.unref(); // Prevent Jest hanging
    });
  }

  private async broadcastLeaseUpdate(lease: RangeLease): Promise<void> {
    // In a real implementation, this would send lease information via gossip
    // For now, we'll simulate by logging
    console.log(`📡 Broadcasting lease update for range ${lease.rangeId}`);
    
    // The actual gossip broadcasting would happen through the cluster manager
    // by extending the gossip message format to include lease information
  }

  private renewLeases(): void {
    const now = Date.now();
    
    for (const rangeId of this.ownedRanges) {
      const lease = this.leases.get(rangeId);
      if (lease && lease.nodeId === this.nodeId) {
        // Renew the lease
        lease.expiresAt = now + this.config.leaseTimeoutMs;
        console.log(`🔄 Renewed lease for range ${rangeId}`);
        
        // Broadcast renewal
        this.broadcastLeaseUpdate(lease);
      }
    }
  }

  private async handleNodeDeparture(departedNodeId: string): Promise<void> {
    // Check if the departed node owned any ranges that we should take over
    // This is a simplified approach - in practice, you'd want more sophisticated
    // rebalancing logic
    console.log(`🔍 Checking for orphaned ranges from departed node ${departedNodeId}`);
    
    // This would typically involve consulting the ring topology and
    // determining which node should take over responsibility
  }
}
