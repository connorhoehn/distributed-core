import { EventEmitter } from 'events';
import { IClusterLifecycle, LifecycleConfig } from './types';
import { IClusterManagerContext, IRequiresContext } from '../IClusterManagerContext';
import { NodeInfo } from '../../types';

/**
 * ClusterLifecycle manages cluster node lifecycle operations
 * 
 * Responsibilities:
 * - Cluster startup and initialization
 * - Graceful shutdown and cleanup
 * - Node joining and leaving
 * - Cluster rebalancing
 * - Node draining for maintenance
 */
export class ClusterLifecycle extends EventEmitter implements IClusterLifecycle, IRequiresContext {
  private config: LifecycleConfig;
  private context?: IClusterManagerContext;
  private isStarted: boolean = false;
  private isDraining: boolean = false;

  constructor(config?: Partial<LifecycleConfig>) {
    super();
    
    this.config = {
      shutdownTimeout: 10000,
      drainTimeout: 30000,
      enableAutoRebalance: true,
      rebalanceThreshold: 0.1,
      enableGracefulShutdown: true,
      maxShutdownWait: 5000,
      ...config
    };
  }

  /**
   * Set the cluster manager context for delegation
   */
  setContext(context: IClusterManagerContext): void {
    this.context = context;
  }

  /**
   * Start the cluster node
   */
  async start(): Promise<void> {
    if (!this.context) {
      throw new Error('ClusterLifecycle requires context to be set');
    }

    if (this.isStarted) {
      return; // Already started
    }

    try {
      // Initialize local node in membership
      const localNode = this.context.getLocalNodeInfo();
      this.context.membership.addLocalNode(localNode);

      // Rebuild hash ring with initial membership
      this.context.rebuildHashRing();

      // Start transport layer with message handling via communication module
      this.context.transport.onMessage((message) => {
        this.context!.communication.handleMessage(message);
      });
      await this.context.transport.start();

      // Join cluster via seed nodes
      await this.context.communication.joinCluster();

      // Start periodic gossip protocol
      this.context.communication.startGossipTimer();

      // Start failure detection
      this.context.failureDetector.start();

      this.isStarted = true;
      this.emit('started', { nodeId: this.context.localNodeId, timestamp: Date.now() });
    } catch (error) {
      this.emit('error', { error: error as Error, operation: 'start' });
      throw error;
    }
  }

  /**
   * Stop the cluster node
   */
  async stop(): Promise<void> {
    if (!this.context) {
      throw new Error('ClusterLifecycle requires context to be set');
    }

    if (!this.isStarted) {
      return; // Already stopped
    }

    try {
      // Stop gossip timer
      this.context.communication.stopGossipTimer();

      // Stop failure detector
      this.context.failureDetector.stop();

      // Stop transport
      await this.context.transport.stop();

      // Clear membership and hash ring
      this.context.membership.clear();
      this.context.hashRing.rebuild([]);

      this.isStarted = false;
      this.emit('stopped', { nodeId: this.context.localNodeId, timestamp: Date.now() });
    } catch (error) {
      this.emit('error', { error: error as Error, operation: 'stop' });
      throw error;
    }
  }

  /**
   * Leave the cluster gracefully
   */
  async leave(): Promise<void> {
    if (!this.context) {
      throw new Error('ClusterLifecycle requires context to be set');
    }

    try {
      const localNode = this.context.membership.getMember(this.context.localNodeId);
      if (!localNode) {
        return; // Node not in cluster
      }

      // Mark node as leaving
      const leavingNode: NodeInfo = {
        ...localNode,
        status: 'LEAVING',
        version: localNode.version + 1,
        lastSeen: Date.now()
      };

      this.context.membership.updateNode(leavingNode);
      this.context.addToRecentUpdates(leavingNode);

      // Trigger anti-entropy cycle to propagate leaving state
      this.context.communication.runAntiEntropyCycle();

      // Wait for graceful shutdown period
      if (this.config.enableGracefulShutdown) {
        await new Promise(resolve => setTimeout(resolve, this.config.maxShutdownWait));
      }

      // Stop the node
      await this.stop();

      this.emit('left', { nodeId: this.context.localNodeId, timestamp: Date.now() });
    } catch (error) {
      this.emit('error', { error: error as Error, operation: 'leave' });
      throw error;
    }
  }

  /**
   * Drain node for maintenance
   */
  async drainNode(nodeId?: string): Promise<void> {
    if (!this.context) {
      throw new Error('ClusterLifecycle requires context to be set');
    }

    const targetNodeId = nodeId || this.context.localNodeId;
    
    try {
      this.isDraining = true;

      const targetNode = this.context.membership.getMember(targetNodeId);
      if (!targetNode) {
        throw new Error(`Node ${targetNodeId} not found in cluster`);
      }

      // Mark node as draining
      const drainingNode: NodeInfo = {
        ...targetNode,
        status: 'DRAINING',
        version: targetNode.version + 1,
        lastSeen: Date.now()
      };

      this.context.membership.updateNode(drainingNode);
      this.context.addToRecentUpdates(drainingNode);

      // Migrate workloads away from the draining node
      await this.context.migrateWorkloads(targetNodeId);

      this.isDraining = false;
      this.emit('drained', { nodeId: targetNodeId, timestamp: Date.now() });
    } catch (error) {
      this.isDraining = false;
      this.emit('error', { error: error as Error, operation: 'drain', nodeId: targetNodeId });
      throw error;
    }
  }

  /**
   * Rebalance the cluster
   */
  async rebalanceCluster(): Promise<void> {
    if (!this.context) {
      throw new Error('ClusterLifecycle requires context to be set');
    }

    try {
      const members = this.context.membership.getAliveMembers();
      
      if (members.length < 2) {
        return; // Cannot rebalance with less than 2 nodes
      }

      // Rebuild the hash ring from current alive membership
      this.context.rebuildHashRing();

      // Force anti-entropy to sync membership state across nodes
      this.context.communication.runAntiEntropyCycle();

      this.emit('rebalanced', { 
        nodeCount: members.length, 
        timestamp: Date.now() 
      });
    } catch (error) {
      this.emit('error', { error: error as Error, operation: 'rebalance' });
      throw error;
    }
  }

  /**
   * Get lifecycle status
   */
  getStatus(): { isStarted: boolean; isDraining: boolean; nodeId?: string } {
    return {
      isStarted: this.isStarted,
      isDraining: this.isDraining,
      nodeId: this.context?.localNodeId
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): LifecycleConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<LifecycleConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }
}
