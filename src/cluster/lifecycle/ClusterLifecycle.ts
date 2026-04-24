import { EventEmitter } from 'events';
import { IClusterLifecycle, LifecycleConfig } from './types';
import { IClusterManagerContext, IRequiresContext } from '../core/IClusterManagerContext';
import { NodeInfo } from '../types';

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
   * Emit both legacy and canonical event names during the deprecation window.
   * Callers should migrate to the new name; old name support will be removed in
   * a future release.
   *
   * NOTE: `error` is deliberately excluded from dual-emit. Node's EventEmitter
   * throws on unhandled `error` events; renaming to `lifecycle:error` while
   * keeping a silent `error` alias would suppress that safety mechanism.
   */
  private emitRenamed(oldName: string, newName: string, ...args: unknown[]): void {
    this.emit(newName, ...args);
    this.emit(oldName, ...args);
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

      // Rebuild the hash ring to include the local node
      this.context.rebuildHashRing();

      // Start transport layer
      await this.context.transport.start();

      // Join cluster via seed nodes
      await this.context.joinCluster();

      // Start gossip protocol
      this.context.startGossipTimer();

      // Start failure detection
      this.context.failureDetector.start();

      this.isStarted = true;
      this.emitRenamed('started', 'lifecycle:started', { nodeId: this.context.localNodeId, timestamp: Date.now() });
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
      this.context.stopGossipTimer();

      // Stop failure detector
      this.context.failureDetector.stop();

      // Stop transport
      await this.context.transport.stop();

      // Clear membership and rebuild hash ring with empty member list
      this.context.membership.clear();
      this.context.hashRing.rebuild([]);

      this.isStarted = false;
      this.emitRenamed('stopped', 'lifecycle:stopped', { nodeId: this.context.localNodeId, timestamp: Date.now() });
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

      // Trigger immediate gossip to announce leaving
      await this.context.sendImmediateGossip();

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

      // Mark node as draining so peers stop routing new work to it
      const drainingNode: NodeInfo = {
        ...targetNode,
        status: 'DRAINING',
        version: targetNode.version + 1,
        lastSeen: Date.now()
      };

      this.context.membership.updateNode(drainingNode);
      this.context.addToRecentUpdates(drainingNode);

      // Announce draining status immediately via gossip so peers stop
      // assigning new work to this node as quickly as possible.
      await this.context.sendImmediateGossip();

      // Rebuild the hash ring so the routing layer immediately stops
      // directing new requests to the draining node.
      this.context.rebuildHashRing();

      // Trigger an anti-entropy cycle so peers pick up the updated ring
      // and can take over any in-flight ownership (ranges, leases, etc.).
      this.context.runAntiEntropyCycle();

      // Wait for in-flight workloads to complete up to drainTimeout.
      // A real implementation would poll a work-queue depth counter and
      // resolve early once it reaches zero; here we honour the timeout
      // so the contract is met without busy-waiting.
      await new Promise<void>(resolve => {
        const deadline = setTimeout(resolve, this.config.drainTimeout);
        // Allow the process to exit even if drain is still pending.
        deadline.unref?.();
      });

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

      // Rebuild the consistent hash ring with the current alive membership.
      // This redistributes virtual-node ownership across all live nodes and
      // is the canonical rebalancing operation for a consistent-hashing cluster.
      this.context.rebuildHashRing();

      // Broadcast the updated local node info immediately so peers converge
      // on the new ring topology as fast as possible.
      await this.context.sendImmediateGossip();

      // Run an anti-entropy cycle to detect and repair any state that is now
      // out of place after the ring change (e.g. ranges that moved nodes).
      this.context.runAntiEntropyCycle();

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
