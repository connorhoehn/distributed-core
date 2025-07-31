import { MembershipEntry } from '../types';
import { QuorumStrategy, QuorumResult, ConsensusQuorumOptions } from './types';

/**
 * Consensus-specific quorum strategy that implements quorum requirements
 * for different distributed consensus algorithms (Raft, PBFT, Paxos)
 */
export class ConsensusQuorumStrategy implements QuorumStrategy {
  name = 'consensus';

  evaluate(members: MembershipEntry[], options: ConsensusQuorumOptions): QuorumResult {
    const aliveMembers = members.filter(m => m.status === 'ALIVE');
    
    switch (options.algorithm) {
      case 'raft':
        return this.evaluateRaftQuorum(aliveMembers, options);
      case 'pbft':
        return this.evaluatePBFTQuorum(aliveMembers, options);
      case 'paxos':
        return this.evaluatePaxosQuorum(aliveMembers, options);
      default:
        throw new Error(`Unsupported consensus algorithm: ${options.algorithm}`);
    }
  }

  /**
   * Raft consensus quorum evaluation
   * Requires majority for leader election and log replication
   */
  private evaluateRaftQuorum(members: MembershipEntry[], options: ConsensusQuorumOptions): QuorumResult {
    const totalNodes = members.length;
    const majority = Math.floor(totalNodes / 2) + 1;
    const aliveCount = members.length;
    
    let requiredCount = majority;
    const phase = options.phase || 'election';
    
    // Different phases may have different requirements
    switch (phase) {
      case 'election':
        // Leader election requires majority
        requiredCount = majority;
        break;
      case 'replication':
        // Log replication requires majority acknowledgment
        requiredCount = majority;
        break;
      case 'commit':
        // Commit requires majority confirmation
        requiredCount = majority;
        break;
    }

    const hasQuorum = aliveCount >= requiredCount;
    
    return {
      hasQuorum,
      requiredCount,
      currentCount: aliveCount,
      strategy: `${this.name}-raft`,
      metadata: {
        algorithm: 'raft',
        phase,
        term: options.term,
        leaderId: options.leaderId,
        majorityThreshold: majority,
        details: {
          total: totalNodes,
          alive: aliveCount,
          required: requiredCount
        }
      }
    };
  }

  /**
   * PBFT (Practical Byzantine Fault Tolerance) quorum evaluation
   * Requires 3f+1 nodes to tolerate f Byzantine failures
   */
  private evaluatePBFTQuorum(members: MembershipEntry[], options: ConsensusQuorumOptions): QuorumResult {
    const totalNodes = members.length;
    const aliveCount = members.length;
    const byzantineFaultTolerance = options.byzantineFaultTolerance || 1;
    
    // PBFT requires 3f+1 total nodes to tolerate f Byzantine failures
    const minRequiredNodes = 3 * byzantineFaultTolerance + 1;
    const phase = options.phase || 'commit';
    
    let requiredCount: number;
    
    switch (phase) {
      case 'election':
        // View change requires 2f+1 nodes
        requiredCount = 2 * byzantineFaultTolerance + 1;
        break;
      case 'replication':
        // Prepare phase requires 2f+1 responses
        requiredCount = 2 * byzantineFaultTolerance + 1;
        break;
      case 'commit':
        // Commit phase requires 2f+1 responses
        requiredCount = 2 * byzantineFaultTolerance + 1;
        break;
      default:
        requiredCount = 2 * byzantineFaultTolerance + 1;
    }

    const hasQuorum = aliveCount >= requiredCount && totalNodes >= minRequiredNodes;
    
    return {
      hasQuorum,
      requiredCount,
      currentCount: aliveCount,
      strategy: `${this.name}-pbft`,
      metadata: {
        algorithm: 'pbft',
        phase,
        byzantineFaultTolerance,
        minRequiredNodes,
        details: {
          total: totalNodes,
          alive: aliveCount,
          required: requiredCount,
          canTolerateFailures: byzantineFaultTolerance
        }
      }
    };
  }

  /**
   * Paxos consensus quorum evaluation
   * Requires majority for both prepare and accept phases
   */
  private evaluatePaxosQuorum(members: MembershipEntry[], options: ConsensusQuorumOptions): QuorumResult {
    const totalNodes = members.length;
    const aliveCount = members.length;
    const majority = Math.floor(totalNodes / 2) + 1;
    const phase = options.phase || 'commit';
    
    let requiredCount: number;
    
    switch (phase) {
      case 'election':
        // Prepare phase requires majority
        requiredCount = majority;
        break;
      case 'replication':
        // Accept phase requires majority
        requiredCount = majority;
        break;
      case 'commit':
        // Decision phase requires majority
        requiredCount = majority;
        break;
      default:
        requiredCount = majority;
    }

    const hasQuorum = aliveCount >= requiredCount;
    
    return {
      hasQuorum,
      requiredCount,
      currentCount: aliveCount,
      strategy: `${this.name}-paxos`,
      metadata: {
        algorithm: 'paxos',
        phase,
        majorityThreshold: majority,
        details: {
          total: totalNodes,
          alive: aliveCount,
          required: requiredCount
        }
      }
    };
  }

  /**
   * Check if cluster can handle specific consensus operations
   */
  canPerformConsensusOperation(
    members: MembershipEntry[], 
    options: ConsensusQuorumOptions,
    operation: 'leader-election' | 'log-replication' | 'state-transition'
  ): boolean {
    const operationOptions = { ...options };
    
    switch (operation) {
      case 'leader-election':
        operationOptions.phase = 'election';
        break;
      case 'log-replication':
        operationOptions.phase = 'replication';
        break;
      case 'state-transition':
        operationOptions.phase = 'commit';
        break;
    }
    
    const result = this.evaluate(members, operationOptions);
    return result.hasQuorum;
  }

  /**
   * Calculate optimal consensus configuration for given cluster size
   */
  getOptimalConfiguration(clusterSize: number, algorithm: ConsensusQuorumOptions['algorithm']) {
    switch (algorithm) {
      case 'raft':
        return {
          algorithm: 'raft' as const,
          optimalSize: clusterSize % 2 === 0 ? clusterSize + 1 : clusterSize, // Prefer odd numbers
          faultTolerance: Math.floor(clusterSize / 2),
          recommendation: clusterSize < 3 ? 'Consider increasing cluster size for fault tolerance' : 'Optimal configuration'
        };
        
      case 'pbft':
        const maxByzantineFaults = Math.floor((clusterSize - 1) / 3);
        return {
          algorithm: 'pbft' as const,
          byzantineFaultTolerance: maxByzantineFaults,
          minClusterSize: 3 * maxByzantineFaults + 1,
          recommendation: clusterSize < 4 ? 'Minimum 4 nodes required for Byzantine fault tolerance' : 'Optimal configuration'
        };
        
      case 'paxos':
        return {
          algorithm: 'paxos' as const,
          optimalSize: clusterSize % 2 === 0 ? clusterSize + 1 : clusterSize, // Prefer odd numbers
          faultTolerance: Math.floor(clusterSize / 2),
          recommendation: clusterSize < 3 ? 'Consider increasing cluster size for fault tolerance' : 'Optimal configuration'
        };
        
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
  }
}
