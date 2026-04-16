import { EventEmitter } from 'events';
import { IClusterCoordinator, CoordinatorSemantics, ClusterView, RangeId, RingId, RangeLease, ClusterFrameworkEvents, CoordinatorNodeStatus } from './types';
import { createLogger, FrameworkLogger } from '../common/logger';

// ---------------------------------------------------------------------------
// Pluggable etcd client interface
// ---------------------------------------------------------------------------

export interface IEtcdWatchEvent {
  key: string;
  value: string;
  type: 'put' | 'delete';
}

export interface IEtcdLease {
  id: string;
  keepalive: () => void;
  revoke: () => Promise<void>;
}

export interface IEtcdClient {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  watch(prefix: string, callback: (event: IEtcdWatchEvent) => void): { cancel: () => void };
  lease(ttlSeconds: number): Promise<IEtcdLease>;
}

// ---------------------------------------------------------------------------
// In-memory implementation of IEtcdClient (for testing)
// ---------------------------------------------------------------------------

export class InMemoryEtcdClient implements IEtcdClient {
  private store = new Map<string, string>();
  private watchers = new Map<string, Set<(event: IEtcdWatchEvent) => void>>();
  private leaseCounter = 0;
  private leaseKeys = new Map<string, Set<string>>(); // leaseId -> keys bound to it

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    this.notifyWatchers(key, value, 'put');
  }

  async delete(key: string): Promise<void> {
    const value = this.store.get(key) ?? '';
    this.store.delete(key);
    this.notifyWatchers(key, value, 'delete');
  }

  watch(prefix: string, callback: (event: IEtcdWatchEvent) => void): { cancel: () => void } {
    if (!this.watchers.has(prefix)) {
      this.watchers.set(prefix, new Set());
    }
    this.watchers.get(prefix)!.add(callback);
    return {
      cancel: () => {
        this.watchers.get(prefix)?.delete(callback);
      }
    };
  }

  async lease(ttlSeconds: number): Promise<IEtcdLease> {
    const id = `lease-${++this.leaseCounter}`;
    this.leaseKeys.set(id, new Set());
    return {
      id,
      keepalive: () => { /* no-op in memory */ },
      revoke: async () => {
        const keys = this.leaseKeys.get(id);
        if (keys) {
          for (const key of keys) {
            await this.delete(key);
          }
          this.leaseKeys.delete(id);
        }
      }
    };
  }

  /**
   * Associate a key with a lease so revoking the lease deletes the key.
   * This mirrors etcd's lease-attach semantics.
   */
  attachToLease(leaseId: string, key: string): void {
    this.leaseKeys.get(leaseId)?.add(key);
  }

  /** Enumerate all keys matching a prefix (for getClusterView). */
  getPrefix(prefix: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const [k, v] of this.store) {
      if (k.startsWith(prefix)) {
        result.set(k, v);
      }
    }
    return result;
  }

  // -- internal helpers -----------------------------------------------------

  private notifyWatchers(key: string, value: string, type: 'put' | 'delete'): void {
    for (const [prefix, cbs] of this.watchers) {
      if (key.startsWith(prefix)) {
        for (const cb of cbs) {
          cb({ key, value, type });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Key-path helpers
// ---------------------------------------------------------------------------

const PREFIX = '/distributed-core';

function nodeKey(nodeId: string): string {
  return `${PREFIX}/nodes/${nodeId}`;
}

function nodesPrefix(): string {
  return `${PREFIX}/nodes/`;
}

function rangeKey(rangeId: RangeId): string {
  return `${PREFIX}/ranges/${rangeId}`;
}

function rangesPrefix(): string {
  return `${PREFIX}/ranges/`;
}

// ---------------------------------------------------------------------------
// EtcdCoordinator
// ---------------------------------------------------------------------------

const LEASE_TTL_SECONDS = 15;

export class EtcdCoordinator extends EventEmitter implements IClusterCoordinator {
  private nodeId!: string;
  private ringId!: RingId;
  private started = false;
  private logger!: FrameworkLogger;
  private client: IEtcdClient;

  private nodeLease: IEtcdLease | null = null;
  private rangeLeases = new Map<RangeId, IEtcdLease>();
  private clusterVersion = 0;

  private nodeWatcher: { cancel: () => void } | null = null;
  private rangeWatcher: { cancel: () => void } | null = null;

  /**
   * Create an EtcdCoordinator.
   * @param etcdClient  A pluggable IEtcdClient implementation.
   */
  constructor(etcdClient: IEtcdClient) {
    super();
    this.client = etcdClient;
  }

  // -- IClusterCoordinator --------------------------------------------------

  getSemantics(): CoordinatorSemantics {
    return {
      consistency: 'strong',
      persistence: 'durable',
      failureTolerance: 1,
      leaseSupport: true,
      watchSupport: true,
      maxLeaseTtlMs: 60000,
    };
  }

  async initialize(nodeId: string, ringId: RingId, config?: Record<string, any>): Promise<void> {
    this.nodeId = nodeId;
    this.ringId = ringId;
    this.logger = createLogger(config?.logging);

    // Create a lease for this node's registration key
    this.nodeLease = await this.client.lease(LEASE_TTL_SECONDS);
    this.nodeLease.keepalive();

    const nodeInfo = JSON.stringify({
      nodeId,
      ringId,
      lastSeen: Date.now(),
      metadata: config?.metadata ?? {},
      isAlive: true
    });

    await this.client.put(nodeKey(nodeId), nodeInfo);

    // If the client supports lease attachment, bind the key
    if ('attachToLease' in this.client && typeof (this.client as any).attachToLease === 'function') {
      (this.client as any).attachToLease(this.nodeLease.id, nodeKey(nodeId));
    }

    this.logger.coordinator(`EtcdCoordinator initialized for node ${nodeId} in ring ${ringId}`);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.logger.coordinator(`Starting EtcdCoordinator for node ${this.nodeId}`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    this.nodeWatcher?.cancel();
    this.nodeWatcher = null;
    this.rangeWatcher?.cancel();
    this.rangeWatcher = null;

    this.started = false;
    this.logger.coordinator(`Stopped EtcdCoordinator for node ${this.nodeId}`);
  }

  async joinCluster(_seedNodes: string[]): Promise<void> {
    this.logger.coordinator(`Node ${this.nodeId} joining cluster via etcd`);

    // Start watching node registrations
    this.nodeWatcher = this.client.watch(nodesPrefix(), (event) => {
      if (event.type === 'put') {
        try {
          const info = JSON.parse(event.value);
          if (info.nodeId && info.nodeId !== this.nodeId) {
            this.clusterVersion++;
            this.emit('node-joined', info.nodeId);
            this.emitTopologyChanged();
          }
        } catch { /* ignore malformed */ }
      } else if (event.type === 'delete') {
        const parts = event.key.split('/');
        const removedNodeId = parts[parts.length - 1];
        if (removedNodeId && removedNodeId !== this.nodeId) {
          this.clusterVersion++;
          this.emit('node-left', removedNodeId);
          this.emitTopologyChanged();
        }
      }
    });

    // Start watching range assignments
    this.rangeWatcher = this.client.watch(rangesPrefix(), (event) => {
      if (event.type === 'put') {
        try {
          const lease: RangeLease = JSON.parse(event.value);
          if (lease.nodeId === this.nodeId) {
            this.emit('range-acquired', lease.rangeId);
          }
        } catch { /* ignore */ }
      } else if (event.type === 'delete') {
        const parts = event.key.split('/');
        const deletedRangeId = parts[parts.length - 1];
        this.emit('range-released', deletedRangeId);
      }
      this.clusterVersion++;
      this.emitTopologyChanged();
    });

    // Emit join for self
    this.emit('node-joined', this.nodeId);
  }

  async leaveCluster(): Promise<void> {
    this.logger.coordinator(`Node ${this.nodeId} leaving cluster via etcd`);

    // Release all range leases
    for (const [rangeId, lease] of this.rangeLeases) {
      await lease.revoke();
      this.rangeLeases.delete(rangeId);
    }

    // Delete node key and revoke node lease
    await this.client.delete(nodeKey(this.nodeId));
    if (this.nodeLease) {
      await this.nodeLease.revoke();
      this.nodeLease = null;
    }

    this.nodeWatcher?.cancel();
    this.nodeWatcher = null;
    this.rangeWatcher?.cancel();
    this.rangeWatcher = null;

    this.emit('node-left', this.nodeId);
  }

  async acquireLease(rangeId: RangeId): Promise<boolean> {
    this.logger.coordinator(`EtcdCoordinator attempting to acquire lease for range ${rangeId}`);

    // Check if someone else already owns this range
    const existing = await this.client.get(rangeKey(rangeId));
    if (existing) {
      try {
        const lease: RangeLease = JSON.parse(existing);
        if (lease.nodeId !== this.nodeId) {
          this.emit('lease-conflict', rangeId, lease.nodeId);
          return false;
        }
        // We already own it -- treat as success
        return true;
      } catch { /* corrupted entry, overwrite */ }
    }

    const lease = await this.client.lease(LEASE_TTL_SECONDS);
    lease.keepalive();

    const rangeLease: RangeLease = {
      rangeId,
      nodeId: this.nodeId,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + LEASE_TTL_SECONDS * 1000,
      version: this.clusterVersion
    };

    await this.client.put(rangeKey(rangeId), JSON.stringify(rangeLease));

    if ('attachToLease' in this.client && typeof (this.client as any).attachToLease === 'function') {
      (this.client as any).attachToLease(lease.id, rangeKey(rangeId));
    }

    this.rangeLeases.set(rangeId, lease);
    return true;
  }

  async releaseLease(rangeId: RangeId): Promise<void> {
    this.logger.coordinator(`EtcdCoordinator releasing lease for range ${rangeId}`);

    const lease = this.rangeLeases.get(rangeId);
    if (lease) {
      await lease.revoke();
      this.rangeLeases.delete(rangeId);
    } else {
      await this.client.delete(rangeKey(rangeId));
    }
  }

  async ownsRange(rangeId: RangeId): Promise<boolean> {
    const raw = await this.client.get(rangeKey(rangeId));
    if (!raw) return false;
    try {
      const lease: RangeLease = JSON.parse(raw);
      return lease.nodeId === this.nodeId;
    } catch {
      return false;
    }
  }

  async getOwnedRanges(): Promise<RangeId[]> {
    const owned: RangeId[] = [];
    const allRanges = this.getPrefixEntries(rangesPrefix());
    for (const [, value] of allRanges) {
      try {
        const lease: RangeLease = JSON.parse(value);
        if (lease.nodeId === this.nodeId) {
          owned.push(lease.rangeId);
        }
      } catch { /* skip */ }
    }
    return owned;
  }

  async getClusterView(): Promise<ClusterView> {
    const nodes = new Map<string, CoordinatorNodeStatus>();
    const leases = new Map<RangeId, RangeLease>();

    const allNodes = this.getPrefixEntries(nodesPrefix());
    for (const [, value] of allNodes) {
      try {
        const info = JSON.parse(value);
        nodes.set(info.nodeId, {
          nodeId: info.nodeId,
          lastSeen: info.lastSeen ?? Date.now(),
          metadata: info.metadata ?? {},
          isAlive: info.isAlive ?? true
        });
      } catch { /* skip */ }
    }

    const allRanges = this.getPrefixEntries(rangesPrefix());
    for (const [, value] of allRanges) {
      try {
        const lease: RangeLease = JSON.parse(value);
        leases.set(lease.rangeId, lease);
      } catch { /* skip */ }
    }

    return {
      nodes,
      leases,
      ringId: this.ringId,
      version: this.clusterVersion,
      lastUpdated: Date.now()
    };
  }

  // -- helpers --------------------------------------------------------------

  private getPrefixEntries(prefix: string): Map<string, string> {
    // If the client exposes getPrefix (InMemoryEtcdClient), use it directly.
    if ('getPrefix' in this.client && typeof (this.client as any).getPrefix === 'function') {
      return (this.client as any).getPrefix(prefix);
    }
    // For real etcd clients a range-read would be used; here we return empty.
    return new Map();
  }

  private async emitTopologyChanged(): Promise<void> {
    try {
      const view = await this.getClusterView();
      this.emit('topology-changed', view);
    } catch { /* swallow errors during topology broadcast */ }
  }
}
