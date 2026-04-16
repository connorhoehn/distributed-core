import { EventEmitter } from 'events';
import {
  IClusterCoordinator,
  CoordinatorSemantics,
  ClusterView,
  RangeId,
  RingId,
  RangeLease,
  CoordinatorNodeStatus,
  ClusterFrameworkEvents
} from './types';
import { createLogger, FrameworkLogger } from '../common/logger';

/**
 * Pluggable ZooKeeper client interface.
 * Implement this to connect to a real ZooKeeper ensemble,
 * or use InMemoryZookeeperClient for testing.
 */
export interface IZookeeperClient {
  create(path: string, data: string, mode?: 'persistent' | 'ephemeral' | 'sequential'): Promise<string>;
  getData(path: string): Promise<{ data: string; version: number } | null>;
  setData(path: string, data: string, version?: number): Promise<void>;
  delete(path: string, version?: number): Promise<void>;
  getChildren(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  watch(path: string, callback: (event: { type: 'created' | 'deleted' | 'changed'; path: string }) => void): { cancel: () => void };
}

const BASE_PATH = '/distributed-core';
const NODES_PATH = `${BASE_PATH}/nodes`;
const RANGES_PATH = `${BASE_PATH}/ranges`;

/**
 * In-memory implementation of IZookeeperClient for testing.
 */
export class InMemoryZookeeperClient implements IZookeeperClient {
  private store = new Map<string, { data: string; version: number; mode: 'persistent' | 'ephemeral' | 'sequential' }>();
  private watchers = new Map<string, Set<(event: { type: 'created' | 'deleted' | 'changed'; path: string }) => void>>();
  private sequentialCounters = new Map<string, number>();

  async create(path: string, data: string, mode: 'persistent' | 'ephemeral' | 'sequential' = 'persistent'): Promise<string> {
    let actualPath = path;

    if (mode === 'sequential') {
      const counter = (this.sequentialCounters.get(path) ?? 0);
      this.sequentialCounters.set(path, counter + 1);
      actualPath = `${path}${String(counter).padStart(10, '0')}`;
    }

    if (this.store.has(actualPath)) {
      throw new Error(`Node already exists: ${actualPath}`);
    }

    // Ensure parent path exists (auto-create persistent parents)
    const parentPath = actualPath.substring(0, actualPath.lastIndexOf('/'));
    if (parentPath && !this.store.has(parentPath)) {
      await this.ensurePath(parentPath);
    }

    this.store.set(actualPath, { data, version: 0, mode });
    this.notifyWatchers(parentPath, 'created', actualPath);
    return actualPath;
  }

  async getData(path: string): Promise<{ data: string; version: number } | null> {
    const node = this.store.get(path);
    if (!node) return null;
    return { data: node.data, version: node.version };
  }

  async setData(path: string, data: string, version?: number): Promise<void> {
    const node = this.store.get(path);
    if (!node) {
      throw new Error(`Node does not exist: ${path}`);
    }
    if (version !== undefined && node.version !== version) {
      throw new Error(`Version mismatch: expected ${version}, got ${node.version}`);
    }
    node.data = data;
    node.version++;
    this.notifyWatchers(path, 'changed', path);
  }

  async delete(path: string, version?: number): Promise<void> {
    const node = this.store.get(path);
    if (!node) return;
    if (version !== undefined && node.version !== version) {
      throw new Error(`Version mismatch: expected ${version}, got ${node.version}`);
    }
    this.store.delete(path);
    const parentPath = path.substring(0, path.lastIndexOf('/'));
    this.notifyWatchers(parentPath, 'deleted', path);
  }

  async getChildren(path: string): Promise<string[]> {
    const prefix = path === '/' ? '/' : `${path}/`;
    const children: string[] = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix) && key !== path) {
        const rest = key.slice(prefix.length);
        // Only direct children (no further slashes)
        if (!rest.includes('/')) {
          children.push(rest);
        }
      }
    }
    return children;
  }

  async exists(path: string): Promise<boolean> {
    return this.store.has(path);
  }

  watch(path: string, callback: (event: { type: 'created' | 'deleted' | 'changed'; path: string }) => void): { cancel: () => void } {
    if (!this.watchers.has(path)) {
      this.watchers.set(path, new Set());
    }
    this.watchers.get(path)!.add(callback);
    return {
      cancel: () => {
        const set = this.watchers.get(path);
        if (set) {
          set.delete(callback);
          if (set.size === 0) this.watchers.delete(path);
        }
      }
    };
  }

  /** Clear all state (useful between tests). */
  reset(): void {
    this.store.clear();
    this.watchers.clear();
    this.sequentialCounters.clear();
  }

  private async ensurePath(path: string): Promise<void> {
    if (!path || path === '/') return;
    const parent = path.substring(0, path.lastIndexOf('/'));
    if (parent && !this.store.has(parent)) {
      await this.ensurePath(parent);
    }
    if (!this.store.has(path)) {
      this.store.set(path, { data: '', version: 0, mode: 'persistent' });
    }
  }

  private notifyWatchers(watchedPath: string, type: 'created' | 'deleted' | 'changed', eventPath: string): void {
    const set = this.watchers.get(watchedPath);
    if (set) {
      for (const cb of set) {
        cb({ type, path: eventPath });
      }
    }
  }
}

/**
 * ZooKeeper-based cluster coordinator.
 *
 * Uses a pluggable IZookeeperClient so the coordinator logic can be tested
 * with InMemoryZookeeperClient and run in production against a real ensemble.
 *
 * ZooKeeper paths:
 *   /distributed-core/nodes/{nodeId}          -- ephemeral node registration
 *   /distributed-core/ranges/{rangeId}/lock-  -- ephemeral sequential lock nodes
 */
export class ZookeeperCoordinator extends EventEmitter implements IClusterCoordinator {
  private client: IZookeeperClient;
  private logger!: FrameworkLogger;
  private nodeId!: string;
  private ringId!: RingId;
  private started = false;

  /** rangeId -> the sequential lock znode path this node created */
  private lockPaths = new Map<string, string>();
  private ownedRanges = new Set<RangeId>();
  private nodesWatcher?: { cancel: () => void };
  private heartbeatInterval?: NodeJS.Timeout;
  private leaseTimeoutMs = 30000;

  constructor(client: IZookeeperClient) {
    super();
    this.client = client;
  }

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

    if (config?.leaseTimeoutMs) {
      this.leaseTimeoutMs = config.leaseTimeoutMs;
    }

    // Ensure base paths exist
    await this.ensureBasePaths();

    // Create ephemeral node for this member
    const nodePath = `${NODES_PATH}/${this.nodeId}`;
    const nodeData = JSON.stringify({
      nodeId: this.nodeId,
      ringId: this.ringId,
      lastSeen: Date.now(),
      metadata: config?.metadata ?? {},
      isAlive: true
    });

    if (await this.client.exists(nodePath)) {
      await this.client.setData(nodePath, nodeData);
    } else {
      await this.client.create(nodePath, nodeData, 'ephemeral');
    }

    this.logger.coordinator(`ZookeeperCoordinator initialized for node ${nodeId} in ring ${ringId}`);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Heartbeat to keep our node data fresh
    const heartbeatMs = this.leaseTimeoutMs < 5000 ? 50 : 5000;
    this.heartbeatInterval = setInterval(() => this.updateHeartbeat(), heartbeatMs);
    this.heartbeatInterval.unref();

    this.logger.coordinator(`ZookeeperCoordinator started for node ${this.nodeId}`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    if (this.nodesWatcher) {
      this.nodesWatcher.cancel();
      this.nodesWatcher = undefined;
    }

    await this.leaveCluster();
    this.logger.coordinator(`ZookeeperCoordinator stopped for node ${this.nodeId}`);
  }

  async joinCluster(seedNodes: string[]): Promise<void> {
    this.logger.coordinator(`Node ${this.nodeId} joining cluster with seeds: ${seedNodes.join(', ')}`);

    // Register seed nodes that don't exist yet (simulates awareness of cluster)
    for (const seed of seedNodes) {
      if (seed !== this.nodeId) {
        const seedPath = `${NODES_PATH}/${seed}`;
        if (!(await this.client.exists(seedPath))) {
          const seedData = JSON.stringify({
            nodeId: seed,
            ringId: this.ringId,
            lastSeen: Date.now(),
            metadata: {},
            isAlive: true
          });
          await this.client.create(seedPath, seedData, 'ephemeral');
        }
      }
    }

    // Watch the nodes path for membership changes
    this.nodesWatcher = this.client.watch(NODES_PATH, (event) => {
      if (event.type === 'created') {
        const childName = event.path.split('/').pop()!;
        this.emit('node-joined', childName);
      } else if (event.type === 'deleted') {
        const childName = event.path.split('/').pop()!;
        this.emit('node-left', childName);
      }
      this.getClusterView().then((view) => {
        this.emit('topology-changed', view);
      });
    });

    this.emit('node-joined', this.nodeId);
  }

  async leaveCluster(): Promise<void> {
    this.logger.coordinator(`Node ${this.nodeId} leaving cluster`);

    // Release all owned ranges
    const ranges = Array.from(this.ownedRanges);
    for (const rangeId of ranges) {
      await this.releaseLease(rangeId);
    }

    // Delete our ephemeral node
    const nodePath = `${NODES_PATH}/${this.nodeId}`;
    if (await this.client.exists(nodePath)) {
      await this.client.delete(nodePath);
    }

    this.emit('node-left', this.nodeId);
  }

  async acquireLease(rangeId: RangeId): Promise<boolean> {
    this.logger.coordinator(`Attempting to acquire lease for range ${rangeId}`);

    // If we already own this range, return true
    if (this.ownedRanges.has(rangeId)) {
      this.logger.coordinator(`Already own lease for range ${rangeId}`);
      return true;
    }

    const rangeLockPath = `${RANGES_PATH}/${rangeId}/lock-`;

    // Ensure the range directory exists
    const rangeDirPath = `${RANGES_PATH}/${rangeId}`;
    if (!(await this.client.exists(rangeDirPath))) {
      try {
        await this.client.create(rangeDirPath, '', 'persistent');
      } catch {
        // Another node may have created it concurrently
      }
    }

    // Create an ephemeral sequential node for our lock attempt
    const lockData = JSON.stringify({
      nodeId: this.nodeId,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + this.leaseTimeoutMs
    });

    const createdPath = await this.client.create(rangeLockPath, lockData, 'sequential');

    // Get all children to determine if we hold the lowest sequence number
    const children = await this.client.getChildren(rangeDirPath);
    const lockChildren = children.filter(c => c.startsWith('lock-')).sort();

    const ourChild = createdPath.split('/').pop()!;

    if (lockChildren.length > 0 && lockChildren[0] === ourChild) {
      // We have the lowest sequence -- we hold the lock
      this.lockPaths.set(rangeId, createdPath);
      this.ownedRanges.add(rangeId);
      this.logger.coordinator(`Successfully acquired lease for range ${rangeId}`);
      this.emit('range-acquired', rangeId);
      return true;
    } else {
      // We do not hold the lock -- clean up our node
      await this.client.delete(createdPath);
      const existingOwnerChild = lockChildren[0];
      const existingOwnerPath = `${rangeDirPath}/${existingOwnerChild}`;
      const ownerData = await this.client.getData(existingOwnerPath);
      if (ownerData) {
        try {
          const parsed = JSON.parse(ownerData.data);
          this.emit('lease-conflict', rangeId, parsed.nodeId);
        } catch {
          // ignore parse errors
        }
      }
      this.logger.coordinator(`Failed to acquire lease for range ${rangeId}: another node holds it`);
      return false;
    }
  }

  async releaseLease(rangeId: RangeId): Promise<void> {
    this.logger.coordinator(`Releasing lease for range ${rangeId}`);

    const lockPath = this.lockPaths.get(rangeId);
    if (lockPath) {
      if (await this.client.exists(lockPath)) {
        await this.client.delete(lockPath);
      }
      this.lockPaths.delete(rangeId);
    }

    if (this.ownedRanges.has(rangeId)) {
      this.ownedRanges.delete(rangeId);
      this.emit('range-released', rangeId);
      this.logger.coordinator(`Released lease for range ${rangeId}`);
    }
  }

  async getClusterView(): Promise<ClusterView> {
    const nodes = new Map<string, CoordinatorNodeStatus>();
    const leases = new Map<RangeId, RangeLease>();

    // Read all nodes
    const nodeChildren = await this.client.getChildren(NODES_PATH);
    for (const child of nodeChildren) {
      const data = await this.client.getData(`${NODES_PATH}/${child}`);
      if (data) {
        try {
          const parsed = JSON.parse(data.data);
          nodes.set(child, {
            nodeId: parsed.nodeId ?? child,
            lastSeen: parsed.lastSeen ?? Date.now(),
            metadata: parsed.metadata ?? {},
            isAlive: parsed.isAlive ?? true
          });
        } catch {
          nodes.set(child, {
            nodeId: child,
            lastSeen: Date.now(),
            metadata: {},
            isAlive: true
          });
        }
      }
    }

    // Read all range leases
    const rangeChildren = await this.client.getChildren(RANGES_PATH);
    for (const rangeId of rangeChildren) {
      const rangeDirPath = `${RANGES_PATH}/${rangeId}`;
      const lockChildren = (await this.client.getChildren(rangeDirPath))
        .filter(c => c.startsWith('lock-'))
        .sort();

      if (lockChildren.length > 0) {
        const lockPath = `${rangeDirPath}/${lockChildren[0]}`;
        const lockData = await this.client.getData(lockPath);
        if (lockData) {
          try {
            const parsed = JSON.parse(lockData.data);
            leases.set(rangeId, {
              rangeId,
              nodeId: parsed.nodeId,
              acquiredAt: parsed.acquiredAt,
              expiresAt: parsed.expiresAt,
              version: lockData.version
            });
          } catch {
            // skip malformed data
          }
        }
      }
    }

    return {
      nodes,
      leases,
      ringId: this.ringId,
      version: Date.now(),
      lastUpdated: Date.now()
    };
  }

  async getOwnedRanges(): Promise<RangeId[]> {
    return Array.from(this.ownedRanges);
  }

  async ownsRange(rangeId: RangeId): Promise<boolean> {
    return this.ownedRanges.has(rangeId);
  }

  private async ensureBasePaths(): Promise<void> {
    for (const path of [BASE_PATH, NODES_PATH, RANGES_PATH]) {
      if (!(await this.client.exists(path))) {
        try {
          await this.client.create(path, '', 'persistent');
        } catch {
          // May already exist from concurrent initialization
        }
      }
    }
  }

  private async updateHeartbeat(): Promise<void> {
    if (!this.started) return;
    const nodePath = `${NODES_PATH}/${this.nodeId}`;
    try {
      const existing = await this.client.getData(nodePath);
      if (existing) {
        const parsed = JSON.parse(existing.data);
        parsed.lastSeen = Date.now();
        await this.client.setData(nodePath, JSON.stringify(parsed), existing.version);
      }
    } catch {
      // Heartbeat failure is non-fatal
    }
  }
}
