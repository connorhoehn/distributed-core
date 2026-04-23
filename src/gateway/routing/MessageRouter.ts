import { EventEmitter } from 'events';
import { Transport } from '../../transport/Transport';
import { Message, MessageType } from '../../types';
import { PubSubManager } from '../pubsub/PubSubManager';
import { PresenceManager } from '../presence/PresenceManager';
import { PresenceEntry } from '../presence/types';
import { ChannelManager } from '../channel/ChannelManager';

/**
 * High-level message routing that orchestrates PubSub, Presence, and Channel layers.
 *
 * Provides a unified API for:
 * - Sending messages to specific clients (located via Presence)
 * - Broadcasting to channels (delegated to ChannelManager)
 * - Publishing to topics (delegated to PubSubManager)
 * - Broadcasting to all online clients
 */

export interface MessageRouterStats {
  messagesToClients: number;
  messagesToChannels: number;
  broadcasts: number;
  topicPublishes: number;
  deliveryFailures: number;
}

export class MessageRouter extends EventEmitter {
  private readonly localNodeId: string;
  private readonly transport: Transport;
  private readonly presence: PresenceManager;
  private readonly channels: ChannelManager;
  private readonly pubsub: PubSubManager;

  private readonly stats: MessageRouterStats = {
    messagesToClients: 0,
    messagesToChannels: 0,
    broadcasts: 0,
    topicPublishes: 0,
    deliveryFailures: 0,
  };

  constructor(
    localNodeId: string,
    transport: Transport,
    presence: PresenceManager,
    channels: ChannelManager,
    pubsub: PubSubManager
  ) {
    super();
    this.localNodeId = localNodeId;
    this.transport = transport;
    this.presence = presence;
    this.channels = channels;
    this.pubsub = pubsub;
  }

  /**
   * Send a message to a specific client by ID.
   * Uses Presence to locate which node the client is on.
   * Returns false if the client was not found.
   */
  async sendToClient(clientId: string, message: any): Promise<boolean> {
    const nodeId = this.presence.getClientNode(clientId);
    if (!nodeId) {
      this.stats.deliveryFailures++;
      this.emit('delivery-failed', { target: clientId, reason: 'client-not-found' });
      return false;
    }

    if (nodeId === this.localNodeId) {
      // Client is on this node — emit for local delivery
      this.emit('local-delivery', { clientId, message });
    } else {
      // Client is on a remote node — send via transport
      const entry = this.presence.getClient(clientId);
      const transportMsg: Message = {
        id: `router-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type: MessageType.CUSTOM,
        data: {
          subsystem: 'router',
          action: 'client-message',
          clientId,
          message,
        },
        sender: this.transport.getLocalNodeInfo(),
        timestamp: Date.now(),
      };
      await this.transport.send(transportMsg, {
        id: nodeId,
        address: entry?.metadata?.address || '',
        port: entry?.metadata?.port || 0,
      });
    }

    this.stats.messagesToClients++;
    return true;
  }

  /**
   * Send a message to all members of a channel.
   * Delegates to ChannelManager's broadcastToChannel.
   */
  async sendToChannel(
    channelId: string,
    message: any,
    excludeClientId?: string
  ): Promise<void> {
    await this.channels.broadcastToChannel(channelId, message, excludeClientId);
    this.stats.messagesToChannels++;
  }

  /**
   * Broadcast a message to all online clients across the cluster.
   * Groups clients by node to minimize transport calls.
   */
  async broadcast(
    message: any,
    filter?: (entry: PresenceEntry) => boolean
  ): Promise<void> {
    let clients = this.presence.getOnlineClients();
    if (filter) {
      clients = clients.filter(filter);
    }

    // Group by node
    const byNode = new Map<string, string[]>();
    for (const client of clients) {
      if (!byNode.has(client.nodeId)) {
        byNode.set(client.nodeId, []);
      }
      byNode.get(client.nodeId)!.push(client.clientId);
    }

    // Send one message per node
    const transportMsg: Message = {
      id: `router-bcast-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: MessageType.CUSTOM,
      data: {
        subsystem: 'router',
        action: 'broadcast',
        message,
      },
      sender: this.transport.getLocalNodeInfo(),
      timestamp: Date.now(),
    };

    for (const [nodeId, clientIds] of byNode) {
      if (nodeId === this.localNodeId) {
        // Local delivery
        this.emit('local-broadcast', { clientIds, message });
      } else {
        const msg = {
          ...transportMsg,
          id: `router-bcast-${nodeId}-${Date.now()}`,
          data: { ...transportMsg.data, targetClientIds: clientIds },
        };
        await this.transport.send(msg, { id: nodeId, address: '', port: 0 });
      }
    }

    this.stats.broadcasts++;
  }

  /**
   * Publish to a PubSub topic.
   * Delegates to PubSubManager.
   */
  async publishToTopic(topic: string, payload: any): Promise<void> {
    await this.pubsub.publish(topic, payload);
    this.stats.topicPublishes++;
  }

  /** Get routing statistics. */
  getStats(): MessageRouterStats {
    return { ...this.stats };
  }
}
