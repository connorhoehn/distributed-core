import { QuorumStrategyFactory } from '../../../../src/cluster/quorum';
import { 
  MultiLevelQuorumStrategy,
  AdaptiveQuorumStrategy,
  ConsensusQuorumStrategy,
  RoleBasedQuorumStrategy,
  ZoneQuorumStrategy
} from '../../../../src/cluster/quorum';
import { MembershipEntry } from '../../../../src/cluster/types';

describe('Advanced Quorum Strategies', () => {
  let mockMembers: MembershipEntry[];

  beforeEach(() => {
    mockMembers = [
      {
        id: 'node-1',
        status: 'ALIVE',
        lastSeen: Date.now(),
        version: 1,
        lastUpdated: Date.now(),
        metadata: { region: 'us-east-1', zone: 'us-east-1a', role: 'coordinator' }
      },
      {
        id: 'node-2',
        status: 'ALIVE',
        lastSeen: Date.now(),
        version: 1,
        lastUpdated: Date.now(),
        metadata: { region: 'us-east-1', zone: 'us-east-1b', role: 'worker' }
      },
      {
        id: 'node-3',
        status: 'ALIVE',
        lastSeen: Date.now(),
        version: 1,
        lastUpdated: Date.now(),
        metadata: { region: 'us-west-1', zone: 'us-west-1a', role: 'worker' }
      }
    ];
  });

  describe('QuorumStrategyFactory', () => {
    it('should create all strategy types', () => {
      const strategies = ['multi-level', 'adaptive', 'consensus', 'role-based', 'zone-aware'] as const;
      
      strategies.forEach(strategyType => {
        const strategy = QuorumStrategyFactory.createStrategy(strategyType);
        expect(strategy).toBeDefined();
        expect(typeof strategy.evaluate).toBe('function');
      });
    });

    it('should recommend appropriate strategies', () => {
      const multiZoneRecommendation = QuorumStrategyFactory.recommendStrategy({
        size: 5,
        zones: 3,
        roles: ['coordinator', 'worker']
      });
      expect(multiZoneRecommendation).toBe('zone-aware');

      const consensusRecommendation = QuorumStrategyFactory.recommendStrategy({
        size: 5,
        zones: 1,
        roles: ['node'],
        consensusAlgorithm: 'raft'
      });
      expect(consensusRecommendation).toBe('consensus');
    });
  });

  describe('MultiLevelQuorumStrategy', () => {
    it('should evaluate multi-level quorum', () => {
      const strategy = new MultiLevelQuorumStrategy();
      const options = {
        clusterLevel: { minNodes: 2, strategy: 'majority' as const },
        regionLevel: { requiredRegions: 2, minNodesPerRegion: 1 },
        zoneLevel: { requiredZones: 2, minNodesPerZone: 1 }
      };

      const result = strategy.evaluate(mockMembers, options);
      
      expect(result).toHaveProperty('hasQuorum');
      expect(result).toHaveProperty('strategy', 'multi-level');
      expect(result.metadata).toHaveProperty('clusterQuorum');
      expect(result.metadata).toHaveProperty('regionQuorum');
      expect(result.metadata).toHaveProperty('zoneQuorum');
    });
  });

  describe('AdaptiveQuorumStrategy', () => {
    it('should evaluate adaptive quorum', () => {
      const strategy = new AdaptiveQuorumStrategy();
      const options = {
        networkLatency: 200,
        partitionProbability: 0.1,
        consistencyLevel: 'strong' as const,
        adaptationStrategy: 'hybrid' as const
      };

      const result = strategy.evaluate(mockMembers, options);
      
      expect(result).toHaveProperty('hasQuorum');
      expect(result).toHaveProperty('strategy', 'adaptive');
      expect(result.metadata).toHaveProperty('adaptationFactor');
      expect(result.metadata).toHaveProperty('networkConditions');
    });
  });

  describe('ConsensusQuorumStrategy', () => {
    it('should evaluate Raft quorum', () => {
      const strategy = new ConsensusQuorumStrategy();
      const options = {
        algorithm: 'raft' as const,
        phase: 'election' as const,
        term: 1
      };

      const result = strategy.evaluate(mockMembers, options);
      
      expect(result).toHaveProperty('hasQuorum');
      expect(result).toHaveProperty('strategy', 'consensus-raft');
      expect(result.metadata).toHaveProperty('algorithm', 'raft');
      expect(result.metadata).toHaveProperty('majorityThreshold');
    });

    it('should evaluate PBFT quorum', () => {
      const strategy = new ConsensusQuorumStrategy();
      const options = {
        algorithm: 'pbft' as const,
        phase: 'commit' as const,
        byzantineFaultTolerance: 1
      };

      const result = strategy.evaluate(mockMembers, options);
      
      expect(result).toHaveProperty('hasQuorum');
      expect(result).toHaveProperty('strategy', 'consensus-pbft');
      expect(result.metadata).toHaveProperty('algorithm', 'pbft');
      expect(result.metadata).toHaveProperty('byzantineFaultTolerance', 1);
    });
  });

  describe('RoleBasedQuorumStrategy', () => {
    it('should evaluate role-based quorum', () => {
      const strategy = new RoleBasedQuorumStrategy();
      const options = {
        roles: {
          coordinator: { minCount: 1, weight: 3, required: true },
          worker: { minCount: 1, weight: 1, required: false }
        },
        totalWeightRequired: 4
      };

      const result = strategy.evaluate(mockMembers, options);
      
      expect(result).toHaveProperty('hasQuorum');
      expect(result).toHaveProperty('strategy', 'role-based');
      expect(result.metadata).toHaveProperty('roleBreakdown');
      expect(result.metadata).toHaveProperty('totalWeight');
    });
  });

  describe('ZoneQuorumStrategy', () => {
    it('should evaluate zone-aware quorum', () => {
      const strategy = new ZoneQuorumStrategy();
      const options = {
        requiredZones: 2,
        minNodesPerZone: 1,
        crossZoneReplication: true,
        faultTolerance: {
          maxZoneFailures: 1,
          gracefulDegradation: true
        }
      };

      const result = strategy.evaluate(mockMembers, options);
      
      expect(result).toHaveProperty('hasQuorum');
      expect(result).toHaveProperty('strategy', 'zone-aware');
      expect(result.metadata).toHaveProperty('zoneDistribution');
      expect(result.metadata).toHaveProperty('faultTolerance');
    });
  });
});
