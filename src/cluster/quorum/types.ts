import { MembershipEntry } from '../types';

/**
 * Base interface for all quorum strategies
 */
export interface QuorumStrategy {
  name: string;
  evaluate(members: MembershipEntry[], options?: any): QuorumResult;
}

/**
 * Result of a quorum evaluation
 */
export interface QuorumResult {
  hasQuorum: boolean;
  requiredCount: number;
  currentCount: number;
  strategy: string;
  metadata?: Record<string, any>;
}

/**
 * Multi-level quorum configuration
 */
export interface MultiLevelQuorumOptions {
  clusterLevel: {
    minNodes: number;
    strategy: 'simple' | 'majority';
  };
  regionLevel: {
    requiredRegions: number;
    minNodesPerRegion: number;
  };
  zoneLevel: {
    requiredZones: number;
    minNodesPerZone: number;
  };
}

/**
 * Adaptive quorum configuration
 */
export interface AdaptiveQuorumOptions {
  networkLatency: number;
  partitionProbability: number;
  consistencyLevel: 'eventual' | 'strong' | 'strict';
  adaptationStrategy: 'latency-based' | 'failure-based' | 'hybrid';
}

/**
 * Consensus-specific quorum options
 */
export interface ConsensusQuorumOptions {
  algorithm: 'raft' | 'pbft' | 'paxos';
  phase?: 'election' | 'replication' | 'commit';
  byzantineFaultTolerance?: number;
  term?: number;
  leaderId?: string;
}

/**
 * Role-based quorum configuration
 */
export interface RoleBasedQuorumOptions {
  roles: {
    [roleName: string]: {
      minCount: number;
      weight: number;
      required: boolean;
    };
  };
  totalWeightRequired: number;
}

/**
 * Zone-aware quorum configuration
 */
export interface ZoneQuorumOptions {
  requiredZones: number;
  minNodesPerZone: number;
  preferredZones?: string[];
  crossZoneReplication: boolean;
  faultTolerance: {
    maxZoneFailures: number;
    gracefulDegradation: boolean;
  };
}
