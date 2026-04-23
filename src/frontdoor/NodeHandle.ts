import { Node } from '../common/Node';
import { ClusterManager } from '../cluster/ClusterManager';
import { Router } from '../messaging/Router';
import { ConnectionManager } from '../connections/ConnectionManager';
import { PubSubManager } from '../gateway/pubsub/PubSubManager';
import { PresenceManager } from '../gateway/presence/PresenceManager';
import { ChannelManager } from '../gateway/channel/ChannelManager';
import { MessageRouter } from '../gateway/routing/MessageRouter';
import { DurableQueueManager } from '../gateway/queue/DurableQueueManager';

/**
 * Thin facade wrapping the existing Node class, providing a streamlined
 * API for common operations.
 */
export class NodeHandle {
  readonly node: Node;

  constructor(node: Node) {
    this.node = node;
  }

  /** Start the node and all its subsystems. */
  async start(): Promise<void> {
    await this.node.start();
  }

  /** Stop the node and all its subsystems. */
  async stop(): Promise<void> {
    await this.node.stop();
  }

  /** Returns true if the node is currently running. */
  isRunning(): boolean {
    return this.node.isRunning();
  }

  /** Get the node's unique identifier. */
  get id(): string {
    return this.node.id;
  }

  /** Get the ClusterManager subsystem. */
  getCluster(): ClusterManager {
    return this.node.cluster;
  }

  /** Get the Router subsystem. */
  getRouter(): Router {
    return this.node.router;
  }

  /** Get the ConnectionManager subsystem. */
  getConnections(): ConnectionManager {
    return this.node.connections;
  }

  /** Get the number of cluster members visible to this node. */
  getMemberCount(): number {
    return this.node.getMemberCount();
  }

  /** Get the cluster membership table. */
  getMembership(): Map<string, any> {
    return this.node.getMembership();
  }

  /** Get the PubSub subsystem for topic-based messaging. */
  getPubSub(): PubSubManager {
    return this.node.pubsub;
  }

  /** Get the Presence subsystem for client connection tracking. */
  getPresence(): PresenceManager {
    return this.node.presence;
  }

  /** Get the Channel subsystem for room/channel management. */
  getChannels(): ChannelManager {
    return this.node.channels;
  }

  /** Get the MessageRouter for high-level message routing. */
  getMessageRouter(): MessageRouter {
    return this.node.messageRouter;
  }

  /** Get the DurableQueue for WAL-backed message queuing. */
  getDurableQueue(): DurableQueueManager {
    return this.node.durableQueue;
  }

  /**
   * Subscribe to events emitted by the underlying Node's cluster.
   * Delegates to the ClusterManager EventEmitter.
   */
  on(event: string, listener: (...args: any[]) => void): this {
    this.node.cluster.on(event, listener);
    return this;
  }

  /**
   * Unsubscribe from events.
   */
  off(event: string, listener: (...args: any[]) => void): this {
    this.node.cluster.off(event, listener);
    return this;
  }
}
