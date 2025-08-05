import { Transport } from '../transport/Transport';
import { MembershipEntry, GossipMessage, NodeInfo } from '../cluster/types';
import { Message, MessageType } from '../types';

export class GossipStrategy {
  constructor(
    private localNodeId: string,
    private transport: Transport,
    private gossipInterval: number = 1000,
    private enableLogging: boolean = false
  ) {}

  /**
   * Send gossip message to target nodes
   */
  async sendGossip(targets: MembershipEntry[], data: NodeInfo | NodeInfo[]): Promise<void> {
    const gossipData: GossipMessage = {
      type: 'GOSSIP',
      ...(Array.isArray(data) 
        ? { membershipDiff: data }
        : { nodeInfo: data }
      )
    };

    const transportMessage: Message = {
      id: `gossip-${Date.now()}-${Math.random()}`,
      type: MessageType.GOSSIP,
      data: gossipData,
      sender: { id: this.localNodeId, address: '', port: 0 },
      timestamp: Date.now()
    };

    const promises = targets.map(async target => {
      try {
        await this.transport.send(transportMessage, { 
          id: target.id, 
          address: target.metadata?.address || '', 
          port: target.metadata?.port || 0 
        });
      } catch (error) {
        // Silently fail for unreachable nodes
        if (this.enableLogging) {
          console.debug(`Failed to gossip to ${target.id}:`, error);
        }
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Select random subset of alive nodes for gossip
   */
  selectGossipTargets(allNodes: MembershipEntry[], count: number = 3): MembershipEntry[] {
    const availableNodes = allNodes.filter(node => 
      node.id !== this.localNodeId && 
      node.status === 'ALIVE'
    );
    
    const shuffled = [...availableNodes].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }

  /**
   * Send periodic gossip with membership updates
   */
  async sendPeriodicGossip(
    membership: MembershipEntry[], 
    recentUpdates: NodeInfo[]
  ): Promise<void> {
    const targets = this.selectGossipTargets(membership);
    
    if (targets.length === 0) {
      return;
    }

    // Send recent updates if any, otherwise send random member info
    const gossipData = recentUpdates.length > 0 
      ? recentUpdates 
      : this.selectRandomMemberInfo(membership);

    await this.sendGossip(targets, gossipData);
  }

  /**
   * Select random member info for gossip
   */
  private selectRandomMemberInfo(membership: MembershipEntry[]): NodeInfo {
    const aliveMembers = membership.filter(m => m.status === 'ALIVE');
    if (aliveMembers.length === 0) {
      throw new Error('No alive members to gossip about');
    }
    
    const randomIndex = Math.floor(Math.random() * aliveMembers.length);
    const selected = aliveMembers[randomIndex];
    
    return {
      id: selected.id,
      status: selected.status,
      lastSeen: selected.lastSeen,
      version: selected.version,
      metadata: selected.metadata
    };
  }
}
