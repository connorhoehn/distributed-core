import { EventEmitter } from 'events';
import { IClusterCommunication, CommunicationConfig, GossipTargetSelection } from './types';
import { IClusterManagerContext, IRequiresContext } from '../core/IClusterManagerContext';
import { JoinMessage, GossipMessage, NodeInfo, MembershipEntry } from '../types';
import { Message, MessageType } from '../../types';

/**
 * ClusterCommunication manages gossip protocol and cluster join/leave operations
 * 
 * Responsibilities:
 * - Cluster joining via seed nodes
 * - Periodic gossip communication
 * - Message handling for JOIN/GOSSIP
 * - Anti-entropy synchronization
 * - Target selection for gossip rounds
 */
export class ClusterCommunication extends EventEmitter implements IClusterCommunication, IRequiresContext {
  private config: CommunicationConfig;
  private context?: IClusterManagerContext;
  private gossipTimer?: NodeJS.Timeout;
  private gossipTargetSelection: GossipTargetSelection;

  constructor(config?: Partial<CommunicationConfig>) {
    super();
    
    this.config = {
      gossipInterval: 1000,
      gossipFanout: 3,
      joinTimeout: 5000,
      antiEntropy: {
        enabled: true,
        interval: 30000,
        forceFullSync: false
      },
      retries: {
        maxAttempts: 3,
        backoffMs: 1000,
        maxBackoffMs: 5000
      },
      ...config
    };

    this.gossipTargetSelection = {
      strategy: 'random',
      maxTargets: this.config.gossipFanout,
      minTargets: 1
    };
  }

  /**
   * Set the cluster manager context for delegation
   */
  setContext(context: IClusterManagerContext): void {
    this.context = context;
  }

  /**
   * Join cluster via seed nodes
   */
  async joinCluster(): Promise<void> {
    if (!this.context) {
      throw new Error('ClusterCommunication requires context to be set');
    }

    const seedNodes = this.context.config.getSeedNodes();
    
    for (const seedNode of seedNodes) {
      if (seedNode !== this.context.localNodeId) {
        try {
          const localNodeInfo = this.context.getLocalNodeInfo();
          let joinData: JoinMessage = {
            type: 'JOIN',
            nodeInfo: localNodeInfo,
            isResponse: false
          };

          // Sign the join message
          joinData = this.context.keyManager.signClusterPayload(joinData);

          const transportMessage: Message = {
            id: `join-${Date.now()}-${Math.random()}`,
            type: MessageType.JOIN,
            data: joinData,
            sender: { id: this.context.localNodeId, address: '', port: 0 },
            timestamp: Date.now()
          };
          
          await this.context.transport.send(transportMessage, { id: seedNode, address: '', port: 0 });
        } catch (error) {
          this.emit('communication-error', { 
            error: error as Error, 
            operation: 'join-cluster',
            target: seedNode
          });
        }
      }
    }
  }

  /**
   * Start the periodic gossip timer
   */
  startGossipTimer(): void {
    if (!this.context) {
      throw new Error('ClusterCommunication requires context to be set');
    }

    if (this.gossipTimer) {
      return; // Already started
    }

    this.gossipTimer = setInterval(async () => {
      try {
        const aliveMembers = this.context!.membership.getAliveMembers();
        
        if (aliveMembers.length > 1) { // Don't gossip if alone
          await this.sendPeriodicGossip(aliveMembers);
        }
      } catch (error) {
        this.emit('communication-error', { 
          error: error as Error, 
          operation: 'periodic-gossip' 
        });
      }
    }, this.config.gossipInterval);
    
    // Prevent timer from keeping process alive
    this.gossipTimer.unref();
  }

  /**
   * Stop the gossip timer
   */
  stopGossipTimer(): void {
    if (this.gossipTimer) {
      clearInterval(this.gossipTimer);
      this.gossipTimer = undefined;
    }
  }

  /**
   * Handle incoming transport messages
   */
  handleMessage(message: Message): void {
    if (!this.context) {
      return;
    }

    try {
      const clusterMessage = message.data as any;
      
      // Verify message signature if present
      if (this.hasSignature(clusterMessage)) {
        if (!this.context.keyManager.verifyClusterPayload(clusterMessage)) {
          this.emit('communication-error', {
            error: new Error('Invalid signature'),
            operation: 'message-verification',
            sender: message.sender.id
          });
          return;
        }
        
        // Check certificate pinning if enabled
        const signedBy = clusterMessage.signedBy;
        if (signedBy && !this.context.keyManager.verifyPinnedCertificate(message.sender.id, signedBy)) {
          this.emit('communication-error', {
            error: new Error('Certificate pinning failed'),
            operation: 'certificate-verification',
            sender: message.sender.id
          });
          return;
        }
      }
      
      // Record activity for failure detection
      this.context.failureDetector.recordNodeActivity(message.sender.id);
      
      switch (clusterMessage.type) {
        case 'JOIN':
          this.handleJoinMessage(clusterMessage, message.sender.id);
          break;
        case 'GOSSIP':
          this.handleGossipMessage(clusterMessage);
          break;
      }
    } catch (error) {
      this.emit('communication-error', {
        error: error as Error,
        operation: 'message-handling',
        sender: message.sender.id
      });
    }
  }

  /**
   * Handle JOIN messages
   */
  handleJoinMessage(joinMessage: JoinMessage, senderId: string): void {
    if (!this.context || senderId === this.context.localNodeId) {
      return;
    }

    // Update membership with sender info
    const updated = this.context.membership.updateNode(joinMessage.nodeInfo);
    
    if (updated) {
      this.context.addToRecentUpdates(joinMessage.nodeInfo);
    }

    // Handle membership snapshot in response
    if (joinMessage.isResponse && joinMessage.membershipSnapshot) {
      for (const nodeInfo of joinMessage.membershipSnapshot) {
        const snapshotUpdated = this.context.membership.updateNode(nodeInfo);
        if (snapshotUpdated) {
          this.context.addToRecentUpdates(nodeInfo);
        }
      }
    }

    // Send response if this was initial join (not a response)
    if (!joinMessage.isResponse) {
      this.sendJoinResponse(senderId);
    }
  }

  /**
   * Send JOIN response with local info and membership snapshot
   */
  async sendJoinResponse(targetNodeId: string): Promise<void> {
    if (!this.context) {
      return;
    }

    try {
      const localNodeInfo = this.context.getLocalNodeInfo();
      const aliveMembers = this.context.membership.getAliveMembers();
      
      let joinResponse: JoinMessage = {
        type: 'JOIN',
        nodeInfo: localNodeInfo,
        isResponse: true,
        membershipSnapshot: aliveMembers.slice(0, 10) // Limit snapshot size
      };

      // Sign the join response
      joinResponse = this.context.keyManager.signClusterPayload(joinResponse);

      const transportMessage: Message = {
        id: `join-response-${Date.now()}-${Math.random()}`,
        type: MessageType.JOIN,
        data: joinResponse,
        sender: { id: this.context.localNodeId, address: '', port: 0 },
        timestamp: Date.now()
      };

      await this.context.transport.send(transportMessage, { id: targetNodeId, address: '', port: 0 });
    } catch (error) {
      this.emit('communication-error', {
        error: error as Error,
        operation: 'join-response',
        target: targetNodeId
      });
    }
  }

  /**
   * Handle GOSSIP messages
   */
  handleGossipMessage(gossipMessage: GossipMessage): void {
    if (!this.context) {
      return;
    }

    this.emit('gossip-received', gossipMessage);

    // Handle single node info
    if (gossipMessage.nodeInfo) {
      const updated = this.context.membership.updateNode(gossipMessage.nodeInfo);
      if (updated) {
        this.context.addToRecentUpdates(gossipMessage.nodeInfo);
      }
    }

    // Handle membership diff
    if (gossipMessage.membershipDiff) {
      for (const nodeInfo of gossipMessage.membershipDiff) {
        const updated = this.context.membership.updateNode(nodeInfo);
        if (updated) {
          this.context.addToRecentUpdates(nodeInfo);
        }
      }
    }
  }

  /**
   * Send periodic gossip to selected targets
   */
  private async sendPeriodicGossip(aliveMembers: MembershipEntry[]): Promise<void> {
    if (!this.context) {
      return;
    }

    // Don't gossip to ourselves or if no recent updates
    const targets = aliveMembers.filter(member => member.id !== this.context!.localNodeId);
    if (targets.length === 0 || this.context.recentUpdates.length === 0) {
      return;
    }

    // Select gossip targets based on strategy
    const selectedTargets = this.selectGossipTargets(targets, this.config.gossipFanout);
    
    for (const target of selectedTargets) {
      try {
        const gossipMessage: GossipMessage = {
          type: 'GOSSIP',
          membershipDiff: [...this.context.recentUpdates] // Copy recent updates
        };

        const transportMessage: Message = {
          id: `gossip-${Date.now()}-${Math.random()}`,
          type: MessageType.GOSSIP,
          data: gossipMessage,
          sender: { id: this.context.localNodeId, address: '', port: 0 },
          timestamp: Date.now()
        };

        await this.context.transport.send(transportMessage, {
          id: target.id,
          address: target.metadata?.address || '',
          port: target.metadata?.port || 0
        });
      } catch (error) {
        this.emit('communication-error', {
          error: error as Error,
          operation: 'periodic-gossip',
          target: target.id
        });
      }
    }

    // Clear recent updates after gossiping (need to use a method since it's readonly)
    if (this.context.recentUpdates.length > 0) {
      this.context.recentUpdates.splice(0, this.context.recentUpdates.length);
    }
  }

  /**
   * Check if a cluster message has a signature
   */
  private hasSignature(message: any): boolean {
    return message.signature && message.signedBy;
  }

  /**
   * Select gossip targets based on configured strategy
   */
  private selectGossipTargets(nodes: MembershipEntry[], count: number): MembershipEntry[] {
    const strategy = this.gossipTargetSelection.strategy;
    const maxTargets = Math.min(count, this.gossipTargetSelection.maxTargets);
    const minTargets = this.gossipTargetSelection.minTargets;
    
    if (nodes.length <= minTargets) {
      return nodes;
    }

    switch (strategy) {
      case 'random':
        return this.selectRandomTargets(nodes, maxTargets);
      case 'preferential':
        return this.selectPreferentialTargets(nodes, maxTargets);
      case 'zone-aware':
        return this.selectZoneAwareTargets(nodes, maxTargets);
      case 'load-balanced':
        return this.selectLoadBalancedTargets(nodes, maxTargets);
      default:
        return this.selectRandomTargets(nodes, maxTargets);
    }
  }

  /**
   * Select random gossip targets
   */
  private selectRandomTargets(nodes: MembershipEntry[], count: number): MembershipEntry[] {
    const shuffled = [...nodes].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  /**
   * Select preferential gossip targets (prefer newer nodes)
   */
  private selectPreferentialTargets(nodes: MembershipEntry[], count: number): MembershipEntry[] {
    const sorted = [...nodes].sort((a, b) => b.lastSeen - a.lastSeen);
    return sorted.slice(0, count);
  }

  /**
   * Select zone-aware gossip targets
   */
  private selectZoneAwareTargets(nodes: MembershipEntry[], count: number): MembershipEntry[] {
    // For now, fallback to random selection
    // TODO: Implement zone-aware logic when zone information is available
    return this.selectRandomTargets(nodes, count);
  }

  /**
   * Select load-balanced gossip targets
   */
  private selectLoadBalancedTargets(nodes: MembershipEntry[], count: number): MembershipEntry[] {
    // For now, fallback to random selection  
    // TODO: Implement load-based selection when load metrics are available
    return this.selectRandomTargets(nodes, count);
  }

  /**
   * Run anti-entropy cycle to resolve membership inconsistencies
   */
  runAntiEntropyCycle(): void {
    if (!this.context || !this.config.antiEntropy.enabled) {
      return;
    }

    // Force full membership sync with random subset of nodes
    const aliveMembers = this.context.membership.getAliveMembers();
    const targets = this.selectRandomTargets(aliveMembers, Math.min(3, aliveMembers.length));
    
    for (const target of targets) {
      if (target.id !== this.context.localNodeId) {
        this.requestFullMembershipSync(target.id);
      }
    }
  }

  /**
   * Request full membership synchronization from a target node
   */
  private async requestFullMembershipSync(targetNodeId: string): Promise<void> {
    if (!this.context) {
      return;
    }

    try {
      const localNodeInfo = this.context.getLocalNodeInfo();
      const allMembers = this.context.membership.getAllMembers();
      
      const syncMessage: GossipMessage = {
        type: 'GOSSIP',
        membershipDiff: allMembers
        // isFullSync: true // TODO: Add this to GossipMessage type
      };

      const transportMessage: Message = {
        id: `anti-entropy-${Date.now()}-${Math.random()}`,
        type: MessageType.GOSSIP,
        data: syncMessage,
        sender: { id: this.context.localNodeId, address: '', port: 0 },
        timestamp: Date.now()
      };

      await this.context.transport.send(transportMessage, { id: targetNodeId, address: '', port: 0 });
    } catch (error) {
      this.emit('communication-error', {
        error: error as Error,
        operation: 'anti-entropy',
        target: targetNodeId
      });
    }
  }

  /**
   * Get current communication configuration
   */
  getConfig(): CommunicationConfig {
    return { ...this.config };
  }

  /**
   * Update communication configuration
   */
  updateConfig(newConfig: Partial<CommunicationConfig>): void {
    this.config = { ...this.config, ...newConfig };
    
    // Update gossip target selection if fanout changed
    this.gossipTargetSelection.maxTargets = this.config.gossipFanout;
  }

  /**
   * Update gossip target selection strategy
   */
  updateGossipStrategy(selection: Partial<GossipTargetSelection>): void {
    this.gossipTargetSelection = { ...this.gossipTargetSelection, ...selection };
  }

  /**
   * Get gossip timer status
   */
  isGossipTimerRunning(): boolean {
    return this.gossipTimer !== undefined;
  }
}
