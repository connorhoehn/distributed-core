import { EventEmitter } from 'events';
import { Transport } from '../transport/Transport';
import { Message, MessageType } from '../types';
import { MembershipTable } from './MembershipTable';
import { GossipStrategy } from './GossipStrategy';
import { ConsistentHashRing } from './ConsistentHashRing';
import { BootstrapConfig } from './BootstrapConfig';
import { 
  NodeInfo, 
  ClusterMessage, 
  JoinMessage, 
  GossipMessage,
  ClusterEvents,
  MembershipEntry,
  ClusterHealth,
  ClusterMetadata,
  ClusterTopology,
  DistributionStrategy
} from './types';

export class ClusterManager extends EventEmitter {
  private membership: MembershipTable;
  private gossipStrategy: GossipStrategy;
  private hashRing: ConsistentHashRing;
  private isStarted = false;
  private gossipTimer?: NodeJS.Timeout;
  private recentUpdates: NodeInfo[] = [];
  private localVersion = 1;

  constructor(
    private localNodeId: string,
    private transport: Transport,
    private config: BootstrapConfig,
    virtualNodesPerNode: number = 100
  ) {
    super();
    
    this.membership = new MembershipTable(localNodeId);
    this.gossipStrategy = new GossipStrategy(localNodeId, transport, config.gossipInterval);
    this.hashRing = new ConsistentHashRing(virtualNodesPerNode);
    
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

    // Add self to membership
    const localNode: NodeInfo = {
      id: this.localNodeId,
      status: 'ALIVE',
      lastSeen: Date.now(),
      version: 0,
      metadata: {
        address: 'localhost', // Will be set by transport layer
        port: 0              // Will be set by transport layer
      }
    };
    
    this.membership.addLocalNode(localNode);
    this.rebuildHashRing();

    // Set up transport message handling
    this.transport.onMessage(this.handleMessage.bind(this));
    await this.transport.start();

    // Join via seed nodes
    await this.joinCluster();

    // Start periodic gossip
    this.startGossipTimer();

    this.isStarted = true;
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    // Stop gossip timer
    if (this.gossipTimer) {
      clearInterval(this.gossipTimer);
    }

    await this.transport.stop();
    this.membership.clear();
    this.hashRing.rebuild([]);
    this.isStarted = false;
    this.emit('stopped');
  }

  /**
   * Join cluster via seed nodes
   */
  private async joinCluster(): Promise<void> {
    const seedNodes = this.config.getSeedNodes();
    
    for (const seedNode of seedNodes) {
      if (seedNode !== this.localNodeId) {
        try {
          const localNodeInfo = this.getLocalNodeInfo();
          const joinData: JoinMessage = {
            type: 'JOIN',
            nodeInfo: localNodeInfo,
            isResponse: false
          };

          const transportMessage: Message = {
            id: `join-${Date.now()}-${Math.random()}`,
            type: MessageType.JOIN,
            data: joinData,
            sender: { id: this.localNodeId, address: '', port: 0 },
            timestamp: Date.now()
          };
          
          await this.transport.send(transportMessage, { id: seedNode, address: '', port: 0 });
        } catch (error) {
          console.debug(`Failed to join via seed node ${seedNode}:`, error);
        }
      }
    }
  }

  /**
   * Handle incoming transport messages
   */
  private handleMessage(message: Message): void {
    try {
      const clusterMessage = message.data as ClusterMessage;
      
      switch (clusterMessage.type) {
        case 'JOIN':
          this.handleJoinMessage(clusterMessage, message.sender.id);
          break;
        case 'GOSSIP':
          this.handleGossipMessage(clusterMessage);
          break;
      }
    } catch (error) {
      console.error('Error handling cluster message:', error);
    }
  }

  /**
   * Handle JOIN messages
   */
  private handleJoinMessage(joinMessage: JoinMessage, senderId: string): void {
    // Update membership with sender info
    if (senderId !== this.localNodeId) {
      const updated = this.membership.updateNode(joinMessage.nodeInfo);
      
      if (updated) {
        this.addToRecentUpdates(joinMessage.nodeInfo);
      }

      // Handle membership snapshot in response
      if (joinMessage.isResponse && joinMessage.membershipSnapshot) {
        for (const nodeInfo of joinMessage.membershipSnapshot) {
          const snapshotUpdated = this.membership.updateNode(nodeInfo);
          if (snapshotUpdated) {
            this.addToRecentUpdates(nodeInfo);
          }
        }
      }

      // Send response if this was initial join (not a response)
      if (!joinMessage.isResponse) {
        this.sendJoinResponse(senderId);
      }
    }
  }

  /**
   * Send JOIN response with local info and membership snapshot
   */
  private async sendJoinResponse(targetNodeId: string): Promise<void> {
    try {
      const localNodeInfo = this.getLocalNodeInfo();
      const aliveMembers = this.membership.getAliveMembers();
      
      const joinResponse: JoinMessage = {
        type: 'JOIN',
        nodeInfo: localNodeInfo,
        isResponse: true,
        membershipSnapshot: aliveMembers.slice(0, 10) // Limit snapshot size
      };

      const transportMessage: Message = {
        id: `join-response-${Date.now()}-${Math.random()}`,
        type: MessageType.JOIN,
        data: joinResponse,
        sender: { id: this.localNodeId, address: '', port: 0 },
        timestamp: Date.now()
      };

      await this.transport.send(transportMessage, { id: targetNodeId, address: '', port: 0 });
    } catch (error) {
      console.debug(`Failed to send join response to ${targetNodeId}:`, error);
    }
  }

  /**
   * Handle GOSSIP messages
   */
  private handleGossipMessage(gossipMessage: GossipMessage): void {
    this.emit('gossip-received', gossipMessage);

    // Handle single node info
    if (gossipMessage.nodeInfo) {
      const updated = this.membership.updateNode(gossipMessage.nodeInfo);
      if (updated) {
        this.addToRecentUpdates(gossipMessage.nodeInfo);
      }
    }

    // Handle membership diff
    if (gossipMessage.membershipDiff) {
      for (const nodeInfo of gossipMessage.membershipDiff) {
        const updated = this.membership.updateNode(nodeInfo);
        if (updated) {
          this.addToRecentUpdates(nodeInfo);
        }
      }
    }
  }

  /**
   * Start periodic gossip timer
   */
  private startGossipTimer(): void {
    this.gossipTimer = setInterval(async () => {
      try {
        const aliveMembers = this.membership.getAliveMembers();
        
        if (aliveMembers.length > 1) { // Don't gossip if alone
          await this.gossipStrategy.sendPeriodicGossip(aliveMembers, this.recentUpdates);
          this.recentUpdates = []; // Clear after sending
        }
      } catch (error) {
        console.debug('Error during periodic gossip:', error);
      }
    }, this.config.gossipInterval);
  }

  /**
   * Rebuild consistent hash ring from current membership
   */
  private rebuildHashRing(): void {
    const aliveMembers = this.membership.getAliveMembers();
    this.hashRing.rebuild(aliveMembers);
  }

  /**
   * Get local node info
   */
  private getLocalNodeInfo(): NodeInfo {
    return {
      id: this.localNodeId,
      status: 'ALIVE',
      lastSeen: Date.now(),
      version: this.localVersion,
      metadata: {
        address: 'localhost',
        port: 0,
        role: 'node'
      }
    };
  }

  /**
   * Add node info to recent updates buffer
   */
  private addToRecentUpdates(nodeInfo: NodeInfo): void {
    this.recentUpdates.push(nodeInfo);
    
    // Keep buffer size reasonable
    if (this.recentUpdates.length > 10) {
      this.recentUpdates = this.recentUpdates.slice(-10);
    }
  }

  // Public API methods

  /**
   * Get current membership
   */
  getMembership(): Map<string, MembershipEntry> {
    return new Map(this.membership.getAllMembers().map((member: MembershipEntry) => [member.id, member]));
  }

  /**
   * Get member count
   */
  getMemberCount(): number {
    return this.membership.getAllMembers().length;
  }

  /**
   * Get current node info
   */
  getNodeInfo(): NodeInfo {
    const members = this.membership.getAllMembers();
    const localMember = members.find((member: MembershipEntry) => member.id === this.localNodeId);
    if (!localMember) {
      // Return a default node info if not found in membership yet
      return {
        id: this.localNodeId,
        status: 'ALIVE',
        lastSeen: Date.now(),
        version: 0,
        metadata: {
          address: 'localhost',
          port: 0
        }
      };
    }
    return localMember;
  }

  /**
   * Get alive members
   */
  getAliveMembers(): MembershipEntry[] {
    return this.membership.getAliveMembers();
  }

  // Consistent Hashing API

  /**
   * Get primary node responsible for key
   */
  getNodeForKey(key: string): string | null {
    return this.hashRing.getNode(key);
  }

  /**
   * Get replica nodes for key (including primary)
   * @param key - The key to route
   * @param replicaCount - Number of replicas (default: 3)
   */
  getReplicaNodes(key: string, replicaCount: number = 3): string[] {
    return this.hashRing.getNodes(key, replicaCount);
  }

  /**
   * Get N nodes responsible for key with advanced routing options
   * @param key - The key to route
   * @param options - Routing options with strategy and preferences
   */
  getNodesForKey(key: string, options: any = { 
    strategy: 'CONSISTENT_HASH', 
    replicationFactor: 3, 
    preferLocalZone: false 
  }): string[] {
    switch (options.strategy) {
      case 'CONSISTENT_HASH':
        return this.hashRing.getNodes(key, options.replicationFactor);
      case 'ROUND_ROBIN':
        return this.getAliveMembers().map(member => member.id);
      case 'RANDOM':
        const members = this.getAliveMembers().map(member => member.id);
        return this.shuffleArray([...members]).slice(0, options.replicationFactor);
      case 'LOCALITY_AWARE':
        return this.getLocalityAwareNodes(key, options);
      default:
        return this.hashRing.getNodes(key, options.replicationFactor);
    }
  }

  /**
   * Get nodes with locality awareness
   */
  private getLocalityAwareNodes(key: string, options: any): string[] {
    const allNodes = this.getAliveMembers();
    const localNode = this.getNodeInfo();
    
    if (options.preferLocalZone && localNode.metadata?.zone) {
      const localZoneNodes = allNodes.filter(node => 
        node.metadata?.zone === localNode.metadata?.zone
      );
      
      if (localZoneNodes.length >= options.replicationFactor) {
        return localZoneNodes.slice(0, options.replicationFactor).map(n => n.id);
      }
    }
    
    // Fallback to consistent hashing
    return this.hashRing.getNodes(key, options.replicationFactor);
  }

  /**
   * Shuffle array in place
   */
  private shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

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

  /**
   * Mark node as suspect
   */
  markNodeSuspect(nodeId: string): boolean {
    return this.membership.markSuspect(nodeId);
  }

  /**
   * Mark node as dead
   */
  markNodeDead(nodeId: string): boolean {
    return this.membership.markDead(nodeId);
  }

  /**
   * Prune old dead nodes
   */
  pruneDeadNodes(maxAge: number = 30000): number {
    return this.membership.pruneDeadNodes(maxAge);
  }

  /**
   * Get cluster metadata summary
   */
  getMetadata(): ClusterMetadata {
    const members = this.getAliveMembers();
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
      version: this.localVersion,
      clusterId: this.generateClusterId(),
      created: Date.now()
    };
  }

  // Cluster Health & Analytics

  /**
   * Get cluster health metrics
   */
  getClusterHealth(): ClusterHealth {
    const members = this.membership.getAllMembers();
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
      partitionCount: 0 // TODO: Implement partition detection
    };
  }

  /**
   * Get cluster topology information
   */
  getTopology(): ClusterTopology {
    const members = this.getAliveMembers();
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
  private calculateLoadBalance(): number {
    const members = this.getAliveMembers();
    if (members.length <= 1) return 1.0;

    // Simple heuristic: perfect balance would be 1.0
    // For now, return a simplified metric based on node count
    return Math.min(1.0, members.length / 10); // Assume optimal around 10 nodes
  }

  /**
   * Check if cluster can handle node failures
   */
  canHandleFailures(nodeCount: number): boolean {
    const alive = this.getAliveMembers().length;
    return alive > nodeCount && alive - nodeCount >= Math.ceil(alive * 0.5);
  }

  // Advanced Cluster Operations

  /**
   * Gracefully drain a node from the cluster
   */
  async drainNode(nodeId: string, timeout: number = 30000): Promise<boolean> {
    if (nodeId === this.localNodeId) {
      throw new Error('Cannot drain local node');
    }

    // Mark node as suspect to start draining traffic
    const marked = this.markNodeSuspect(nodeId);
    if (!marked) return false;

    // Wait for traffic to drain
    await new Promise(resolve => setTimeout(resolve, Math.min(timeout, 5000)));

    // Mark as dead to complete removal
    return this.markNodeDead(nodeId);
  }

  /**
   * Rebalance the cluster by rebuilding the hash ring
   */
  rebalanceCluster(): void {
    this.rebuildHashRing();
    this.emit('cluster-rebalanced', {
      timestamp: Date.now(),
      nodeCount: this.getAliveMembers().length
    });
  }

  /**
   * Get cluster metadata summary
   */
  getClusterMetadata(): ClusterMetadata {
    const members = this.getAliveMembers();
    const roles = new Set(members.map(m => m.metadata?.role).filter(Boolean));
    const tags = new Map<string, Set<string>>();

    members.forEach(member => {
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
      version: this.localVersion,
      clusterId: this.generateClusterId(),
      created: Date.now()
    };
  }

  /**
   * Generate a deterministic cluster ID based on membership
   */
  private generateClusterId(): string {
    const sortedNodeIds = this.getAliveMembers()
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
}
