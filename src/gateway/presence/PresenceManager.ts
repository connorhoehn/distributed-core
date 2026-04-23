import { EventEmitter } from 'events';
import { Transport } from '../../transport/Transport';
import { ClusterManager } from '../../cluster/ClusterManager';
import { Message, MessageType } from '../../types';
import { PresenceEntry, PresenceConfig, PresenceStats } from './types';

const DEFAULT_CONFIG: Required<PresenceConfig> = {
  syncInterval: 5000,
  clientTTL: 300000,
  enablePeriodicSync: true,
};

export class PresenceManager extends EventEmitter {
  private localClients: Map<string, PresenceEntry> = new Map();
  private remoteClients: Map<string, PresenceEntry> = new Map();
  private syncTimer: NodeJS.Timeout | null = null;
  private ttlTimer: NodeJS.Timeout | null = null;
  private messageListener: (message: Message) => void;
  private config: Required<PresenceConfig>;
  private lastSyncTimestamp: number = 0;

  constructor(
    private readonly localNodeId: string,
    private readonly transport: Transport,
    private readonly cluster: ClusterManager,
    config?: PresenceConfig,
  ) {
    super();

    this.config = { ...DEFAULT_CONFIG, ...config };

    // Register transport message handler for presence subsystem
    this.messageListener = (message: Message) => {
      if (message.type === MessageType.CUSTOM && message.data?.subsystem === 'presence') {
        this.handleRemoteMessage(message);
      }
    };
    this.transport.onMessage(this.messageListener);

    // When a new node joins, send our local presence to it
    this.cluster.on('member-joined', (nodeInfo: { id: string }) => {
      this.sendPresenceToNode(nodeInfo.id);
    });

    // When a node leaves, remove all remote clients from that node
    this.cluster.on('member-left', (nodeId: string) => {
      for (const [clientId, entry] of this.remoteClients) {
        if (entry.nodeId === nodeId) {
          this.remoteClients.delete(clientId);
          this.emit('client-untracked', entry);
        }
      }
    });

    // Start periodic sync timer
    if (this.config.enablePeriodicSync) {
      this.syncTimer = setInterval(() => {
        this.broadcastPresence();
      }, this.config.syncInterval);
      this.syncTimer.unref();
    }

    // Start TTL expiry timer (every 30s)
    this.ttlTimer = setInterval(() => {
      this.expireStaleClients();
    }, 30000);
    this.ttlTimer.unref();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  trackClient(clientId: string, metadata: Record<string, any> = {}): PresenceEntry {
    const now = Date.now();
    const entry: PresenceEntry = {
      clientId,
      nodeId: this.localNodeId,
      metadata,
      connectedAt: now,
      lastSeen: now,
    };

    this.localClients.set(clientId, entry);

    // Broadcast track action to cluster
    this.sendToCluster({
      subsystem: 'presence',
      action: 'track',
      entry,
    });

    this.emit('client-tracked', entry);
    return entry;
  }

  untrackClient(clientId: string): boolean {
    const entry = this.localClients.get(clientId);
    if (!entry) {
      return false;
    }

    this.localClients.delete(clientId);

    // Broadcast untrack action to cluster
    this.sendToCluster({
      subsystem: 'presence',
      action: 'untrack',
      clientId,
    });

    this.emit('client-untracked', entry);
    return true;
  }

  updateClient(clientId: string, metadata: Record<string, any>): PresenceEntry | undefined {
    const entry = this.localClients.get(clientId);
    if (!entry) {
      return undefined;
    }

    entry.metadata = metadata;
    entry.lastSeen = Date.now();

    // Broadcast update action to cluster
    this.sendToCluster({
      subsystem: 'presence',
      action: 'track',
      entry,
    });

    this.emit('client-updated', entry);
    return entry;
  }

  heartbeat(clientId: string): void {
    const entry = this.localClients.get(clientId);
    if (entry) {
      entry.lastSeen = Date.now();
    }
  }

  getClient(clientId: string): PresenceEntry | undefined {
    return this.localClients.get(clientId) ?? this.remoteClients.get(clientId);
  }

  getClientNode(clientId: string): string | undefined {
    const entry = this.getClient(clientId);
    return entry?.nodeId;
  }

  getLocalClients(): PresenceEntry[] {
    return Array.from(this.localClients.values());
  }

  getRemoteClients(): PresenceEntry[] {
    return Array.from(this.remoteClients.values());
  }

  getOnlineClients(): PresenceEntry[] {
    return [...this.getLocalClients(), ...this.getRemoteClients()];
  }

  getClientsByNode(nodeId: string): PresenceEntry[] {
    return this.getOnlineClients().filter((entry) => entry.nodeId === nodeId);
  }

  getStats(): PresenceStats {
    const localCount = this.localClients.size;
    const remoteCount = this.remoteClients.size;

    // Count distinct nodes from all clients
    const nodeIds = new Set<string>();
    for (const entry of this.localClients.values()) {
      nodeIds.add(entry.nodeId);
    }
    for (const entry of this.remoteClients.values()) {
      nodeIds.add(entry.nodeId);
    }

    return {
      localClients: localCount,
      remoteClients: remoteCount,
      totalClients: localCount + remoteCount,
      nodeCount: nodeIds.size,
      lastSyncTimestamp: this.lastSyncTimestamp,
    };
  }

  destroy(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.ttlTimer) {
      clearInterval(this.ttlTimer);
      this.ttlTimer = null;
    }
    this.transport.removeMessageListener(this.messageListener);
    this.localClients.clear();
    this.remoteClients.clear();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private broadcastPresence(): void {
    this.sendToCluster({
      subsystem: 'presence',
      action: 'sync',
      entries: Array.from(this.localClients.values()),
    });
    this.lastSyncTimestamp = Date.now();
    this.emit('sync-sent');
  }

  private sendPresenceToNode(targetNodeId: string): void {
    const membership = this.cluster.getMembership();
    const memberEntry = membership.get(targetNodeId);
    if (!memberEntry) {
      return;
    }

    const msg: Message = {
      id: `presence-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: MessageType.CUSTOM,
      data: {
        subsystem: 'presence',
        action: 'sync',
        entries: Array.from(this.localClients.values()),
      },
      sender: this.transport.getLocalNodeInfo(),
      timestamp: Date.now(),
    };

    this.transport.send(msg, {
      id: targetNodeId,
      address: memberEntry.metadata?.address || '',
      port: memberEntry.metadata?.port || 0,
    });
  }

  private handleRemoteMessage(message: Message): void {
    const { action } = message.data;
    const senderNodeId = message.sender.id;

    switch (action) {
      case 'sync': {
        const entries: PresenceEntry[] = message.data.entries || [];

        // Remove all existing remote clients from the sender node
        for (const [clientId, entry] of this.remoteClients) {
          if (entry.nodeId === senderNodeId) {
            this.remoteClients.delete(clientId);
          }
        }

        // Add all received entries
        for (const entry of entries) {
          this.remoteClients.set(entry.clientId, entry);
        }

        this.emit('sync-received', { nodeId: senderNodeId, count: entries.length });
        break;
      }

      case 'track': {
        const entry: PresenceEntry = message.data.entry;
        if (entry) {
          this.remoteClients.set(entry.clientId, entry);
          this.emit('client-tracked', entry);
        }
        break;
      }

      case 'untrack': {
        const clientId: string = message.data.clientId;
        const existing = this.remoteClients.get(clientId);
        if (existing) {
          this.remoteClients.delete(clientId);
          this.emit('client-untracked', existing);
        }
        break;
      }
    }
  }

  private expireStaleClients(): void {
    const now = Date.now();
    for (const [clientId, entry] of this.remoteClients) {
      if (now - entry.lastSeen > this.config.clientTTL) {
        this.remoteClients.delete(clientId);
        this.emit('client-expired', entry);
      }
    }
  }

  private sendToCluster(data: any): void {
    const msg: Message = {
      id: `presence-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: MessageType.CUSTOM,
      data,
      sender: this.transport.getLocalNodeInfo(),
      timestamp: Date.now(),
    };

    const membership = this.cluster.getMembership();
    for (const [key, entry] of membership) {
      if (key === this.localNodeId) {
        continue;
      }
      if (entry.status !== 'ALIVE') {
        continue;
      }
      this.transport.send(msg, {
        id: key,
        address: entry.metadata?.address || '',
        port: entry.metadata?.port || 0,
      });
    }
  }
}
