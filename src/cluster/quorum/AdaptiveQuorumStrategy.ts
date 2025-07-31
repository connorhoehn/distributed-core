import { MembershipEntry } from '../types';
import { QuorumStrategy, QuorumResult, AdaptiveQuorumOptions } from './types';

/**
 * Adaptive quorum strategy that adjusts quorum requirements based on
 * network conditions, failure patterns, and consistency requirements
 */
export class AdaptiveQuorumStrategy implements QuorumStrategy {
  name = 'adaptive';
  
  private networkHistory: Array<{ timestamp: number; latency: number; failures: number }> = [];
  private adaptationMetrics = {
    recentFailures: 0,
    averageLatency: 0,
    partitionEvents: 0
  };

  evaluate(members: MembershipEntry[], options: AdaptiveQuorumOptions): QuorumResult {
    const aliveMembers = members.filter(m => m.status === 'ALIVE');
    
    // Calculate base quorum
    const baseQuorum = this.calculateBaseQuorum(aliveMembers.length);
    
    // Apply adaptations based on network conditions
    const adaptedQuorum = this.applyAdaptations(baseQuorum, aliveMembers.length, options);
    
    const hasQuorum = aliveMembers.length >= adaptedQuorum;
    
    return {
      hasQuorum,
      requiredCount: adaptedQuorum,
      currentCount: aliveMembers.length,
      strategy: this.name,
      metadata: {
        baseQuorum,
        adaptedQuorum,
        adaptationFactor: adaptedQuorum / baseQuorum,
        networkConditions: {
          latency: options.networkLatency,
          partitionProbability: options.partitionProbability,
          consistencyLevel: options.consistencyLevel
        },
        adaptationStrategy: options.adaptationStrategy,
        metrics: this.adaptationMetrics
      }
    };
  }

  private calculateBaseQuorum(totalNodes: number): number {
    return Math.floor(totalNodes / 2) + 1;
  }

  private applyAdaptations(baseQuorum: number, totalNodes: number, options: AdaptiveQuorumOptions): number {
    let adaptedQuorum = baseQuorum;

    switch (options.adaptationStrategy) {
      case 'latency-based':
        adaptedQuorum = this.applyLatencyAdaptation(baseQuorum, totalNodes, options);
        break;
      case 'failure-based':
        adaptedQuorum = this.applyFailureAdaptation(baseQuorum, totalNodes, options);
        break;
      case 'hybrid':
        adaptedQuorum = this.applyHybridAdaptation(baseQuorum, totalNodes, options);
        break;
    }

    // Apply consistency level adjustments
    adaptedQuorum = this.applyConsistencyAdaptation(adaptedQuorum, totalNodes, options.consistencyLevel);

    return Math.min(adaptedQuorum, totalNodes);
  }

  private applyLatencyAdaptation(baseQuorum: number, totalNodes: number, options: AdaptiveQuorumOptions): number {
    // Higher latency requires higher quorum to ensure consistency
    if (options.networkLatency > 1000) { // High latency (>1s)
      return Math.ceil(baseQuorum * 1.3);
    } else if (options.networkLatency > 500) { // Medium latency (>500ms)
      return Math.ceil(baseQuorum * 1.15);
    }
    return baseQuorum;
  }

  private applyFailureAdaptation(baseQuorum: number, totalNodes: number, options: AdaptiveQuorumOptions): number {
    // Higher partition probability requires higher quorum
    if (options.partitionProbability > 0.5) { // High partition risk
      return Math.ceil(totalNodes * 0.75); // 75% quorum
    } else if (options.partitionProbability > 0.3) { // Medium partition risk
      return Math.ceil(totalNodes * 0.67); // 67% quorum
    }
    return baseQuorum;
  }

  private applyHybridAdaptation(baseQuorum: number, totalNodes: number, options: AdaptiveQuorumOptions): number {
    const latencyFactor = this.calculateLatencyFactor(options.networkLatency);
    const partitionFactor = this.calculatePartitionFactor(options.partitionProbability);
    
    const combinedFactor = Math.max(latencyFactor, partitionFactor);
    return Math.ceil(baseQuorum * combinedFactor);
  }

  private applyConsistencyAdaptation(quorum: number, totalNodes: number, level: AdaptiveQuorumOptions['consistencyLevel']): number {
    switch (level) {
      case 'strict':
        return Math.max(quorum, Math.ceil(totalNodes * 0.8)); // 80% for strict consistency
      case 'strong':
        return Math.max(quorum, Math.ceil(totalNodes * 0.67)); // 67% for strong consistency
      case 'eventual':
        return quorum; // No additional requirements for eventual consistency
      default:
        return quorum;
    }
  }

  private calculateLatencyFactor(latency: number): number {
    if (latency > 1000) return 1.4;
    if (latency > 500) return 1.2;
    if (latency > 200) return 1.1;
    return 1.0;
  }

  private calculatePartitionFactor(probability: number): number {
    if (probability > 0.5) return 1.5;
    if (probability > 0.3) return 1.3;
    if (probability > 0.1) return 1.1;
    return 1.0;
  }

  /**
   * Update network metrics for adaptive decision making
   */
  updateNetworkMetrics(latency: number, failures: number) {
    const now = Date.now();
    this.networkHistory.push({ timestamp: now, latency, failures });
    
    // Keep only recent history (last 10 minutes)
    const tenMinutesAgo = now - 10 * 60 * 1000;
    this.networkHistory = this.networkHistory.filter(entry => entry.timestamp > tenMinutesAgo);
    
    // Update adaptation metrics
    this.updateAdaptationMetrics();
  }

  private updateAdaptationMetrics() {
    if (this.networkHistory.length === 0) return;
    
    this.adaptationMetrics.recentFailures = this.networkHistory
      .reduce((sum, entry) => sum + entry.failures, 0);
    
    this.adaptationMetrics.averageLatency = this.networkHistory
      .reduce((sum, entry) => sum + entry.latency, 0) / this.networkHistory.length;
    
    // Simple partition detection based on failure spikes
    this.adaptationMetrics.partitionEvents = this.detectPartitionEvents();
  }

  private detectPartitionEvents(): number {
    // TODO: Implement sophisticated partition detection
    // This is a placeholder that counts failure spikes
    return this.networkHistory.filter(entry => entry.failures > 2).length;
  }

  /**
   * Get current adaptation metrics
   */
  getAdaptationMetrics() {
    return { ...this.adaptationMetrics };
  }

  /**
   * Recommend optimal quorum settings based on historical data
   */
  recommendQuorumSettings(totalNodes: number): AdaptiveQuorumOptions {
    const avgLatency = this.adaptationMetrics.averageLatency;
    const failureRate = this.adaptationMetrics.recentFailures / Math.max(1, this.networkHistory.length);
    
    return {
      networkLatency: avgLatency,
      partitionProbability: Math.min(0.9, failureRate * 0.1),
      consistencyLevel: avgLatency > 500 ? 'eventual' : 'strong',
      adaptationStrategy: failureRate > 0.2 ? 'failure-based' : 'latency-based'
    };
  }
}
