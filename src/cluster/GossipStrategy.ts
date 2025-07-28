import { NodeId, Message, MessageType } from '../types';
import { Transport } from '../transport/Transport';

export class GossipStrategy {
  constructor(
    private nodeId: NodeId,
    private transport: Transport,
    private gossipInterval: number = 1000
  ) {}

  async sendGossip(targets: NodeId[], data: any): Promise<void> {
    const gossipMessage: Message = {
      id: `gossip-${Date.now()}`,
      type: MessageType.GOSSIP,
      data,
      sender: this.nodeId,
      timestamp: Date.now()
    };

    const promises = targets.map(target => 
      this.transport.send(gossipMessage, target).catch(() => {
        // Silently fail for unreachable nodes
      })
    );

    await Promise.allSettled(promises);
  }

  selectGossipTargets(allNodes: NodeId[], count: number = 3): NodeId[] {
    const availableNodes = allNodes.filter(node => node.id !== this.nodeId.id);
    const shuffled = [...availableNodes].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }
}
