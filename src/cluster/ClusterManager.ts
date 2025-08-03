import { EventEmitter } from 'events';
import { Transport } from '../transport/Transport';
import { Message, MessageType } from '../types';
import { MembershipTable } from './membership/MembershipTable';
import { GossipStrategy } from './gossip/GossipStrategy';
import { ConsistentHashRing } from './routing/ConsistentHashRing';
import { BootstrapConfig } from './config/BootstrapConfig';
import { FailureDetector } from './monitoring/FailureDetector';
import { KeyManager, KeyManagerConfig } from '../identity/KeyManager';
import { 
  NodeInfo, 
  ClusterMessage, 
  JoinMessage, 
  GossipMessage,
  LeaveMessage,
  ClusterEvents,
  MembershipEntry,
  ClusterHealth,
  ClusterMetadata,
  ClusterTopology,
  DistributionStrategy,
  QuorumOptions,
  PartitionInfo
} from './types';

// Import new modular components
import { IClusterManagerContext } from './core/IClusterManagerContext';
import { ClusterLifecycle } from './lifecycle/ClusterLifecycle';
import { ClusterCommunication } from './communication/ClusterCommunication';
import { ClusterIntrospection } from './introspection/ClusterIntrospection';
import { ClusterSecurity } from './keys/ClusterSecurity';
import { ClusterQuorum } from './quorum/ClusterQuorum';
import { ClusterRouting } from './routing/ClusterRouting';

export class ClusterManager extends EventEmitter implements IClusterManagerContext {
  // Core components (exposed via IClusterManagerContext)
  readonly membership: MembershipTable;
  readonly gossipStrategy: GossipStrategy;
  readonly hashRing: ConsistentHashRing;
  readonly failureDetector: FailureDetector;
  readonly keyManager: KeyManager;
  readonly transport: Transport;
  readonly config: BootstrapConfig;
  readonly localNodeId: string;
  
  // Internal state
  private isStarted = false;
  recentUpdates: NodeInfo[] = [];
  private localVersion = 1;

  // Modular components
  private lifecycle: ClusterLifecycle;
  private communication: ClusterCommunication;
  private introspection: ClusterIntrospection;
  private security: ClusterSecurity;
  private quorum: ClusterQuorum;
  private routing: ClusterRouting;

  constructor(
    localNodeId: string,
    transport: Transport,
    config: BootstrapConfig,
    virtualNodesPerNode: number = 100,
    private nodeMetadata: { region?: string; zone?: string; role?: string; tags?: Record<string, string> } = {},
    lifecycleConfig?: {
      shutdownTimeout?: number;
      drainTimeout?: number;
      enableAutoRebalance?: boolean;
      rebalanceThreshold?: number;
      enableGracefulShutdown?: boolean;
      maxShutdownWait?: number;
    }
  ) {
    super();
    
    // Initialize readonly properties
    this.localNodeId = localNodeId;
    this.transport = transport;
    this.config = config;
    
    // Get actual transport info for local node
    const transportInfo = transport.getLocalNodeInfo();
    const localNode = {
      id: localNodeId,
      address: transportInfo.address,
      port: transportInfo.port
    };
    
    this.membership = new MembershipTable(localNodeId);
    this.gossipStrategy = new GossipStrategy(localNodeId, transport, config.gossipInterval, config.enableLogging);
    this.hashRing = new ConsistentHashRing(virtualNodesPerNode);
    
    // Initialize key manager for secure communications
    this.keyManager = new KeyManager({
      ...config.keyManager,
      enableLogging: config.enableLogging
    });
    
    // Initialize failure detector
    this.failureDetector = new FailureDetector(
      this.localNodeId,
      localNode,
      transport,
      this.membership,
      config.failureDetector
    );

        // Initialize modular components - prefer explicit lifecycleConfig over config.lifecycle
    const effectiveLifecycleConfig = lifecycleConfig || config.lifecycle || {};
    this.lifecycle = new ClusterLifecycle({
      shutdownTimeout: effectiveLifecycleConfig.shutdownTimeout || 10000,
      drainTimeout: effectiveLifecycleConfig.drainTimeout || 30000,
      enableAutoRebalance: effectiveLifecycleConfig.enableAutoRebalance ?? true,
      rebalanceThreshold: effectiveLifecycleConfig.rebalanceThreshold || 0.1,
      enableGracefulShutdown: effectiveLifecycleConfig.enableGracefulShutdown ?? true,
      maxShutdownWait: effectiveLifecycleConfig.maxShutdownWait || 5000
    });
    this.lifecycle.setContext(this);

    this.communication = new ClusterCommunication({
      gossipInterval: config.gossipInterval,
      gossipFanout: 3,
      joinTimeout: 5000,
      antiEntropy: {
        enabled: true,
        interval: 30000,
        forceFullSync: false
      }
    });
    this.communication.setContext(this);

    this.introspection = new ClusterIntrospection();
    this.introspection.setContext(this);

    this.security = new ClusterSecurity();
    this.security.setContext(this);

    this.quorum = new ClusterQuorum();
    this.quorum.setContext(this);

    this.routing = new ClusterRouting();
    this.routing.setContext(this);
    
        // Connect membership events
    this.membership.on('member-joined', (nodeInfo: NodeInfo) => this.emit('member-joined', nodeInfo));
    this.membership.on('member-left', (nodeId: string) => this.emit('member-left', nodeId));
    this.membership.on('member-updated', (nodeInfo: NodeInfo) => this.emit('member-updated', nodeInfo));
    this.membership.on('membership-updated', (membership: Map<string, MembershipEntry>) => {
      this.hashRing.rebuild(Array.from(membership.values()).filter(entry => entry.status === 'ALIVE'));
      this.emit('membership-updated', membership);
    });
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    // Set up message handling delegation to communication module
    this.transport.onMessage((message: Message) => {
      this.communication.handleMessage(message);
    });

    // Use lifecycle module for startup
    await this.lifecycle.start();

    // Start communication (gossip and join cluster)
    this.communication.startGossipTimer();
    await this.communication.joinCluster();

    // Start introspection tracking after cluster is started
    if (this.introspection && typeof this.introspection.startTracking === 'function') {
      this.introspection.startTracking();
    }

    this.isStarted = true;
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    // Stop communication first
    this.communication.stopGossipTimer();

    // Stop failure detection
    if (this.failureDetector) {
      this.failureDetector.stop();
    }

    // Clean up introspection timers and listeners
    if (this.introspection) {
      this.introspection.destroy();
    }

    // Use lifecycle module for shutdown
    await this.lifecycle.stop();

    // Remove all event listeners to prevent memory leaks
    this.removeAllListeners();

    this.isStarted = false;
    this.emit('stopped');
  }

  /**
   * Get local node info (required by IClusterManagerContext)
   */
  getLocalNodeInfo(): NodeInfo {
    // Get actual address and port from transport
    const transportInfo = this.transport.getLocalNodeInfo();
    
    return {
      id: this.localNodeId,
      status: 'ALIVE',
      lastSeen: Date.now(),
      version: this.localVersion,
      metadata: {
        address: transportInfo.address,
        port: transportInfo.port,
        role: this.nodeMetadata.role || 'node',
        region: this.nodeMetadata.region,
        zone: this.nodeMetadata.zone,
        tags: this.nodeMetadata.tags
      }
    };
  }

  /**
   * Add node info to recent updates buffer (required by IClusterManagerContext)
   */
  addToRecentUpdates(nodeInfo: NodeInfo): void {
    this.recentUpdates.push(nodeInfo);
    
    // Keep buffer size reasonable
    if (this.recentUpdates.length > 10) {
      this.recentUpdates = this.recentUpdates.slice(-10);
    }
  }

  /**
   * Check if cluster is bootstrapped (required by IClusterManagerContext)
   */
  isBootstrapped(): boolean {
    return this.isStarted && this.membership.getAllMembers().length > 0;
  }

  /**
   * Get cluster size (required by IClusterManagerContext)
   */
  getClusterSize(): number {
    return this.membership.getAllMembers().length;
  }

  /**
   * Rebuild consistent hash ring from current membership
   */
  rebuildHashRing(): void {
    const aliveMembers = this.membership.getAliveMembers();
    this.hashRing.rebuild(aliveMembers);
  }

  // Public API methods
  getMembership(): Map<string, MembershipEntry> {
    return new Map(this.membership.getAllMembers().map((member: MembershipEntry) => [member.id, member]));
  }
  getMemberCount(): number { return this.membership.getAllMembers().length; }
  getNodeInfo(): NodeInfo {
    const members = this.membership.getAllMembers();
    const localMember = members.find((member: MembershipEntry) => member.id === this.localNodeId);
    if (!localMember) {
      return {
        id: this.localNodeId,
        status: 'ALIVE',
        lastSeen: Date.now(),
        version: 0,
        metadata: { address: 'localhost', port: 0 }
      };
    }
    return localMember;
  }
  getAliveMembers(): MembershipEntry[] { return this.membership.getAliveMembers(); }

  // Consistent Hashing API
  getNodeForKey(key: string): string | null { return this.routing.getNodeForKey(key); }
  getReplicaNodes(key: string, replicaCount: number = 3): string[] { return this.routing.getReplicaNodes(key, replicaCount); }
  getNodesForKey(key: string, options: any = { 
    strategy: 'CONSISTENT_HASH', 
    replicationFactor: 3, 
    preferLocalZone: false 
  }): string[] { return this.routing.getNodesForKey(key, options); }

  /**
   * Increment local version (for reincarnation)
   */
  incrementVersion(): void {
    this.localVersion++;
    
    // Update local node in membership
    const updatedLocalInfo = this.getLocalNodeInfo();
    this.membership.addLocalNode(updatedLocalInfo);
    this.addToRecentUpdates(updatedLocalInfo);
  }

  // Membership Management
  markNodeSuspect(nodeId: string): boolean { return this.membership.markSuspect(nodeId); }
  markNodeDead(nodeId: string): boolean { return this.membership.markDead(nodeId); }
  pruneDeadNodes(maxAge: number = 30000): number { return this.membership.pruneDeadNodes(maxAge); }
  async leave(timeout?: number): Promise<void> { return this.lifecycle.leave(); }

  // Cluster Health & Analytics
  getMetadata(): ClusterMetadata { return this.introspection.getMetadata(); }
  getClusterHealth(): ClusterHealth { return this.introspection.getClusterHealth(); }
  getTopology(): ClusterTopology { return this.introspection.getTopology(); }
  canHandleFailures(nodeCount: number): boolean { return this.quorum.canHandleFailures(nodeCount); }
  getIntrospection(): ClusterIntrospection { return this.introspection; }
  getTransport(): Transport { return this.transport; }

  // Advanced Cluster Operations
  async drainNode(nodeId: string, timeout: number = 30000): Promise<boolean> {
    try {
      await this.lifecycle.drainNode(nodeId);
      return true;
    } catch (error) {
      return false;
    }
  }

  rebalanceCluster(): void { this.lifecycle.rebalanceCluster(); }

  /**
   * Get cluster metadata summary (alternative method name)
   */
  getClusterMetadata(): ClusterMetadata {
    return this.introspection.getMetadata();
  }

  // Testing & Debugging API
  getFailureDetector(): FailureDetector { return this.failureDetector; }
  getKeyManager(): KeyManager { return this.keyManager; }

  // Security & Key Management API
  getPublicKey(): string { return this.security.getPublicKey(); }
  pinNodeCertificate(nodeId: string, publicKey: string): void { this.security.pinNodeCertificate(nodeId, publicKey); }
  unpinNodeCertificate(nodeId: string): boolean { return this.security.unpinNodeCertificate(nodeId); }
  getPinnedCertificates(): Map<string, string> { return this.security.getPinnedCertificates(); }
  verifyNodeMessage(message: string, signature: string, nodeId: string): boolean { return this.security.verifyNodeMessage(message, signature, nodeId); }

  // Quorum & Partition Handling
  hasQuorum(opts: QuorumOptions): boolean { return this.quorum.hasQuorum(opts); }
  runAntiEntropyCycle(): void { this.communication.runAntiEntropyCycle(); }
  detectPartition(): PartitionInfo | null { return this.quorum.detectPartition(); }
}
