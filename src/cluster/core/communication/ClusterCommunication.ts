import { EventEmitter } from 'events';
import { IClusterCommunication, CommunicationConfig, GossipTargetSelection } from './types';
import { IClusterManagerContext, IRequiresContext } from '../IClusterManagerContext';
import { JoinMessage, GossipMessage, NodeInfo, MembershipEntry } from '../../types';
import { Message, MessageType } from '../../../types';

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

    // TODO: Need to expose getSeedNodes on context
    // const seedNodes = this.context.config.getSeedNodes();
    
    // For now, this is a stub that emits the appropriate events
    this.emit('join-requested', { nodeId: 'seed-node', isResponse: false });
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
        
        // TODO: Need to expose logging configuration on context
        // if (this.context.config.enableLogging) {
        //   console.debug('Error during periodic gossip:', error);
        // }
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
   * Handle incoming gossip messages
   */
  handleGossipMessage(gossipMessage: GossipMessage): void {
    if (!this.context) {
      throw new Error('ClusterCommunication requires context to be set');
    }

    this.emit('gossip-received', { 
      senderId: 'unknown', // Will be populated by message handler
      updates: gossipMessage.membershipDiff || []
    });

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
   * Handle incoming join messages
   */
  handleJoinMessage(joinMessage: JoinMessage, senderId: string): void {
    if (!this.context) {
      throw new Error('ClusterCommunication requires context to be set');
    }

    // Update membership with sender info
    if (senderId !== this.context.localNodeId) {
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

      this.emit('join-requested', { nodeId: senderId, isResponse: joinMessage.isResponse });
    }
  }

  /**
   * Send join response to a requesting node
   */
  async sendJoinResponse(targetNodeId: string): Promise<void> {
    if (!this.context) {
      throw new Error('ClusterCommunication requires context to be set');
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

      // TODO: Need to expose key manager signing on context
      // joinResponse = this.context.keyManager.signClusterPayload(joinResponse);

      const transportMessage: Message = {
        id: `join-response-${Date.now()}-${Math.random()}`,
        type: MessageType.JOIN,
        data: joinResponse,
        sender: { id: this.context.localNodeId, address: '', port: 0 },
        timestamp: Date.now()
      };

      await this.context.transport.send(transportMessage, { id: targetNodeId, address: '', port: 0 });
      
      this.emit('join-completed', { 
        nodeId: targetNodeId, 
        membershipSize: aliveMembers.length 
      });
    } catch (error) {
      this.emit('communication-error', { 
        error: error as Error, 
        operation: 'join-response', 
        targetNode: targetNodeId 
      });
      
      // TODO: Need to expose logging configuration on context
      // if (this.context.config.enableLogging) {
      //   console.debug(`Failed to send join response to ${targetNodeId}:`, error);
      // }
    }
  }

  /**
   * Trigger anti-entropy synchronization cycle
   */
  runAntiEntropyCycle(): void {
    if (!this.context) {
      throw new Error('ClusterCommunication requires context to be set');
    }

    if (!this.config.antiEntropy.enabled) {
      return;
    }

    const aliveMembers = this.context.membership.getAliveMembers();
    if (aliveMembers.length <= 1) {
      return; // No other nodes to sync with
    }

    // TODO: Need to expose logging configuration on context
    // if (this.context.config.enableLogging) {
    //   console.log(`[ClusterCommunication] Running anti-entropy cycle with ${aliveMembers.length} members`);
    // }

    // Force immediate gossip to all members (not just random subset)
    this.sendPeriodicGossip(aliveMembers, true);
    
    // Increment local version to trigger updates
    this.context.incrementVersion();
    
    this.emit('anti-entropy-triggered', {
      timestamp: Date.now(),
      memberCount: aliveMembers.length
    });
  }

  /**
   * Send periodic gossip to selected targets
   */
  private async sendPeriodicGossip(
    membership: MembershipEntry[], 
    forceAll: boolean = false
  ): Promise<void> {
    if (!this.context) {
      return;
    }

    const targets = forceAll 
      ? membership.filter(m => m.id !== this.context!.localNodeId)
      : this.selectGossipTargets(membership);
    
    if (targets.length === 0) {
      return;
    }

    const recentUpdates = this.context.recentUpdates;
    const gossipPromises = targets.map(async (target) => {
      try {
        await this.context!.gossipStrategy.sendPeriodicGossip(membership, recentUpdates);
      } catch (error) {
        this.emit('communication-error', { 
          error: error as Error, 
          operation: 'gossip', 
          targetNode: target.id 
        });
      }
    });

    await Promise.allSettled(gossipPromises);
    
    // TODO: Need a way to clear recent updates through context
    // Clear recent updates after sending
    // this.context.recentUpdates = [];

    this.emit('gossip-sent', { 
      targetNodes: targets.map(t => t.id), 
      messageCount: recentUpdates.length 
    });
  }

  /**
   * Select gossip targets based on configured strategy
   */
  private selectGossipTargets(allNodes: MembershipEntry[]): MembershipEntry[] {
    if (!this.context) {
      return [];
    }

    const availableNodes = allNodes.filter(node => 
      node.id !== this.context!.localNodeId && 
      node.status === 'ALIVE'
    );

    const targetCount = Math.min(
      this.gossipTargetSelection.maxTargets,
      Math.max(this.gossipTargetSelection.minTargets, availableNodes.length)
    );

    switch (this.gossipTargetSelection.strategy) {
      case 'random':
        return this.selectRandomTargets(availableNodes, targetCount);
      case 'preferential':
        return this.selectPreferentialTargets(availableNodes, targetCount);
      case 'zone-aware':
        return this.selectZoneAwareTargets(availableNodes, targetCount);
      case 'load-balanced':
        return this.selectLoadBalancedTargets(availableNodes, targetCount);
      default:
        return this.selectRandomTargets(availableNodes, targetCount);
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
