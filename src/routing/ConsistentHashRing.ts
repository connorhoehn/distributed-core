import { MembershipEntry } from "../cluster/types";

export interface VirtualNode {
  nodeId: string;
  hash: number;
  replica: number;
}

export class ConsistentHashRing {
  private ring: VirtualNode[] = [];
  private virtualNodesPerNode: number;

  constructor(virtualNodesPerNode: number = 100) {
    this.virtualNodesPerNode = virtualNodesPerNode;
  }

  /**
   * Add node to the hash ring with virtual nodes
   */
  addNode(nodeId: string): void {
    for (let i = 0; i < this.virtualNodesPerNode; i++) {
      const virtualNodeKey = `${nodeId}:${i}`;
      const hash = this.hash(virtualNodeKey);
      
      this.ring.push({
        nodeId,
        hash,
        replica: i
      });
    }
    
    // Keep ring sorted by hash
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  /**
   * Remove node from the hash ring
   */
  removeNode(nodeId: string): void {
    this.ring = this.ring.filter(vnode => vnode.nodeId !== nodeId);
  }

  /**
   * Find the node responsible for a given key
   */
  getNode(key: string): string | null {
    if (this.ring.length === 0) {
      return null;
    }

    const keyHash = this.hash(key);
    
    // Find first node with hash >= keyHash
    for (const vnode of this.ring) {
      if (vnode.hash >= keyHash) {
        return vnode.nodeId;
      }
    }
    
    // Wrap around to first node
    return this.ring[0].nodeId;
  }

  /**
   * Get N nodes responsible for a key (for replication)
   */
  getNodes(key: string, count: number): string[] {
    if (this.ring.length === 0 || count <= 0) {
      return [];
    }

    const keyHash = this.hash(key);
    const result: string[] = [];
    const seen = new Set<string>();
    
    // Find starting position
    let startIndex = 0;
    for (let i = 0; i < this.ring.length; i++) {
      if (this.ring[i].hash >= keyHash) {
        startIndex = i;
        break;
      }
    }

    // Collect unique nodes
    for (let i = 0; i < this.ring.length && result.length < count; i++) {
      const index = (startIndex + i) % this.ring.length;
      const nodeId = this.ring[index].nodeId;
      
      if (!seen.has(nodeId)) {
        seen.add(nodeId);
        result.push(nodeId);
      }
    }

    return result;
  }

  /**
   * Rebuild ring from membership table
   */
  rebuild(members: MembershipEntry[]): void {
    this.ring = [];
    
    for (const member of members) {
      if (member.status === 'ALIVE') {
        this.addNode(member.id);
      }
    }
  }

  /**
   * Get all nodes in the ring
   */
  getAllNodes(): string[] {
    const uniqueNodes = new Set(this.ring.map(vnode => vnode.nodeId));
    return Array.from(uniqueNodes);
  }

  /**
   * Get ring statistics
   */
  getStats(): { totalVirtualNodes: number; uniqueNodes: number; averageVirtualNodes: number } {
    const uniqueNodes = new Set(this.ring.map(vnode => vnode.nodeId));
    return {
      totalVirtualNodes: this.ring.length,
      uniqueNodes: uniqueNodes.size,
      averageVirtualNodes: uniqueNodes.size > 0 ? this.ring.length / uniqueNodes.size : 0
    };
  }

  /**
   * Better hash function for consistent hashing (using crypto for better distribution)
   */
  private hash(key: string): number {
    // Use Node.js crypto for better hash distribution
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(key).digest('hex');
    
    // Convert first 8 hex chars to a 32-bit integer
    const hashValue = parseInt(hash.substring(0, 8), 16);
    return Math.abs(hashValue);
  }
}
