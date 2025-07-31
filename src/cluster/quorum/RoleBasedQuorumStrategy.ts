import { MembershipEntry } from '../types';
import { QuorumStrategy, QuorumResult, RoleBasedQuorumOptions } from './types';

/**
 * Role-based quorum strategy that evaluates quorum based on
 * node roles, weights, and specific role requirements
 */
export class RoleBasedQuorumStrategy implements QuorumStrategy {
  name = 'role-based';

  evaluate(members: MembershipEntry[], options: RoleBasedQuorumOptions): QuorumResult {
    const aliveMembers = members.filter(m => m.status === 'ALIVE');
    
    // Group members by role
    const roleGroups = this.groupMembersByRole(aliveMembers);
    
    // Evaluate each role requirement
    const roleEvaluations = this.evaluateRoleRequirements(roleGroups, options.roles);
    
    // Calculate total weight
    const totalWeight = this.calculateTotalWeight(roleGroups, options.roles);
    
    // Check if all required roles are satisfied and total weight meets threshold
    const hasQuorum = roleEvaluations.allRequiredRolesSatisfied && 
                     totalWeight >= options.totalWeightRequired;
    
    return {
      hasQuorum,
      requiredCount: options.totalWeightRequired,
      currentCount: totalWeight,
      strategy: this.name,
      metadata: {
        roleBreakdown: roleEvaluations.breakdown,
        totalWeight,
        weightRequired: options.totalWeightRequired,
        rolesSatisfied: roleEvaluations.allRequiredRolesSatisfied,
        missingRoles: roleEvaluations.missingRoles,
        details: this.getRoleDetails(roleGroups, options.roles)
      }
    };
  }

  private groupMembersByRole(members: MembershipEntry[]): Map<string, MembershipEntry[]> {
    const roleGroups = new Map<string, MembershipEntry[]>();
    
    members.forEach(member => {
      const role = member.metadata?.role || 'unknown';
      if (!roleGroups.has(role)) {
        roleGroups.set(role, []);
      }
      roleGroups.get(role)!.push(member);
    });
    
    return roleGroups;
  }

  private evaluateRoleRequirements(
    roleGroups: Map<string, MembershipEntry[]>, 
    roleConfig: RoleBasedQuorumOptions['roles']
  ) {
    const breakdown: Record<string, { current: number; required: number; satisfied: boolean }> = {};
    const missingRoles: string[] = [];
    let allRequiredRolesSatisfied = true;

    for (const [roleName, config] of Object.entries(roleConfig)) {
      const currentCount = roleGroups.get(roleName)?.length || 0;
      const satisfied = currentCount >= config.minCount;
      
      breakdown[roleName] = {
        current: currentCount,
        required: config.minCount,
        satisfied
      };

      if (config.required && !satisfied) {
        allRequiredRolesSatisfied = false;
        if (currentCount === 0) {
          missingRoles.push(roleName);
        }
      }
    }

    return {
      breakdown,
      allRequiredRolesSatisfied,
      missingRoles
    };
  }

  private calculateTotalWeight(
    roleGroups: Map<string, MembershipEntry[]>, 
    roleConfig: RoleBasedQuorumOptions['roles']
  ): number {
    let totalWeight = 0;

    for (const [roleName, members] of roleGroups) {
      const config = roleConfig[roleName];
      if (config) {
        // Only count nodes up to the minimum required + some buffer
        const effectiveCount = Math.min(members.length, config.minCount + 2);
        totalWeight += effectiveCount * config.weight;
      } else {
        // Unknown roles get default weight of 1
        totalWeight += members.length * 1;
      }
    }

    return totalWeight;
  }

  private getRoleDetails(
    roleGroups: Map<string, MembershipEntry[]>, 
    roleConfig: RoleBasedQuorumOptions['roles']
  ) {
    const details: Record<string, any> = {};

    for (const [roleName, members] of roleGroups) {
      const config = roleConfig[roleName];
      details[roleName] = {
        nodes: members.map(m => m.id),
        count: members.length,
        weight: config?.weight || 1,
        required: config?.required || false,
        minCount: config?.minCount || 0,
        totalWeight: (config?.weight || 1) * members.length
      };
    }

    return details;
  }

  /**
   * Check if a specific role has quorum
   */
  hasRoleQuorum(members: MembershipEntry[], roleName: string, minCount: number): boolean {
    const aliveMembers = members.filter(m => m.status === 'ALIVE');
    const roleMembers = aliveMembers.filter(m => m.metadata?.role === roleName);
    return roleMembers.length >= minCount;
  }

  /**
   * Get the current weight contribution of each role
   */
  getRoleWeights(members: MembershipEntry[], roleConfig: RoleBasedQuorumOptions['roles']): Map<string, number> {
    const aliveMembers = members.filter(m => m.status === 'ALIVE');
    const roleGroups = this.groupMembersByRole(aliveMembers);
    const weights = new Map<string, number>();

    for (const [roleName, members] of roleGroups) {
      const config = roleConfig[roleName];
      const weight = config ? members.length * config.weight : members.length;
      weights.set(roleName, weight);
    }

    return weights;
  }

  /**
   * Recommend role distribution for optimal quorum
   */
  recommendRoleDistribution(
    targetClusterSize: number, 
    options: RoleBasedQuorumOptions
  ): Record<string, number> {
    const recommendations: Record<string, number> = {};
    let allocatedNodes = 0;

    // First, allocate minimum required nodes for each role
    for (const [roleName, config] of Object.entries(options.roles)) {
      if (config.required) {
        recommendations[roleName] = config.minCount;
        allocatedNodes += config.minCount;
      }
    }

    // Then distribute remaining nodes based on weights
    const remainingNodes = targetClusterSize - allocatedNodes;
    const totalWeight = Object.values(options.roles).reduce((sum, config) => sum + config.weight, 0);

    for (const [roleName, config] of Object.entries(options.roles)) {
      if (!config.required) {
        const proportionalAllocation = Math.floor((remainingNodes * config.weight) / totalWeight);
        recommendations[roleName] = Math.max(config.minCount, proportionalAllocation);
      }
    }

    return recommendations;
  }

  /**
   * Validate role configuration consistency
   */
  validateRoleConfiguration(config: RoleBasedQuorumOptions): {
    isValid: boolean;
    issues: string[];
    recommendations: string[];
  } {
    const issues: string[] = [];
    const recommendations: string[] = [];

    // Check if total minimum requirements are achievable
    const totalMinNodes = Object.values(config.roles).reduce((sum, role) => sum + role.minCount, 0);
    const minWeightFromRequired = Object.entries(config.roles)
      .filter(([_, roleConfig]) => roleConfig.required)
      .reduce((sum, [_, roleConfig]) => sum + (roleConfig.minCount * roleConfig.weight), 0);

    if (minWeightFromRequired > config.totalWeightRequired) {
      issues.push('Required roles alone exceed total weight requirement');
    }

    // Check for roles with zero weight
    const zeroWeightRoles = Object.entries(config.roles)
      .filter(([_, roleConfig]) => roleConfig.weight <= 0)
      .map(([roleName]) => roleName);

    if (zeroWeightRoles.length > 0) {
      issues.push(`Roles with zero or negative weight: ${zeroWeightRoles.join(', ')}`);
    }

    // Recommendations
    if (totalMinNodes < 3) {
      recommendations.push('Consider having at least 3 nodes for basic fault tolerance');
    }

    const requiredRoles = Object.entries(config.roles)
      .filter(([_, roleConfig]) => roleConfig.required)
      .map(([roleName]) => roleName);

    if (requiredRoles.length === 0) {
      recommendations.push('Consider marking at least one role as required for guaranteed presence');
    }

    return {
      isValid: issues.length === 0,
      issues,
      recommendations
    };
  }
}
