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

    // Build region → zone → node maps to simulate structured failures
    const regionToNodes = new Map<string, MembershipEntry[]>();
    const zoneToNodes = new Map<string, MembershipEntry[]>();

    for (const member of aliveMembers) {
      const region = member.metadata?.region || 'unknown';
      const zone = member.metadata?.zone || 'unknown';

      if (!regionToNodes.has(region)) regionToNodes.set(region, []);
      regionToNodes.get(region)!.push(member);

      if (!zoneToNodes.has(zone)) zoneToNodes.set(zone, []);
      zoneToNodes.get(zone)!.push(member);
    }

    // Simulate region failures: remove the smallest regions first (worst-case
    // for the cluster — losing regions that contribute least to diversity).
    const failedNodeIds = new Set<string>();

    if (failures.regions && failures.regions > 0) {
      const regionsSortedBySize = Array.from(regionToNodes.entries())
        .sort((a, b) => b[1].length - a[1].length); // largest first → remove largest = hardest test

      const regionsToFail = regionsSortedBySize.slice(0, failures.regions);
      for (const [, nodes] of regionsToFail) {
        nodes.forEach(n => failedNodeIds.add(n.id));
      }
    }

    // Simulate zone failures: remove zones whose nodes have not already been
    // removed by a region failure, to avoid double-counting.
    if (failures.zones && failures.zones > 0) {
      const zonesNotAlreadyFailed = Array.from(zoneToNodes.entries())
        .filter(([, nodes]) => nodes.some(n => !failedNodeIds.has(n.id)))
        .sort((a, b) => b[1].length - a[1].length); // largest first

      const zonesToFail = zonesNotAlreadyFailed.slice(0, failures.zones);
      for (const [, nodes] of zonesToFail) {
        nodes.forEach(n => failedNodeIds.add(n.id));
      }
    }

    // Simulate raw node failures on top of region/zone failures
    let remainingMembers = aliveMembers.filter(m => !failedNodeIds.has(m.id));

    if (failures.nodes && failures.nodes > 0) {
      remainingMembers = remainingMembers.slice(failures.nodes);
    }

    // Re-evaluate all three quorum levels against the reduced membership
    const clusterResult = this.evaluateClusterLevel(remainingMembers, options.clusterLevel);
    const regionResult = this.evaluateRegionLevel(remainingMembers, options.regionLevel);
    const zoneResult = this.evaluateZoneLevel(remainingMembers, options.zoneLevel);

    return clusterResult.passed && regionResult.passed && zoneResult.passed;
  }
}
