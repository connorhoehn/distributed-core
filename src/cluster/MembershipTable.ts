import { NodeId, NodeInfo, NodeStatus } from '../types';

export class MembershipTable {
  private members = new Map<string, NodeInfo>();

  addMember(nodeInfo: NodeInfo): void {
    this.members.set(nodeInfo.id.id, nodeInfo);
  }

  removeMember(nodeId: string): void {
    this.members.delete(nodeId);
  }

  getMember(nodeId: string): NodeInfo | undefined {
    return this.members.get(nodeId);
  }

  getAllMembers(): NodeInfo[] {
    return Array.from(this.members.values());
  }

  getAliveMembers(): NodeInfo[] {
    return this.getAllMembers().filter(m => m.status === NodeStatus.ALIVE);
  }

  size(): number {
    return this.members.size;
  }

  clear(): void {
    this.members.clear();
  }
}
