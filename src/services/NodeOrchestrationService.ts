import { ClusterManager } from '../cluster/ClusterManager';
import { Transport } from '../transport/Transport';
import { Logger } from '../common/logger';

export interface NodeOrchestrationConfig {
  nodeId: string;
  seedNodes?: string[];
  cluster?: {
    virtualNodesPerNode?: number;
    replicationFactor?: number;
    enableAntiEntropy?: boolean;
  };
}

/**
 * NodeOrchestrationService - Phase 3: Gossip & Membership
 * 
 * Responsibilities:
 * - Start gossip protocol
 * - Join cluster membership table
 * - Handle node health monitoring
 * - Coordinate cluster topology changes
 */
export class NodeOrchestrationService {
  private logger = Logger.create('NodeOrchestrationService');

  constructor(
    private config: NodeOrchestrationConfig,
    private clusterManager: ClusterManager,
    private clusterTransport: Transport
  ) {}

  /**
   * Start membership phase - gossip, join cluster, establish health
   */
  async startMembership(): Promise<void> {
    this.logger.info('[MEMBERSHIP] Starting gossip and cluster membership...');
    
    try {
      // Ensure cluster transport is ready
      if (!this.clusterTransport) {
        throw new Error('Cluster transport not available for membership phase');
      }

      // Start cluster manager (this internally starts gossip)
      this.logger.info(`[MEMBERSHIP] Starting cluster manager for node ${this.config.nodeId}...`);
      await this.clusterManager.start();

      // Join cluster membership if seed nodes are provided
      if (this.config.seedNodes && this.config.seedNodes.length > 0) {
        this.logger.info(`[MEMBERSHIP] Joining cluster via seeds: ${this.config.seedNodes.join(', ')}`);
        
        // Let cluster manager handle seed node connections
        // The ClusterManager should have a method to join via seeds
        await this.joinClusterViaSeeds();
      }

      // Wait for initial membership stabilization
      await this.waitForMembershipStabilization();

      this.logger.info('[MEMBERSHIP] Cluster membership established');
      
    } catch (error) {
      this.logger.error('[MEMBERSHIP] Failed to establish cluster membership:', error);
      throw new Error(`Membership phase failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Stop membership and gossip
   */
  async stopMembership(): Promise<void> {
    this.logger.info('[MEMBERSHIP] Leaving cluster...');
    
    try {
      await this.clusterManager.stop();
      this.logger.info('[MEMBERSHIP] Left cluster successfully');
    } catch (error) {
      this.logger.error('[MEMBERSHIP] Error leaving cluster:', error);
      throw error;
    }
  }

  /**
   * Get current cluster health status
   */
  async getClusterHealth(): Promise<{
    nodeId: string;
    memberCount: number;
    isHealthy: boolean;
  }> {
    // Get membership info from cluster manager
    const membership = await this.clusterManager.getMembership();
    
    return {
      nodeId: this.config.nodeId,
      memberCount: membership.size,
      isHealthy: membership.size > 0
    };
  }

  /**
   * Join cluster via seed nodes
   */
  private async joinClusterViaSeeds(): Promise<void> {
    if (!this.config.seedNodes || this.config.seedNodes.length === 0) {
      this.logger.info('[MEMBERSHIP] No seed nodes provided, starting as first node');
      return;
    }

    // The ClusterManager handles seed node connections internally
    // through its communication.joinCluster() method during start()
    this.logger.info(`[MEMBERSHIP] Seed nodes configured: ${this.config.seedNodes.join(', ')}`);
    this.logger.info('[MEMBERSHIP] ClusterManager will handle seed connections during start()');
  }

  /**
   * Wait for membership to stabilize before proceeding
   */
  private async waitForMembershipStabilization(): Promise<void> {
    const maxWaitTime = 10000; // 10 seconds
    const checkInterval = 500; // 500ms
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const health = await this.getClusterHealth();
        
        if (health.isHealthy) {
          this.logger.info(`[MEMBERSHIP] Membership stable with ${health.memberCount} members`);
          return;
        }
        
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      } catch (error) {
        this.logger.warn('[MEMBERSHIP] Health check failed during stabilization:', error instanceof Error ? error.message : 'Unknown error');
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
    }

    this.logger.warn('[MEMBERSHIP] Membership stabilization timeout, proceeding anyway');
  }
}
