import { EventEmitter } from 'events';
import {
  ClusterNodeConfig,
  RangeHandler,
  IClusterCoordinator,
  ClusterMessage,
  ClusterInfo,
  RangeId,
  ClusterFrameworkEvents,
  ClusterView
} from './types';
import { InMemoryCoordinator } from './InMemoryCoordinator';
import { GossipCoordinator } from './GossipCoordinator';
import { EtcdCoordinator } from './EtcdCoordinator';
import { ZookeeperCoordinator } from './ZookeeperCoordinator';
import { createLogger, FrameworkLogger } from '../common/logger';

/**
 * Range-based coordination framework for distributed applications.
 * 
 * This framework enables applications to:
 * - Register handlers for specific work ranges (shards)
 * - Participate in cluster coordination using pluggable coordinators
 * - Automatically acquire and release ranges based on cluster topology
 * - Route messages to appropriate range handlers
 * - React to cluster topology changes
 */
export class RangeCoordinator extends EventEmitter {
  private coordinator!: IClusterCoordinator;
  private rangeHandler: RangeHandler;
  private nodeId: string;
  private config: ClusterNodeConfig;
  private isStarted = false;
  private ownedRanges = new Set<RangeId>();
  private messageQueue: ClusterMessage[] = [];
  private rebalanceInterval?: NodeJS.Timeout;
  private logger: FrameworkLogger;

  // Configurable timeouts for testing
  private rebalanceIntervalMs: number;

  constructor(config: ClusterNodeConfig) {
    super();
    this.config = config;
    this.nodeId = config.nodeId || this.generateNodeId();
    this.rangeHandler = config.rangeHandler;
    this.logger = createLogger(config.logging);
    
    // Set rebalance interval - shorter for tests
    this.rebalanceIntervalMs = (config.coordinatorConfig?.testMode || process.env.NODE_ENV === 'test') 
      ? 1000 // 1 second for tests
      : 30000; // 30 seconds for production
    
    this.logger.framework(`🔧 RangeCoordinator created for node ${this.nodeId} in ring ${config.ringId}`);
  }

  /**
   * Initialize and start the range coordinator
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.framework(`⚠️ RangeCoordinator already started for node ${this.nodeId}`);
      return;
    }

    this.logger.framework(`🚀 Starting RangeCoordinator for node ${this.nodeId}`);

    // Create and initialize coordinator
    this.coordinator = this.createCoordinator();
    await this.coordinator.initialize(
      this.nodeId, 
      this.config.ringId, 
      this.config.coordinatorConfig
    );

    // Set up coordinator event listeners
    this.setupCoordinatorEvents();

    // Start coordinator
    await this.coordinator.start();

    // Join cluster
    await this.coordinator.joinCluster(this.config.seedNodes || []);

    // Start range management
    this.startRangeManagement();

    this.isStarted = true;
    this.logger.framework(`✅ RangeCoordinator started successfully for node ${this.nodeId}`);
  }

  /**
   * Stop the range coordinator and clean up resources
   */
  async stop(): Promise<void> {
    if (!this.isStarted) {
      return;
    }

    this.logger.framework(`🛑 Stopping RangeCoordinator for node ${this.nodeId}`);

    // Set stopped flag first to prevent any ongoing operations
    this.isStarted = false;

    // Stop range management timer immediately
    if (this.rebalanceInterval) {
      clearInterval(this.rebalanceInterval);
      this.rebalanceInterval = undefined;
    }

    // Release all owned ranges
    await this.releaseAllRanges();

    // Stop coordinator
    if (this.coordinator) {
      await this.coordinator.stop();
    }

    this.logger.framework(`✅ RangeCoordinator stopped for node ${this.nodeId}`);
  }  /**
   * Send a message to a specific range
   */
  async sendMessage(message: ClusterMessage): Promise<void> {
    if (!this.isStarted) {
      throw new Error('RangeCoordinator not started');
    }

    // Check if we own the target range
    if (message.targetRangeId && await this.coordinator.ownsRange(message.targetRangeId)) {
      // Process locally
      await this.rangeHandler.onMessage(message);
    } else {
      // Queue for processing or routing to another node
      this.messageQueue.push(message);
      this.logger.framework(`📫 Queued message ${message.id} for range ${message.targetRangeId}`);
    }
  }

  /**
   * Get current cluster status
   */
  async getClusterStatus(): Promise<ClusterView> {
    if (!this.coordinator) {
      throw new Error('Coordinator not initialized');
    }
    return await this.coordinator.getClusterView();
  }

  /**
   * Get ranges owned by this node
   */
  async getOwnedRanges(): Promise<RangeId[]> {
    if (!this.coordinator) {
      return [];
    }
    return await this.coordinator.getOwnedRanges();
  }

  /**
   * Manually trigger range rebalancing
   */
  async rebalanceRanges(): Promise<void> {
    this.logger.framework(`⚖️ Triggering manual range rebalancing for node ${this.nodeId}`);
    await this.performRangeRebalancing();
  }

  private createCoordinator(): IClusterCoordinator {
    switch (this.config.coordinator) {
      case 'in-memory':
        return new InMemoryCoordinator();
      
      case 'gossip':
        return new GossipCoordinator();
      
      case 'etcd':
        return new EtcdCoordinator();
      
      case 'zookeeper':
        return new ZookeeperCoordinator();
      
      default:
        throw new Error(`Unknown coordinator type: ${this.config.coordinator}`);
    }
  }

  private setupCoordinatorEvents(): void {
    this.coordinator.on('range-acquired', async (rangeId: RangeId) => {
      this.logger.framework(`🎯 Acquired range ${rangeId}`);
      this.ownedRanges.add(rangeId);
      
      // Notify handler
      const clusterInfo = await this.buildClusterInfo();
      await this.rangeHandler.onJoin(rangeId, clusterInfo);
      
      this.emit('range-acquired', rangeId);
    });

    this.coordinator.on('range-released', async (rangeId: RangeId) => {
      this.logger.framework(`📤 Released range ${rangeId}`);
      this.ownedRanges.delete(rangeId);
      
      // Notify handler
      await this.rangeHandler.onLeave(rangeId);
      
      this.emit('range-released', rangeId);
    });

    this.coordinator.on('topology-changed', async () => {
      this.logger.framework(`🔄 Cluster topology changed`);
      
      // Notify handler if it supports topology changes
      if (this.rangeHandler.onTopologyChange) {
        const clusterInfo = await this.buildClusterInfo();
        await this.rangeHandler.onTopologyChange(clusterInfo);
      }
      
      // Trigger rebalancing
      await this.performRangeRebalancing();
      
      this.emit('topology-changed');
    });

    this.coordinator.on('coordinator-error', (error: Error) => {
      this.logger.error(`❌ Coordinator error:`, error);
      this.emit('error', error);
    });
  }

  private startRangeManagement(): void {
    // Start periodic rebalancing with configurable interval
    this.rebalanceInterval = setInterval(async () => {
      // Exit immediately if coordinator is stopped
      if (!this.isStarted) {
        return;
      }
      
      try {
        await this.performRangeRebalancing();
      } catch (error) {
        // Only log if we're still running
        if (this.isStarted) {
          this.logger.error(`❌ Range rebalancing failed:`, error);
        }
      }
    }, this.rebalanceIntervalMs);

    // Initial rebalancing
    setImmediate(() => {
      if (this.isStarted) {
        this.performRangeRebalancing();
      }
    });
  }

  private async performRangeRebalancing(): Promise<void> {
    // Check if we're still started before performing operations
    if (!this.isStarted) {
      return;
    }
    
    this.logger.framework(`⚖️ Performing range rebalancing for node ${this.nodeId}`);
    
    // Get current cluster view
    const clusterView = await this.coordinator.getClusterView();
    const aliveNodes = Array.from(clusterView.nodes.values())
      .filter(node => node.isAlive)
      .map(node => node.nodeId);

    if (aliveNodes.length === 0) {
      this.logger.framework(`⚠️ No alive nodes in cluster, skipping rebalancing`);
      return;
    }

    // Calculate ideal range distribution
    const totalRanges = this.calculateTotalRanges(aliveNodes.length);
    const rangesPerNode = Math.ceil(totalRanges / aliveNodes.length);
    
    this.logger.framework(`📊 Cluster has ${aliveNodes.length} nodes, ${totalRanges} total ranges, ~${rangesPerNode} per node`);

    // Try to acquire ranges if we're under capacity
    const currentRanges = await this.coordinator.getOwnedRanges();
    if (currentRanges.length < rangesPerNode) {
      const needed = rangesPerNode - currentRanges.length;
      this.logger.framework(`📈 Node ${this.nodeId} needs ${needed} more ranges`);
      
      for (let i = 0; i < needed; i++) {
        // Check again if we're still started
        if (!this.isStarted) {
          return;
        }
        
        const candidateRange = this.findCandidateRange(clusterView, totalRanges);
        if (candidateRange) {
          const acquired = await this.coordinator.acquireLease(candidateRange);
          if (acquired) {
            this.logger.framework(`✅ Acquired additional range ${candidateRange}`);
          }
        }
      }
    }

    // Process any queued messages for our ranges
    await this.processMessageQueue();
  }

  private calculateTotalRanges(nodeCount: number): number {
    // Simple heuristic: scale ranges with cluster size
    // In production, this could be configurable or based on workload
    return Math.max(nodeCount * 2, 8); // At least 8 ranges, 2x node count
  }

  private findCandidateRange(clusterView: ClusterView, totalRanges: number): RangeId | null {
    // Find an unowned range
    for (let i = 0; i < totalRanges; i++) {
      const rangeId = `range-${i}`;
      const lease = clusterView.leases.get(rangeId);
      
      if (!lease || lease.expiresAt <= Date.now()) {
        return rangeId;
      }
    }
    
    return null;
  }

  private async processMessageQueue(): Promise<void> {
    const ownedRanges = await this.coordinator.getOwnedRanges();
    const processable = this.messageQueue.filter(msg => 
      msg.targetRangeId && ownedRanges.includes(msg.targetRangeId)
    );

    for (const message of processable) {
      try {
        await this.rangeHandler.onMessage(message);
        // Remove from queue
        const index = this.messageQueue.indexOf(message);
        if (index > -1) {
          this.messageQueue.splice(index, 1);
        }
        this.logger.framework(`✅ Processed queued message ${message.id}`);
      } catch (error) {
        this.logger.error(`❌ Failed to process message ${message.id}:`, error);
      }
    }
  }

  private async releaseAllRanges(): Promise<void> {
    const ranges = Array.from(this.ownedRanges);
    for (const rangeId of ranges) {
      try {
        await this.coordinator.releaseLease(rangeId);
      } catch (error) {
        this.logger.error(`❌ Failed to release range ${rangeId}:`, error);
      }
    }
  }

  private async buildClusterInfo(): Promise<ClusterInfo> {
    const clusterView = await this.coordinator.getClusterView();
    const ownedRanges = await this.coordinator.getOwnedRanges();
    
    return {
      nodeId: this.nodeId,
      members: Array.from(clusterView.nodes.keys()),
      totalRanges: this.calculateTotalRanges(clusterView.nodes.size),
      assignedRanges: ownedRanges,
      ringId: this.config.ringId
    };
  }

  private generateNodeId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `node-${timestamp}-${random}`;
  }
}

/**
 * Create a cluster node with the specified configuration
 */
export function createClusterNode(config: ClusterNodeConfig): RangeCoordinator {
  return new RangeCoordinator(config);
}

/**
 * Create a range handler factory function
 */
export function createRangeHandler<T extends RangeHandler>(
  handlerClass: new (...args: any[]) => T
): (...args: any[]) => T {
  return (...args: any[]) => new handlerClass(...args);
}
