import { EventEmitter } from 'events';
import { Transport } from '../../transport/Transport';
import { ClusterManager } from '../../cluster/ClusterManager';
import { Message, MessageType } from '../../types';
import {
  ChannelConfig,
  ChannelInfo,
  ChannelManagerConfig,
  ChannelStats
} from './types';

const DEFAULT_CONFIG: Required<ChannelManagerConfig> = {
  enableAutoCleanup: true,
  cleanupInterval: 60000,
  defaultMaxMembers: 10000
};

export class ChannelManager extends EventEmitter {
  private readonly localNodeId: string;
  private readonly transport: Transport;
  private readonly cluster: ClusterManager;
  private readonly config: Required<ChannelManagerConfig>;

  private readonly channels: Map<string, ChannelInfo> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly messageListener: (message: Message) => void;

  constructor(
    localNodeId: string,
    transport: Transport,
    cluster: ClusterManager,
    config?: ChannelManagerConfig
  ) {
    super();

    this.localNodeId = localNodeId;
    this.transport = transport;
    this.cluster = cluster;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Bind message listener for cleanup
    this.messageListener = (message: Message) => {
      if (message.type === MessageType.CUSTOM && message.data?.subsystem === 'channel') {
        this.handleRemoteMessage(message);
      }
    };

    this.transport.onMessage(this.messageListener);

    // Re-evaluate channel ownership when membership changes
    this.cluster.on('membership-updated', () => this.handleMembershipChange());

    // Start auto-cleanup timer
    if (this.config.enableAutoCleanup) {
      this.cleanupTimer = setInterval(
        () => this.cleanupEmptyChannels(),
        this.config.cleanupInterval
      );
      this.cleanupTimer.unref();
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  createChannel(channelId: string, config?: ChannelConfig): ChannelInfo {
    const ownerNodeId = this.getChannelOwner(channelId) || this.localNodeId;
    const now = Date.now();

    const info: ChannelInfo = {
      id: channelId,
      ownerNodeId,
      members: new Set(),
      config: {
        maxMembers: config?.maxMembers ?? this.config.defaultMaxMembers,
        metadata: config?.metadata ?? {},
        persistent: config?.persistent ?? false
      },
      createdAt: now,
      lastActivity: now
    };

    this.channels.set(channelId, info);

    // If this node is NOT the owner, notify the owner
    if (!this.isOwner(channelId)) {
      this.sendToNode(ownerNodeId, {
        subsystem: 'channel',
        action: 'create',
        channelId,
        config: {
          maxMembers: info.config.maxMembers,
          metadata: info.config.metadata,
          persistent: info.config.persistent
        }
      });
    }

    this.emit('channel-created', info);
    return info;
  }

  joinChannel(channelId: string, clientId: string): void {
    let channel = this.channels.get(channelId);

    if (!channel) {
      channel = this.createChannel(channelId);
    }

    // Enforce maxMembers
    const maxMembers = channel.config.maxMembers ?? this.config.defaultMaxMembers;
    if (channel.members.size >= maxMembers) {
      throw new Error(
        `Channel "${channelId}" is full (max ${maxMembers} members)`
      );
    }

    channel.members.add(clientId);
    channel.lastActivity = Date.now();

    // If not the owner, forward to owner
    if (!this.isOwner(channelId)) {
      this.sendToNode(channel.ownerNodeId, {
        subsystem: 'channel',
        action: 'join',
        channelId,
        clientId
      });
    }

    this.emit('member-joined', { channelId, clientId });
  }

  leaveChannel(channelId: string, clientId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;

    channel.members.delete(clientId);
    channel.lastActivity = Date.now();

    // Forward to owner if not us
    if (!this.isOwner(channelId)) {
      this.sendToNode(channel.ownerNodeId, {
        subsystem: 'channel',
        action: 'leave',
        channelId,
        clientId
      });
    }

    this.emit('member-left', { channelId, clientId });

    // Mark for cleanup if empty and not persistent
    // (actual cleanup handled by the cleanup timer)
  }

  getChannel(channelId: string): ChannelInfo | undefined {
    return this.channels.get(channelId);
  }

  getMembers(channelId: string): string[] {
    const channel = this.channels.get(channelId);
    return channel ? Array.from(channel.members) : [];
  }

  getChannelOwner(channelId: string): string | null {
    return this.cluster.hashRing.getNode(channelId);
  }

  isOwner(channelId: string): boolean {
    return this.getChannelOwner(channelId) === this.localNodeId;
  }

  async broadcastToChannel(
    channelId: string,
    payload: any,
    excludeClientId?: string
  ): Promise<void> {
    await this.sendToCluster({
      subsystem: 'channel',
      action: 'broadcast',
      channelId,
      payload,
      excludeClientId
    });
  }

  destroyChannel(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;

    this.channels.delete(channelId);

    if (this.isOwner(channelId)) {
      this.sendToCluster({
        subsystem: 'channel',
        action: 'destroy',
        channelId
      });
    }

    this.emit('channel-destroyed', { channelId });
  }

  getOwnedChannels(): ChannelInfo[] {
    const owned: ChannelInfo[] = [];
    for (const channel of this.channels.values()) {
      if (this.isOwner(channel.id)) {
        owned.push(channel);
      }
    }
    return owned;
  }

  getStats(): ChannelStats {
    let totalMembers = 0;
    let ownedChannels = 0;

    for (const channel of this.channels.values()) {
      totalMembers += channel.members.size;
      if (this.isOwner(channel.id)) {
        ownedChannels++;
      }
    }

    const totalChannels = this.channels.size;

    return {
      totalChannels,
      ownedChannels,
      totalMembers,
      averageMembersPerChannel:
        totalChannels > 0 ? totalMembers / totalChannels : 0
    };
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.transport.removeMessageListener(this.messageListener);
    this.channels.clear();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // Private - remote message handling
  // ---------------------------------------------------------------------------

  private handleRemoteMessage(message: Message): void {
    const { action, channelId, clientId, config, payload, excludeClientId, channelState } =
      message.data;

    switch (action) {
      case 'create': {
        if (!this.channels.has(channelId)) {
          const ownerNodeId = this.getChannelOwner(channelId) || this.localNodeId;
          const now = Date.now();
          const info: ChannelInfo = {
            id: channelId,
            ownerNodeId,
            members: new Set(),
            config: {
              maxMembers: config?.maxMembers ?? this.config.defaultMaxMembers,
              metadata: config?.metadata ?? {},
              persistent: config?.persistent ?? false
            },
            createdAt: now,
            lastActivity: now
          };
          this.channels.set(channelId, info);
          this.emit('channel-created', info);
        }
        break;
      }

      case 'join': {
        let channel = this.channels.get(channelId);
        if (!channel) {
          // Auto-create if not yet known locally
          channel = this.createChannel(channelId);
        }
        const maxMembers = channel.config.maxMembers ?? this.config.defaultMaxMembers;
        if (channel.members.size < maxMembers) {
          channel.members.add(clientId);
          channel.lastActivity = Date.now();
          this.emit('member-joined', { channelId, clientId });
        }
        break;
      }

      case 'leave': {
        const channel = this.channels.get(channelId);
        if (channel) {
          channel.members.delete(clientId);
          channel.lastActivity = Date.now();
          this.emit('member-left', { channelId, clientId });
        }
        break;
      }

      case 'broadcast': {
        this.emit('channel-broadcast', { channelId, payload, excludeClientId });
        break;
      }

      case 'destroy': {
        if (this.channels.has(channelId)) {
          this.channels.delete(channelId);
          this.emit('channel-destroyed', { channelId });
        }
        break;
      }

      case 'sync': {
        // Full channel state sync (used on ownership change)
        if (channelState) {
          const ownerNodeId = this.getChannelOwner(channelId) || this.localNodeId;
          const info: ChannelInfo = {
            id: channelId,
            ownerNodeId,
            members: new Set(channelState.members || []),
            config: channelState.config || {
              maxMembers: this.config.defaultMaxMembers,
              metadata: {},
              persistent: false
            },
            createdAt: channelState.createdAt || Date.now(),
            lastActivity: Date.now()
          };
          this.channels.set(channelId, info);
        }
        break;
      }

      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Private - membership / ownership
  // ---------------------------------------------------------------------------

  private handleMembershipChange(): void {
    for (const channel of this.channels.values()) {
      const newOwner = this.getChannelOwner(channel.id);
      const previousOwner = channel.ownerNodeId;

      if (newOwner && newOwner !== previousOwner) {
        channel.ownerNodeId = newOwner;

        if (newOwner === this.localNodeId) {
          this.emit('ownership-gained', { channelId: channel.id, previousOwner });
        }

        if (previousOwner === this.localNodeId) {
          // Sync state to new owner
          this.sendToNode(newOwner, {
            subsystem: 'channel',
            action: 'sync',
            channelId: channel.id,
            channelState: {
              members: Array.from(channel.members),
              config: channel.config,
              createdAt: channel.createdAt
            }
          });
          this.emit('ownership-lost', { channelId: channel.id, newOwner });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private - cleanup
  // ---------------------------------------------------------------------------

  private cleanupEmptyChannels(): void {
    const now = Date.now();

    for (const [channelId, channel] of this.channels) {
      if (
        channel.members.size === 0 &&
        !channel.config.persistent &&
        now - channel.lastActivity > this.config.cleanupInterval
      ) {
        this.channels.delete(channelId);
        this.emit('channel-destroyed', { channelId });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private - transport helpers
  // ---------------------------------------------------------------------------

  private async sendToNode(targetNodeId: string, data: any): Promise<void> {
    const membership = this.cluster.getMembership();
    const entry = membership.get(targetNodeId);

    if (!entry || entry.status !== 'ALIVE') return;

    const msg: Message = {
      id: `channel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: MessageType.CUSTOM,
      data,
      sender: this.transport.getLocalNodeInfo(),
      timestamp: Date.now()
    };

    await this.transport.send(msg, {
      id: targetNodeId,
      address: entry.metadata?.address || '',
      port: entry.metadata?.port || 0
    });
  }

  private async sendToCluster(data: any): Promise<void> {
    const membership = this.cluster.getMembership();

    const msg: Message = {
      id: `channel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: MessageType.CUSTOM,
      data,
      sender: this.transport.getLocalNodeInfo(),
      timestamp: Date.now()
    };

    const sends: Promise<void>[] = [];

    for (const [key, entry] of membership) {
      if (key === this.localNodeId) continue;
      if (entry.status !== 'ALIVE') continue;

      sends.push(
        this.transport.send(msg, {
          id: key,
          address: entry.metadata?.address || '',
          port: entry.metadata?.port || 0
        })
      );
    }

    await Promise.all(sends);
  }
}
