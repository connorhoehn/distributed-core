import { MembershipEntry } from '../types';
import { QuorumStrategy, QuorumResult, ZoneQuorumOptions } from './types';

/**
 * Zone-aware quorum strategy that ensures quorum distribution
 * across availability zones for geographic fault tolerance
 */
export class ZoneQuorumStrategy implements QuorumStrategy {
  name = 'zone-aware';

  evaluate(members: MembershipEntry[], options: ZoneQuorumOptions): QuorumResult {
    const aliveMembers = members.filter(m => m.status === 'ALIVE');
    
    // Group members by zone
    const zoneGroups = this.groupMembersByZone(aliveMembers);
    
    // Evaluate zone distribution
    const zoneEvaluation = this.evaluateZoneDistribution(zoneGroups, options);
    
    // Check fault tolerance
    const faultToleranceCheck = this.checkFaultTolerance(zoneGroups, options);
    
    const hasQuorum = zoneEvaluation.hasRequiredZones && 
                     zoneEvaluation.hasMinNodesPerZone &&
                     faultToleranceCheck.canTolerateFailures;
    
    return {
      hasQuorum,
      requiredCount: options.requiredZones * options.minNodesPerZone,
      currentCount: aliveMembers.length,
      strategy: this.name,
      metadata: {
        zoneDistribution: zoneEvaluation.distribution,
        activeZones: zoneEvaluation.activeZones,
        requiredZones: options.requiredZones,
        faultTolerance: faultToleranceCheck,
        crossZoneReplication: options.crossZoneReplication,
        preferredZones: options.preferredZones,
        details: this.getZoneDetails(zoneGroups, options)
      }
    };
  }

  private groupMembersByZone(members: MembershipEntry[]): Map<string, MembershipEntry[]> {
    const zoneGroups = new Map<string, MembershipEntry[]>();
    
    members.forEach(member => {
      const zone = member.metadata?.zone || 'unknown';
      if (!zoneGroups.has(zone)) {
        zoneGroups.set(zone, []);
      }
      zoneGroups.get(zone)!.push(member);
    });
    
    return zoneGroups;
  }

  private evaluateZoneDistribution(
    zoneGroups: Map<string, MembershipEntry[]>, 
    options: ZoneQuorumOptions
  ) {
    const distribution: Record<string, number> = {};
    const validZones: string[] = [];
    
    for (const [zoneName, members] of zoneGroups) {
      distribution[zoneName] = members.length;
      
      if (members.length >= options.minNodesPerZone) {
        validZones.push(zoneName);
      }
    }
    
    const hasRequiredZones = validZones.length >= options.requiredZones;
    const hasMinNodesPerZone = validZones.every(zone => 
      (zoneGroups.get(zone)?.length || 0) >= options.minNodesPerZone
    );
    
    return {
      distribution,
      activeZones: validZones.length,
      hasRequiredZones,
      hasMinNodesPerZone,
      validZones
    };
  }

  private checkFaultTolerance(
    zoneGroups: Map<string, MembershipEntry[]>, 
    options: ZoneQuorumOptions
  ) {
    const totalZones = zoneGroups.size;
    const maxZoneFailures = options.faultTolerance.maxZoneFailures;
    
    // Check if we can lose maxZoneFailures zones and still have quorum
    const zonesAfterFailures = totalZones - maxZoneFailures;
    const canTolerateFailures = zonesAfterFailures >= options.requiredZones;
    
    // Calculate minimum nodes after zone failures
    const sortedZoneSizes = Array.from(zoneGroups.values())
      .map(members => members.length)
      .sort((a, b) => b - a); // Sort descending
    
    // Assume we lose the smallest zones (worst case)
    const remainingNodes = sortedZoneSizes
      .slice(0, zonesAfterFailures)
      .reduce((sum, size) => sum + size, 0);
    
    const minNodesAfterFailures = zonesAfterFailures * options.minNodesPerZone;
    const hasEnoughNodesAfterFailures = remainingNodes >= minNodesAfterFailures;
    
    return {
      canTolerateFailures: canTolerateFailures && hasEnoughNodesAfterFailures,
      zonesAfterFailures,
      remainingNodes,
      minNodesRequired: minNodesAfterFailures,
      gracefulDegradation: options.faultTolerance.gracefulDegradation
    };
  }

  private getZoneDetails(
    zoneGroups: Map<string, MembershipEntry[]>, 
    options: ZoneQuorumOptions
  ) {
    const details: Record<string, any> = {};
    
    for (const [zoneName, members] of zoneGroups) {
      const isPreferred = options.preferredZones?.includes(zoneName) || false;
      const meetsMinimum = members.length >= options.minNodesPerZone;
      
      details[zoneName] = {
        nodes: members.map(m => m.id),
        count: members.length,
        isPreferred,
        meetsMinimum,
        replicationCapable: options.crossZoneReplication && meetsMinimum
      };
    }
    
    return details;
  }

  /**
   * Check if cluster can handle specific zone failures
   */
  canHandleZoneFailures(
    members: MembershipEntry[], 
    options: ZoneQuorumOptions,
    failedZones: string[]
  ): boolean {
    const aliveMembers = members.filter(m => m.status === 'ALIVE');
    const remainingMembers = aliveMembers.filter(m => 
      !failedZones.includes(m.metadata?.zone || 'unknown')
    );
    
    const remainingZoneGroups = this.groupMembersByZone(remainingMembers);
    const evaluation = this.evaluateZoneDistribution(remainingZoneGroups, options);
    
    return evaluation.hasRequiredZones && evaluation.hasMinNodesPerZone;
  }

  /**
   * Get optimal zone distribution for given cluster size
   */
  getOptimalZoneDistribution(
    targetClusterSize: number, 
    availableZones: string[], 
    options: ZoneQuorumOptions
  ): Record<string, number> {
    const distribution: Record<string, number> = {};
    
    // Prioritize preferred zones if specified
    const zonePriority = options.preferredZones || availableZones;
    const zonesNeeded = Math.min(options.requiredZones, availableZones.length);
    
    // First, allocate minimum nodes to each required zone
    const minNodesTotal = zonesNeeded * options.minNodesPerZone;
    let remainingNodes = targetClusterSize - minNodesTotal;
    
    // Initialize with minimum allocation
    for (let i = 0; i < zonesNeeded; i++) {
      const zoneName = zonePriority[i] || availableZones[i];
      distribution[zoneName] = options.minNodesPerZone;
    }
    
    // Distribute remaining nodes evenly
    while (remainingNodes > 0 && zonesNeeded > 0) {
      for (let i = 0; i < zonesNeeded && remainingNodes > 0; i++) {
        const zoneName = zonePriority[i] || availableZones[i];
        distribution[zoneName]++;
        remainingNodes--;
      }
    }
    
    return distribution;
  }

  /**
   * Recommend zone configuration for optimal fault tolerance
   */
  recommendZoneConfiguration(
    currentZones: string[], 
    targetReliability: 'basic' | 'high' | 'extreme'
  ): ZoneQuorumOptions {
    const zoneCount = currentZones.length;
    
    switch (targetReliability) {
      case 'basic':
        return {
          requiredZones: Math.min(2, zoneCount),
          minNodesPerZone: 1,
          crossZoneReplication: true,
          faultTolerance: {
            maxZoneFailures: 1,
            gracefulDegradation: true
          }
        };
        
      case 'high':
        return {
          requiredZones: Math.min(3, zoneCount),
          minNodesPerZone: 2,
          preferredZones: currentZones.slice(0, 3),
          crossZoneReplication: true,
          faultTolerance: {
            maxZoneFailures: 1,
            gracefulDegradation: true
          }
        };
        
      case 'extreme':
        return {
          requiredZones: Math.min(5, zoneCount),
          minNodesPerZone: 3,
          preferredZones: currentZones.slice(0, 5),
          crossZoneReplication: true,
          faultTolerance: {
            maxZoneFailures: 2,
            gracefulDegradation: false
          }
        };
        
      default:
        throw new Error(`Unsupported reliability level: ${targetReliability}`);
    }
  }

  /**
   * Analyze zone balance and suggest rebalancing
   */
  analyzeZoneBalance(members: MembershipEntry[]): {
    isBalanced: boolean;
    imbalanceScore: number;
    recommendations: string[];
  } {
    const aliveMembers = members.filter(m => m.status === 'ALIVE');
    const zoneGroups = this.groupMembersByZone(aliveMembers);
    const zoneSizes = Array.from(zoneGroups.values()).map(members => members.length);
    
    if (zoneSizes.length === 0) {
      return {
        isBalanced: false,
        imbalanceScore: 1,
        recommendations: ['No active zones detected']
      };
    }
    
    const maxSize = Math.max(...zoneSizes);
    const minSize = Math.min(...zoneSizes);
    const avgSize = zoneSizes.reduce((sum, size) => sum + size, 0) / zoneSizes.length;
    
    // Calculate imbalance score (0 = perfectly balanced, 1 = maximally imbalanced)
    const imbalanceScore = maxSize > 0 ? (maxSize - minSize) / maxSize : 0;
    const isBalanced = imbalanceScore <= 0.3; // Within 30% is considered balanced
    
    const recommendations: string[] = [];
    
    if (!isBalanced) {
      recommendations.push(`Zone imbalance detected: max=${maxSize}, min=${minSize}, avg=${avgSize.toFixed(1)}`);
      
      if (maxSize > avgSize * 1.5) {
        recommendations.push('Consider moving nodes from over-populated zones');
      }
      
      if (minSize < avgSize * 0.5) {
        recommendations.push('Consider adding nodes to under-populated zones');
      }
    }
    
    return {
      isBalanced,
      imbalanceScore,
      recommendations
    };
  }
}
