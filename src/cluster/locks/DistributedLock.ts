import { EntityRegistry } from '../entity/types';
import { MetricsRegistry } from '../../monitoring/metrics/MetricsRegistry';
import { TimeoutError, NotOwnedError } from '../../common/errors';

export interface LockHandle {
  lockId: string;
  nodeId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface DistributedLockConfig {
  defaultTtlMs?: number;
  acquireTimeoutMs?: number;
  retryIntervalMs?: number;
  metrics?: MetricsRegistry;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_INTERVAL_MS = 100;

export class DistributedLock {
  private readonly registry: EntityRegistry;
  private readonly localNodeId: string;
  private readonly config: Required<Omit<DistributedLockConfig, 'metrics'>>;
  private readonly metrics: MetricsRegistry | null;
  private readonly heldLocks = new Map<string, LockHandle>();
  private readonly ttlTimers = new Map<string, NodeJS.Timeout>();

  constructor(registry: EntityRegistry, localNodeId: string, config?: DistributedLockConfig) {
    this.registry = registry;
    this.localNodeId = localNodeId;
    this.metrics = config?.metrics ?? null;
    this.config = {
      defaultTtlMs: config?.defaultTtlMs ?? DEFAULT_TTL_MS,
      acquireTimeoutMs: config?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
      retryIntervalMs: config?.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS,
    };
  }

  async tryAcquire(lockId: string, options?: { ttlMs?: number }): Promise<LockHandle | null> {
    const ttl = options?.ttlMs ?? this.config.defaultTtlMs;
    const start = Date.now();
    try {
      const record = await this.registry.proposeEntity(lockId, { ttlMs: ttl, lockedBy: this.localNodeId });
      const handle: LockHandle = {
        lockId,
        nodeId: this.localNodeId,
        acquiredAt: record.createdAt,
        expiresAt: record.createdAt + ttl,
      };
      this.heldLocks.set(lockId, handle);
      this._scheduleTtl(lockId, ttl);
      this.metrics?.counter('lock.acquire.count', { result: 'success' }).inc();
      this.metrics?.histogram('lock.acquire.latency_ms').observe(Date.now() - start);
      this.metrics?.gauge('lock.hold.gauge').set(this.heldLocks.size);
      return handle;
    } catch {
      this.metrics?.counter('lock.acquire.count', { result: 'fail' }).inc();
      return null;
    }
  }

  async acquire(lockId: string, options?: { ttlMs?: number }): Promise<LockHandle> {
    const deadline = Date.now() + this.config.acquireTimeoutMs;
    while (true) {
      const handle = await this.tryAcquire(lockId, options);
      if (handle !== null) {
        return handle;
      }
      if (Date.now() + this.config.retryIntervalMs > deadline) {
        this.metrics?.counter('lock.acquire.count', { result: 'timeout' }).inc();
        throw new TimeoutError(`acquire lock "${lockId}"`, this.config.acquireTimeoutMs);
      }
      await this._sleep(this.config.retryIntervalMs);
    }
  }

  async release(lockHandle: LockHandle): Promise<void> {
    const { lockId } = lockHandle;
    if (!this.heldLocks.has(lockId)) {
      return;
    }
    this._clearTimer(lockId);
    this.heldLocks.delete(lockId);
    await this.registry.releaseEntity(lockId);
    this.metrics?.gauge('lock.hold.gauge').set(this.heldLocks.size);
  }

  async extend(lockHandle: LockHandle, additionalMs?: number): Promise<LockHandle> {
    const { lockId } = lockHandle;
    if (!this.heldLocks.has(lockId) || this.registry.getEntityHost(lockId) === null) {
      throw new NotOwnedError(lockId);
    }
    const extra = additionalMs ?? this.config.defaultTtlMs;
    this._clearTimer(lockId);
    const newExpiresAt = Date.now() + extra;
    const updated: LockHandle = { ...lockHandle, expiresAt: newExpiresAt };
    this.heldLocks.set(lockId, updated);
    this._scheduleTtl(lockId, extra);
    this.metrics?.counter('lock.extend.count').inc();
    return updated;
  }

  isHeldLocally(lockId: string): boolean {
    return this.heldLocks.has(lockId);
  }

  isHeldByAny(lockId: string): boolean {
    return this.registry.getEntityHost(lockId) !== null;
  }

  getHeldLocks(): LockHandle[] {
    return Array.from(this.heldLocks.values());
  }

  /**
   * Externally triggered cleanup when a remote node is detected as failed.
   * Iterates all known registry entities owned by `nodeId`, applies a DELETE
   * remote update so local state converges, and removes any locally-tracked
   * lock handles for that node.
   * Returns the count of locks cleaned up.
   */
  handleRemoteNodeFailure(nodeId: string): number {
    const victims = this.registry
      .getAllKnownEntities()
      .filter((e) => e.ownerNodeId === nodeId);

    for (const entity of victims) {
      void this.registry.applyRemoteUpdate({
        entityId: entity.entityId,
        ownerNodeId: entity.ownerNodeId,
        version: Date.now(),
        timestamp: Date.now(),
        operation: 'DELETE',
        metadata: {},
      });
      // Clear any locally-tracked handle for this lockId (defensive — normally
      // only local-node locks are in heldLocks, but guards against edge cases).
      this._clearTimer(entity.entityId);
      this.heldLocks.delete(entity.entityId);
    }

    return victims.length;
  }

  private _scheduleTtl(lockId: string, ttlMs: number): void {
    this._clearTimer(lockId);
    const timer = setTimeout(() => this._onExpired(lockId), ttlMs);
    timer.unref();
    this.ttlTimers.set(lockId, timer);
  }

  private _clearTimer(lockId: string): void {
    const timer = this.ttlTimers.get(lockId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.ttlTimers.delete(lockId);
    }
  }

  private _onExpired(lockId: string): void {
    this.ttlTimers.delete(lockId);
    this.heldLocks.delete(lockId);
    this.metrics?.counter('lock.expired.count').inc();
    this.metrics?.gauge('lock.hold.gauge').set(this.heldLocks.size);
    this.registry.releaseEntity(lockId).catch(() => {});
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const t = setTimeout(resolve, ms);
      if (typeof t === 'object' && t !== null && 'unref' in t) {
        (t as NodeJS.Timeout).unref();
      }
    });
  }
}
