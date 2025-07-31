import { IClusterManagerContext, IRequiresContext } from '../core/IClusterManagerContext';
import { QuorumOptions, PartitionInfo, MembershipEntry } from '../types';

/**
 * ClusterQuorum provides quorum management and partition detection services
 * 
 * Responsibilities:
 * - Quorum validation and calculation
 * - Partition detection and analysis
 * - Cluster stability assessment
 * - Failure tolerance analysis
 */
export class ClusterQuorum implements IRequiresContext {
  private context?: IClusterManagerContext;

  /**
   * Set the cluster manager context for delegation
   */
  setContext(context: IClusterManagerContext): void {
    this.context = context;
  }

  /**
   * Check if cluster has quorum based on specified options
   */
  hasQuorum(opts: QuorumOptions): boolean {
    if (!this.context) {
      throw new Error('ClusterQuorum requires context to be set');
    }

    const aliveMembers = this.context.membership.getAliveMembers();
    
    // Check minimum node count
    if (opts.minNodeCount && aliveMembers.length < opts.minNodeCount) {
      return false;
    }

    // Check service-specific quorum
    if (opts.service) {
      const serviceMembers = aliveMembers.filter(member => 
        member.metadata?.role === opts.service || 
        member.metadata?.tags?.service === opts.service
      );
      
      if (serviceMembers.length < Math.ceil(aliveMembers.length / 2)) {
        return false;
      }
    }

    // Check region distribution if required
    if (opts.requiredRegionCount) {
      const regions = new Set(
        aliveMembers
          .map(member => member.metadata?.region)
          .filter(region => region !== undefined)
      );
      
      if (regions.size < opts.requiredRegionCount) {
        return false;
      }
    }

    // Default majority quorum
    const totalMembers = this.context.membership.getAllMembers().length;
    const requiredForQuorum = Math.ceil(totalMembers / 2);
    
    return aliveMembers.length >= requiredForQuorum;
  }

  /**
   * Detect potential network partitions based on membership views
   */
  detectPartition(): PartitionInfo | null {
    if (!this.context) {
      throw new Error('ClusterQuorum requires context to be set');
    }

    const aliveMembers = this.context.membership.getAliveMembers();
    const totalMembers = this.context.membership.getAllMembers().length;
    
    // If we have less than majority, we might be in a partition
    if (aliveMembers.length < Math.ceil(totalMembers / 2)) {
      return {
        isPartitioned: true,
        visibleNodes: aliveMembers.length,
        totalNodes: totalMembers,
        partitionRatio: aliveMembers.length / totalMembers,
        timestamp: Date.now()
      };
    }

    // Check for zone-based partitions
    const zones = new Map<string, number>();
    aliveMembers.forEach(member => {
      const zone = member.metadata?.zone || 'unknown';
      zones.set(zone, (zones.get(zone) || 0) + 1);
    });

    // If all visible nodes are in same zone, might be partition
    if (zones.size === 1 && totalMembers > aliveMembers.length) {
      return {
        isPartitioned: true,
        visibleNodes: aliveMembers.length,
        totalNodes: totalMembers,
        partitionRatio: aliveMembers.length / totalMembers,
        timestamp: Date.now(),
        partitionType: 'zone-based'
      };
    }

    return null;
  }

  /**
   * Check if cluster can handle node failures
   */
  canHandleFailures(nodeCount: number): boolean {
    if (!this.context) {
      throw new Error('ClusterQuorum requires context to be set');
    }

    const alive = this.context.membership.getAliveMembers().length;
    return alive > nodeCount && alive - nodeCount >= Math.ceil(alive * 0.5);
  }

  /**
   * Calculate required quorum size for current cluster
   */
  getRequiredQuorumSize(): number {
    if (!this.context) {
      throw new Error('ClusterQuorum requires context to be set');
    }

    const totalMembers = this.context.membership.getAllMembers().length;
    return Math.ceil(totalMembers / 2);
  }

  /**
   * Get current quorum status
   */
  getQuorumStatus(): {
    hasQuorum: boolean;
    aliveNodes: number;
    requiredNodes: number;
    healthRatio: number;
    partitionInfo: PartitionInfo | null;
  } {
    if (!this.context) {
      throw new Error('ClusterQuorum requires context to be set');
    }

    const aliveMembers = this.context.membership.getAliveMembers();
    const totalMembers = this.context.membership.getAllMembers().length;
    const requiredQuorum = this.getRequiredQuorumSize();
    const hasQuorum = aliveMembers.length >= requiredQuorum;
    const partitionInfo = this.detectPartition();

    return {
      hasQuorum,
      aliveNodes: aliveMembers.length,
      requiredNodes: requiredQuorum,
      healthRatio: totalMembers > 0 ? aliveMembers.length / totalMembers : 0,
      partitionInfo
    };
  }

  /**
   * Validate quorum for specific operations
   */
  validateOperationQuorum(operation: string, requiredNodes?: number): {
    canProceed: boolean;
    reason?: string;
    availableNodes: number;
    requiredNodes: number;
  } {
    if (!this.context) {
      throw new Error('ClusterQuorum requires context to be set');
    }

    const aliveMembers = this.context.membership.getAliveMembers();
    const required = requiredNodes || this.getRequiredQuorumSize();

    if (aliveMembers.length < required) {
      return {
        canProceed: false,
        reason: `Insufficient nodes for ${operation}: need ${required}, have ${aliveMembers.length}`,
        availableNodes: aliveMembers.length,
        requiredNodes: required
      };
    }

    // Check for partitions that might affect operation
    const partitionInfo = this.detectPartition();
    if (partitionInfo?.isPartitioned) {
      return {
        canProceed: false,
        reason: `Network partition detected: operation ${operation} not safe`,
        availableNodes: aliveMembers.length,
        requiredNodes: required
      };
    }

    return {
      canProceed: true,
      availableNodes: aliveMembers.length,
      requiredNodes: required
    };
  }

  /**
   * Get zone distribution analysis
   */
  getZoneDistribution(): {
    zones: Map<string, number>;
    isBalanced: boolean;
    recommendedRebalance: boolean;
  } {
    if (!this.context) {
      throw new Error('ClusterQuorum requires context to be set');
    }

    const aliveMembers = this.context.membership.getAliveMembers();
    const zones = new Map<string, number>();

    aliveMembers.forEach(member => {
      const zone = member.metadata?.zone || 'unknown';
      zones.set(zone, (zones.get(zone) || 0) + 1);
    });

    // Simple balance check: no zone should have > 60% of nodes
    const maxNodesInZone = Math.max(...zones.values());
    const isBalanced = maxNodesInZone <= Math.ceil(aliveMembers.length * 0.6);
    const recommendedRebalance = maxNodesInZone > Math.ceil(aliveMembers.length * 0.7);

    return {
      zones,
      isBalanced,
      recommendedRebalance
    };
  }
}
