import { EventEmitter } from 'events';
import { NodeInfo, MembershipEntry, NodeStatus } from '../types';

export class MembershipTable extends EventEmitter {
  private members = new Map<string, MembershipEntry>();
  private version = 0;

  constructor(private localNodeId: string) {
    super();
  }

  /**
   * Update membership using version/incarnation rules
   */
  updateNode(nodeInfo: NodeInfo): boolean {
    // Don't update self via external messages
    if (nodeInfo.id === this.localNodeId) {
      return false;
    }

    const existing = this.members.get(nodeInfo.id);
    const now = Date.now();

    // New node
    if (!existing) {
      const entry: MembershipEntry = {
        ...nodeInfo,
        lastUpdated: now
      };
      this.members.set(nodeInfo.id, entry);
      this.version++;
      this.emit('member-joined', nodeInfo);
      this.emit('membership-updated', new Map(this.members));
      return true;
    }

    // Version comparison rules
    if (nodeInfo.version > existing.version) {
      // Higher version - replace completely
      const entry: MembershipEntry = {
        ...nodeInfo,
        lastUpdated: now
      };
      this.members.set(nodeInfo.id, entry);
      this.version++;
      this.emit('member-updated', nodeInfo);
      this.emit('membership-updated', new Map(this.members));
      return true;
    } else if (nodeInfo.version === existing.version) {
      // Same version - update if newer timestamp
      if (nodeInfo.lastSeen > existing.lastSeen) {
        const entry: MembershipEntry = {
          ...existing,
          ...nodeInfo,
          lastUpdated: now
        };
        this.members.set(nodeInfo.id, entry);
        this.version++;
        this.emit('member-updated', nodeInfo);
        this.emit('membership-updated', new Map(this.members));
        return true;
      }
    }
    // Lower version or older timestamp - ignore
    return false;
  }

  /**
   * Generic entry point for adding any node (local or peer)
   * Automatically determines the appropriate method based on node ID
   */
  addNode(nodeInfo: NodeInfo): boolean {
    if (nodeInfo.id === this.localNodeId) {
      this.addLocalNode(nodeInfo);
      return true;
    } else {
      return this.updateNode(nodeInfo);
    }
  }

  /**
   * Add local node to membership
   */
  addLocalNode(nodeInfo: NodeInfo): void {
    const entry: MembershipEntry = {
      ...nodeInfo,
      lastUpdated: Date.now()
    };
    this.members.set(nodeInfo.id, entry);
    this.version++;
  }

  /**
   * Generic add member method (useful for testing)
   * Bypasses local node restrictions and version checks
   */
  addMember(nodeInfo: NodeInfo): void {
    const entry: MembershipEntry = {
      ...nodeInfo,
      lastUpdated: Date.now()
    };
    this.members.set(nodeInfo.id, entry);
    this.version++;
    this.emit('member-joined', nodeInfo);
    this.emit('membership-updated', new Map(this.members));
  }

  /**
   * Get all alive members
   */
  getAliveMembers(): MembershipEntry[] {
    return Array.from(this.members.values())
      .filter(member => member.status === 'ALIVE');
  }

  /**
   * Get all members
   */
  getAllMembers(): MembershipEntry[] {
    return Array.from(this.members.values());
  }

  /**
   * Get specific member
   */
  getMember(nodeId: string): MembershipEntry | undefined {
    return this.members.get(nodeId);
  }

  /**
   * Remove member (useful for testing)
   */
  removeMember(nodeId: string): boolean {
    const existed = this.members.has(nodeId);
    if (existed) {
      this.members.delete(nodeId);
      this.version++;
      this.emit('member-left', nodeId);
      this.emit('membership-updated', new Map(this.members));
    }
    return existed;
  }

  /**
   * Generic entry point for removing any node (local or peer)
   * Automatically determines the appropriate method based on node ID
   */
  removeNode(nodeId: string): boolean {
    if (nodeId === this.localNodeId) {
      // For local node, we might want to mark as leaving instead of removing
      return this.markLeaving(nodeId);
    } else {
      // For peer nodes, mark as dead (standard gossip protocol)
      return this.markDead(nodeId);
    }
  }

  /**
   * Mark node as leaving (graceful departure)
   */
  markLeaving(nodeId: string): boolean {
    const member = this.members.get(nodeId);
    if (!member) {
      return false;
    }

    member.status = 'DEAD';
    member.lastUpdated = Date.now();
    this.version++;
    
    this.emit('member-updated', member);
    this.emit('membership-updated', new Map(this.members));
    return true;
  }

  /**
   * Mark node as suspect
   */
  markSuspect(nodeId: string, timeout: number = 5000): boolean {
    const member = this.members.get(nodeId);
    if (!member || member.status !== 'ALIVE') {
      return false;
    }

    member.status = 'SUSPECT';
    member.suspectTimeout = Date.now() + timeout;
    member.lastUpdated = Date.now();
    this.version++;
    
    this.emit('member-updated', member);
    this.emit('membership-updated', new Map(this.members));
    return true;
  }

  /**
   * Mark node as dead
   */
  markDead(nodeId: string): boolean {
    const member = this.members.get(nodeId);
    if (!member) {
      return false;
    }

    member.status = 'DEAD';
    member.lastUpdated = Date.now();
    this.version++;
    
    this.emit('member-left', nodeId);
    this.emit('membership-updated', new Map(this.members));
    return true;
  }

  /**
   * Remove dead nodes older than threshold
   */
  pruneDeadNodes(maxAge: number = 30000): number {
    const now = Date.now();
    let pruned = 0;

    for (const [nodeId, member] of this.members) {
      if (member.status === 'DEAD' && (now - member.lastUpdated) > maxAge) {
        this.members.delete(nodeId);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.version++;
      this.emit('membership-updated', new Map(this.members));
    }

    return pruned;
  }

  /**
   * Get membership table version
   */
  getVersion(): number {
    return this.version;
  }

  /**
   * Get membership size
   */
  size(): number {
    return this.members.size;
  }

  /**
   * Clear all members
   */
  clear(): void {
    this.members.clear();
    this.version = 0;
    this.emit('membership-updated', new Map(this.members));
  }
}
