import { MembershipEntry } from '../types';
import { QuorumStrategy, QuorumResult, MultiLevelQuorumOptions } from './types';

/**
 * Multi-level quorum strategy that evaluates quorum at multiple hierarchy levels
 * (cluster, region, zone) to ensure distributed fault tolerance
 */
export class MultiLevelQuorumStrategy implements QuorumStrategy {
  name = 'multi-level';

  evaluate(members: MembershipEntry[], options: MultiLevelQuorumOptions): QuorumResult {
    const aliveMembers = members.filter(m => m.status === 'ALIVE');
    
    // Evaluate cluster-level quorum
    const clusterQuorum = this.evaluateClusterLevel(aliveMembers, options.clusterLevel);
    
    // Evaluate region-level quorum
    const regionQuorum = this.evaluateRegionLevel(aliveMembers, options.regionLevel);
    
    // Evaluate zone-level quorum
    const zoneQuorum = this.evaluateZoneLevel(aliveMembers, options.zoneLevel);
    
    const hasQuorum = clusterQuorum.passed && regionQuorum.passed && zoneQuorum.passed;
    
    return {
      hasQuorum,
      requiredCount: options.clusterLevel.minNodes,
      currentCount: aliveMembers.length,
      strategy: this.name,
      metadata: {
        clusterQuorum,
        regionQuorum,
        zoneQuorum,
        breakdown: {
          cluster: `${aliveMembers.length}/${options.clusterLevel.minNodes}`,
          regions: `${regionQuorum.count}/${options.regionLevel.requiredRegions}`,
          zones: `${zoneQuorum.count}/${options.zoneLevel.requiredZones}`
        }
      }
    };
  }

  private evaluateClusterLevel(members: MembershipEntry[], config: MultiLevelQuorumOptions['clusterLevel']) {
    if (config.strategy === 'majority') {
      const required = Math.floor(members.length / 2) + 1;
      return { passed: members.length >= required, count: members.length, required };
    } else {
      return { passed: members.length >= config.minNodes, count: members.length, required: config.minNodes };
    }
  }

  private evaluateRegionLevel(members: MembershipEntry[], config: MultiLevelQuorumOptions['regionLevel']) {
    const regionGroups = new Map<string, MembershipEntry[]>();
    
    members.forEach(member => {
      const region = member.metadata?.region || 'unknown';
      if (!regionGroups.has(region)) regionGroups.set(region, []);
      regionGroups.get(region)!.push(member);
    });

    const validRegions = Array.from(regionGroups.values())
      .filter(nodes => nodes.length >= config.minNodesPerRegion);

    return {
      passed: validRegions.length >= config.requiredRegions,
      count: validRegions.length,
      required: config.requiredRegions
    };
  }

  private evaluateZoneLevel(members: MembershipEntry[], config: MultiLevelQuorumOptions['zoneLevel']) {
    const zoneGroups = new Map<string, MembershipEntry[]>();
    
    members.forEach(member => {
      const zone = member.metadata?.zone || 'unknown';
      if (!zoneGroups.has(zone)) zoneGroups.set(zone, []);
      zoneGroups.get(zone)!.push(member);
    });

    const validZones = Array.from(zoneGroups.values())
      .filter(nodes => nodes.length >= config.minNodesPerZone);

    return {
      passed: validZones.length >= config.requiredZones,
      count: validZones.length,
      required: config.requiredZones
    };
  }

  /**
   * Get detailed breakdown of quorum status at each level
   */
  getQuorumBreakdown(members: MembershipEntry[], options: MultiLevelQuorumOptions) {
    const result = this.evaluate(members, options);
    return result.metadata;
  }

  /**
   * Check if cluster can tolerate specific failures at each level
   */
  canTolerateFailures(members: MembershipEntry[], options: MultiLevelQuorumOptions, failures: {
    nodes?: number;
    regions?: number;
    zones?: number;
  }): boolean {
    const aliveMembers = members.filter(m => m.status === 'ALIVE');
    
    // Simulate failures and check if quorum still holds
    const remainingNodes = Math.max(0, aliveMembers.length - (failures.nodes || 0));
    
    // TODO: Implement region and zone failure simulation
    // This would require more complex logic to determine which specific regions/zones fail
    
    return remainingNodes >= options.clusterLevel.minNodes;
  }
}
