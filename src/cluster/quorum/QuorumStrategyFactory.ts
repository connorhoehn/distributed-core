import { QuorumStrategy } from './types';
import { AdaptiveQuorumStrategy } from './strategies/Adaptive';
import { ConsensusQuorumStrategy } from './strategies/Consensus';
import { MultiLevelQuorumStrategy } from './strategies/MultiLevel';
import { RoleBasedQuorumStrategy } from './strategies/RoleBased';
import { ZoneQuorumStrategy } from './strategies/Zone';
import type { QuorumStrategyType } from './types';
// If QuorumStrategyType is not a type, define it here or fix the import in '../types'.
// Example definition if needed:

export class QuorumStrategyFactory {
  static createStrategy(type: QuorumStrategyType): QuorumStrategy {
    switch (type) {
      case 'adaptive':
        return new AdaptiveQuorumStrategy();
      case 'consensus':
        return new ConsensusQuorumStrategy();
      case 'multi-level':
        return new MultiLevelQuorumStrategy();
      case 'role-based':
        return new RoleBasedQuorumStrategy();
      case 'zone-aware':
        return new ZoneQuorumStrategy();
      default:
        throw new Error(`Unknown quorum strategy type: ${type}`);
    }
  }

  static getAvailableStrategies(): QuorumStrategyType[] {
    return ['adaptive', 'consensus', 'multi-level', 'role-based', 'zone-aware'];
  }

  static recommendStrategy(clusterSize: number, zones: number, roles: string[]): QuorumStrategyType {
    if (zones > 1) return 'zone-aware';
    if (roles.length > 1) return 'role-based';
    if (clusterSize > 10) return 'adaptive';
    return 'consensus';
  }
}
