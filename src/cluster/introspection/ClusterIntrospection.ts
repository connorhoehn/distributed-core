import { IClusterManagerContext, IRequiresContext } from '../core/IClusterManagerContext';
import { ClusterHealth, ClusterTopology, ClusterMetadata, MembershipEntry } from '../types';

/**
 * ClusterIntrospection provides health monitoring, analytics, and metadata services
 * 
 * Responsibilities:
 * - Cluster health metrics and monitoring
 * - Topology analysis and reporting
 * - Load balancing calculations
 * - Cluster metadata generation
 * - Performance analytics
 */
export class ClusterIntrospection implements IRequiresContext {
  private context?: IClusterManagerContext;

  /**
   * Set the cluster manager context for delegation
   */
  setContext(context: IClusterManagerContext): void {
    this.context = context;
  }

  /**
   * Get cluster health metrics
   */
  getClusterHealth(): ClusterHealth {
    if (!this.context) {
      throw new Error('ClusterIntrospection requires context to be set');
    }

    const members = this.context.membership.getAllMembers();
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
    if (!this.context) {
      throw new Error('ClusterIntrospection requires context to be set');
    }

    const members = this.context.membership.getAliveMembers();
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
  calculateLoadBalance(): number {
    if (!this.context) {
      return 0;
    }

    const members = this.context.membership.getAliveMembers();
    if (members.length <= 1) return 1.0;

    // Simple heuristic: perfect balance would be 1.0
    // For now, return a simplified metric based on node count
    return Math.min(1.0, members.length / 10); // Assume optimal around 10 nodes
  }

  /**
   * Get cluster metadata summary
   */
  getMetadata(): ClusterMetadata {
    if (!this.context) {
      throw new Error('ClusterIntrospection requires context to be set');
    }

    const members = this.context.membership.getAliveMembers();
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
      version: this.getLocalVersion(),
      clusterId: this.generateClusterId(),
      created: Date.now()
    };
  }

  /**
   * Generate a deterministic cluster ID based on membership
   */
  generateClusterId(): string {
    if (!this.context) {
      return 'unknown';
    }

    const sortedNodeIds = this.context.membership.getAliveMembers()
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

  /**
   * Check if cluster can handle node failures
   */
  canHandleFailures(nodeCount: number): boolean {
    if (!this.context) {
      return false;
    }

    const alive = this.context.membership.getAliveMembers().length;
    return alive > nodeCount && alive - nodeCount >= Math.ceil(alive * 0.5);
  }

  /**
   * Get local node version (for metadata)
   */
  private getLocalVersion(): number {
    if (!this.context) {
      return 0;
    }

    const localNode = this.context.getLocalNodeInfo();
    return localNode.version || 0;
  }

  /**
   * Analyze cluster performance metrics
   */
  getPerformanceMetrics(): {
    membershipSize: number;
    gossipRate: number;
    failureDetectionLatency: number;
    averageHeartbeatInterval: number;
  } {
    if (!this.context) {
      throw new Error('ClusterIntrospection requires context to be set');
    }

    // TODO: Implement actual metrics collection
    // For now, return placeholder values
    return {
      membershipSize: this.context.membership.getAllMembers().length,
      gossipRate: 1.0, // gossips per second
      failureDetectionLatency: 3000, // ms
      averageHeartbeatInterval: 1000 // ms
    };
  }

  /**
   * Get cluster stability metrics
   */
  getStabilityMetrics(): {
    churnRate: number;
    partitionCount: number;
    averageUptime: number;
    membershipStability: number;
  } {
    if (!this.context) {
      throw new Error('ClusterIntrospection requires context to be set');
    }

    // TODO: Implement actual stability tracking
    // For now, return placeholder values
    return {
      churnRate: 0.1, // nodes joining/leaving per minute
      partitionCount: 0,
      averageUptime: 86400000, // 24 hours in ms
      membershipStability: 0.95 // percentage
    };
  }
}
