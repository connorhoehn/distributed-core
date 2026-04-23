import { EventEmitter } from 'events';
import { Transport } from '../../transport/Transport';
import { ClusterManager } from '../../cluster/ClusterManager';
import { Message, MessageType, NodeId } from '../../types';
import {
  PubSubHandler,
  PubSubMessageMetadata,
  Subscription,
  PubSubConfig,
  PubSubStats,
} from './types';

const DEFAULT_CONFIG: Required<PubSubConfig> = {
  enableCrossNodeDelivery: true,
  messageDeduplicationTTL: 60000,
};

const DEDUP_CLEANUP_INTERVAL = 30000;

export class PubSubManager extends EventEmitter {
  private readonly localNodeId: string;
  private readonly transport: Transport;
  private readonly cluster: ClusterManager;
  private readonly config: Required<PubSubConfig>;

  /** topic -> (subscriptionId -> Subscription) */
  private readonly subscriptions: Map<string, Map<string, Subscription>> = new Map();

  /** messageId -> timestamp, used for cross-node deduplication */
  private readonly recentMessageIds: Map<string, number> = new Map();

  private readonly stats: PubSubStats = {
    topicCount: 0,
    totalSubscriptions: 0,
    messagesPublished: 0,
    messagesDelivered: 0,
    crossNodeMessages: 0,
  };

  private readonly deduplicationTimer: NodeJS.Timeout;
  private readonly messageListener: (message: Message) => void;
  private subIdCounter = 0;

  constructor(
    localNodeId: string,
    transport: Transport,
    cluster: ClusterManager,
    config?: PubSubConfig,
  ) {
    super();

    this.localNodeId = localNodeId;
    this.transport = transport;
    this.cluster = cluster;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Bind a transport message listener for incoming pubsub messages
    this.messageListener = (message: Message) => {
      if (
        message.type === MessageType.CUSTOM &&
        message.data?.subsystem === 'pubsub' &&
        message.data?.action === 'publish'
      ) {
        this.handleRemotePublish(message);
      }
    };
    this.transport.onMessage(this.messageListener);

    // Forward cluster member-left events
    this.cluster.on('member-left', (nodeId: string) => {
      this.emit('member-left', nodeId);
    });

    // Periodic dedup cache cleanup
    this.deduplicationTimer = setInterval(
      () => this.cleanupDeduplicationCache(),
      DEDUP_CLEANUP_INTERVAL,
    );
    this.deduplicationTimer.unref();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to a topic. Returns the subscription ID.
   */
  subscribe(topic: string, handler: PubSubHandler): string {
    this.subIdCounter++;
    const id = `sub-${this.subIdCounter}`;

    const subscription: Subscription = {
      id,
      topic,
      handler,
      createdAt: Date.now(),
    };

    let topicSubs = this.subscriptions.get(topic);
    if (!topicSubs) {
      topicSubs = new Map();
      this.subscriptions.set(topic, topicSubs);
    }
    topicSubs.set(id, subscription);

    this.refreshTopicStats();
    this.emit('subscription-added', { id, topic });

    return id;
  }

  /**
   * Remove a subscription by its ID. Returns true if found and removed.
   */
  unsubscribe(subscriptionId: string): boolean {
    for (const [topic, topicSubs] of this.subscriptions) {
      if (topicSubs.has(subscriptionId)) {
        topicSubs.delete(subscriptionId);

        // Remove the topic map entirely when empty
        if (topicSubs.size === 0) {
          this.subscriptions.delete(topic);
        }

        this.refreshTopicStats();
        this.emit('subscription-removed', { id: subscriptionId, topic });
        return true;
      }
    }
    return false;
  }

  /**
   * Publish a message to a topic. Delivers locally and, when enabled,
   * to all alive cluster members.
   */
  async publish(topic: string, payload: unknown): Promise<void> {
    const messageId = `pub-${this.localNodeId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const metadata: PubSubMessageMetadata = {
      messageId,
      publisherNodeId: this.localNodeId,
      timestamp: Date.now(),
      topic,
    };

    this.deliverLocally(topic, payload, metadata);

    if (this.config.enableCrossNodeDelivery) {
      await this.deliverToCluster(topic, payload, metadata);
    }

    this.stats.messagesPublished++;
    this.emit('message-published', { topic, messageId });
  }

  /**
   * Get all topics that currently have at least one active subscription.
   */
  getTopics(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  /**
   * Get the number of active subscriptions, optionally filtered by topic.
   */
  getSubscriptionCount(topic?: string): number {
    if (topic !== undefined) {
      return this.subscriptions.get(topic)?.size ?? 0;
    }
    return this.stats.totalSubscriptions;
  }

  /**
   * Return a snapshot of the current stats.
   */
  getStats(): PubSubStats {
    return { ...this.stats };
  }

  /**
   * Tear down timers, listeners, and internal state.
   */
  destroy(): void {
    clearInterval(this.deduplicationTimer);
    this.transport.removeMessageListener(this.messageListener);
    this.subscriptions.clear();
    this.recentMessageIds.clear();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private deliverLocally(
    topic: string,
    payload: unknown,
    metadata: PubSubMessageMetadata,
  ): void {
    const topicSubs = this.subscriptions.get(topic);
    if (!topicSubs) return;

    for (const subscription of topicSubs.values()) {
      subscription.handler(topic, payload, metadata);
      this.stats.messagesDelivered++;
      this.emit('message-delivered', { topic, subscriptionId: subscription.id });
    }
  }

  private async deliverToCluster(
    topic: string,
    payload: unknown,
    metadata: PubSubMessageMetadata,
  ): Promise<void> {
    const membership = this.cluster.getMembership();

    const msg: Message = {
      id: `pubsub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: MessageType.CUSTOM,
      data: {
        subsystem: 'pubsub',
        action: 'publish',
        topic,
        payload,
        metadata,
      },
      sender: this.transport.getLocalNodeInfo(),
      timestamp: Date.now(),
    };

    const sendPromises: Promise<void>[] = [];

    for (const [nodeId, entry] of membership) {
      // Skip self and non-alive nodes
      if (nodeId === this.localNodeId) continue;
      if (entry.status !== 'ALIVE') continue;

      const target: NodeId = {
        id: entry.id || nodeId,
        address: entry.metadata?.address || '',
        port: entry.metadata?.port || 0,
      };

      sendPromises.push(this.transport.send(msg, target));
      this.stats.crossNodeMessages++;
    }

    await Promise.all(sendPromises);
  }

  private handleRemotePublish(message: Message): void {
    const { topic, payload, metadata } = message.data as {
      topic: string;
      payload: unknown;
      metadata: PubSubMessageMetadata;
    };

    // Deduplication check
    if (this.recentMessageIds.has(metadata.messageId)) {
      return;
    }
    this.recentMessageIds.set(metadata.messageId, Date.now());

    this.deliverLocally(topic, payload, metadata);
  }

  private cleanupDeduplicationCache(): void {
    const cutoff = Date.now() - this.config.messageDeduplicationTTL;
    for (const [id, timestamp] of this.recentMessageIds) {
      if (timestamp < cutoff) {
        this.recentMessageIds.delete(id);
      }
    }
  }

  /**
   * Recompute aggregate stats derived from the subscriptions map.
   */
  private refreshTopicStats(): void {
    let total = 0;
    for (const topicSubs of this.subscriptions.values()) {
      total += topicSubs.size;
    }
    this.stats.topicCount = this.subscriptions.size;
    this.stats.totalSubscriptions = total;
  }
}
