/**
 * Quorum Strategy Implementations
 * 
 * This module provides advanced quorum strategies for distributed cluster coordination.
 * Each strategy implements different approaches to determining cluster quorum based on
 * various factors like network topology, node roles, consensus algorithms, and fault tolerance.
 */

export { QuorumStrategy, QuorumResult } from './types';
export { 
  MultiLevelQuorumOptions, 
  AdaptiveQuorumOptions, 
  ConsensusQuorumOptions, 
  RoleBasedQuorumOptions, 
  ZoneQuorumOptions 
} from './types';

export { MultiLevelQuorumStrategy } from './MultiLevelQuorumStrategy';
export { AdaptiveQuorumStrategy } from './AdaptiveQuorumStrategy';
export { ConsensusQuorumStrategy } from './ConsensusQuorumStrategy';
export { RoleBasedQuorumStrategy } from './RoleBasedQuorumStrategy';
export { ZoneQuorumStrategy } from './ZoneQuorumStrategy';

import { QuorumStrategy } from './types';
import { MultiLevelQuorumStrategy } from './MultiLevelQuorumStrategy';
import { AdaptiveQuorumStrategy } from './AdaptiveQuorumStrategy';
import { ConsensusQuorumStrategy } from './ConsensusQuorumStrategy';
import { RoleBasedQuorumStrategy } from './RoleBasedQuorumStrategy';
import { ZoneQuorumStrategy } from './ZoneQuorumStrategy';

/**
 * Quorum Strategy Factory
 * Creates appropriate quorum strategy instances based on configuration
 */
export class QuorumStrategyFactory {
  /**
   * Create a quorum strategy instance
   */
  static createStrategy(type: 'multi-level' | 'adaptive' | 'consensus' | 'role-based' | 'zone-aware'): QuorumStrategy {
    switch (type) {
      case 'multi-level':
        return new MultiLevelQuorumStrategy();
      case 'adaptive':
        return new AdaptiveQuorumStrategy();
      case 'consensus':
        return new ConsensusQuorumStrategy();
      case 'role-based':
        return new RoleBasedQuorumStrategy();
      case 'zone-aware':
        return new ZoneQuorumStrategy();
      default:
        throw new Error(`Unknown quorum strategy type: ${type}`);
    }
  }

  /**
   * Get all available strategy types
   */
  static getAvailableStrategies(): string[] {
    return ['multi-level', 'adaptive', 'consensus', 'role-based', 'zone-aware'];
  }

  /**
   * Recommend strategy based on cluster characteristics
   */
  static recommendStrategy(clusterInfo: {
    size: number;
    zones: number;
    roles: string[];
    consensusAlgorithm?: string;
    networkConditions?: 'stable' | 'unstable' | 'variable';
  }): string {
    // If consensus algorithm is specified, use consensus strategy
    if (clusterInfo.consensusAlgorithm) {
      return 'consensus';
    }
    
    // If multiple zones, prioritize zone-aware
    if (clusterInfo.zones > 1) {
      return 'zone-aware';
    }
    
    // If multiple roles, use role-based
    if (clusterInfo.roles.length > 1) {
      return 'role-based';
    }
    
    // If network is unstable, use adaptive
    if (clusterInfo.networkConditions === 'unstable' || clusterInfo.networkConditions === 'variable') {
      return 'adaptive';
    }
    
    // For complex deployments, use multi-level
    if (clusterInfo.size > 10) {
      return 'multi-level';
    }
    
    // Default for simple clusters
    return 'zone-aware';
  }
}
