import { EventEmitter } from 'events';
import { EntityRegistry } from '../entity/types';
import { MetricsRegistry } from '../../monitoring/metrics/MetricsRegistry';
import { TimeoutError, NotOwnedError } from '../../common/errors';
import { defaultLogger } from '../../common/logger';

/**
 * Handle returned by a successful lock acquisition.
 *
 * `fencingToken` is a strictly-monotonically-increasing integer per `lockId`.
 * Implementations must guarantee that any later acquire of the same `lockId`
 * (by any node) returns a strictly larger token. Counters are persisted into
 * the underlying `EntityRegistry` (via a sidecar entity, see
 * `__fence__:<lockId>`), so monotonicity survives lock release / re-acquire,
 * lock TTL expiry, and node restarts that share the same registry. The
 * counter is only reset by explicit registry truncation (e.g. starting from a
 * fresh in-memory registry on every node).
 *
 * Standard usage: include the token in any side-effect you want guarded; a
 * downstream acceptance gate compares the held token to the highest seen
 * token per resource and rejects writes whose token is lower (Kleppmann
 * fencing-token pattern).
 */
export interface LockHandle {
  lockId: string;
  nodeId: string;
  acquiredAt: number;
  expiresAt: number;
  fencingToken: bigint;
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

/**
 * Sidecar entity-id prefix used to persist the per-lockId fencing-token
 * counter. The sidecar is written via `applyRemoteUpdate` (so it is not bound
 * to local ownership) and is intentionally never released.
 */
const FENCE_PREFIX = '__fence__:';
function fenceEntityId(lockId: string): string {
  return `${FENCE_PREFIX}${lockId}`;
}

export class DistributedLock extends EventEmitter {
  private readonly registry: EntityRegistry;
  private readonly localNodeId: string;
  private readonly config: Required<Omit<DistributedLockConfig, 'metrics'>>;
  private readonly metrics: MetricsRegistry | null;
  private readonly heldLocks = new Map<string, LockHandle>();
  private readonly ttlTimers = new Map<string, NodeJS.Timeout>();

  constructor(registry: EntityRegistry, localNodeId: string, config?: DistributedLockConfig) {
    super();
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
      // Propose the lock first; only bump the fencing-token counter on
      // successful acquisition. This keeps "one bump per successful acquire"
      // while preserving monotonicity (a fresh acquire always reads the
      // last persisted token before incrementing).
      const record = await this.registry.proposeEntity(lockId, {
        ttlMs: ttl,
        lockedBy: this.localNodeId,
      });
      const fencingToken = await this._bumpFencingToken(lockId);
      // Stamp the lock entity's metadata too so the token is observable to
      // anyone inspecting the registry directly.
      try {
        await this.registry.updateEntity(lockId, {
          ttlMs: ttl,
          lockedBy: this.localNodeId,
          fencingToken: fencingToken.toString(),
        });
      } catch {
        // Best-effort — sidecar is the source of truth.
      }
      const handle: LockHandle = {
        lockId,
        nodeId: this.localNodeId,
        acquiredAt: record.createdAt,
        expiresAt: record.createdAt + ttl,
        fencingToken,
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
    // Extend bumps the fencing token too — every successful extend yields a
    // fresh, strictly-larger token, so a deposed-then-resumed leader cannot
    // re-use a stale handle.
    const fencingToken = await this._bumpFencingToken(lockId);
    const updated: LockHandle = { ...lockHandle, expiresAt: newExpiresAt, fencingToken };
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
   * Read the current (highest-seen) fencing token for `lockId` from the
   * registry sidecar, or `0n` if no acquire has ever happened. Useful for
   * acceptance-gate implementations that need to compare a presented token
   * against the latest known.
   */
  getCurrentFencingToken(lockId: string): bigint {
    const fence = this.registry.getEntity(fenceEntityId(lockId));
    if (fence === null) return 0n;
    const raw = (fence.metadata as Record<string, unknown> | undefined)?.fencingToken;
    if (typeof raw === 'string') {
      try {
        return BigInt(raw);
      } catch {
        return 0n;
      }
    }
    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number') return BigInt(raw);
    return 0n;
  }

  /**
   * Externally triggered cleanup when a remote node is detected as failed.
   * Iterates all known registry entities owned by `nodeId`, applies a DELETE
   * remote update so local state converges, and removes any locally-tracked
   * lock handles for that node.
   * Returns the count of locks cleaned up.
   *
   * Fence-sidecar entities (`__fence__:*`) are intentionally NOT cleaned up —
   * they must persist across owner changes to preserve monotonicity.
   */
  handleRemoteNodeFailure(nodeId: string): number {
    const victims = this.registry
      .getAllKnownEntities()
      .filter((e) => e.ownerNodeId === nodeId && !e.entityId.startsWith(FENCE_PREFIX));

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

  /**
   * Read-then-write the per-lockId fencing-token sidecar. Returns the new
   * token. Cross-node monotonicity holds because every node reads through the
   * same registry view; write contention is rare in practice (acquire is
   * already serialized by `proposeEntity` for `DistributedLock`).
   */
  private async _bumpFencingToken(lockId: string): Promise<bigint> {
    const current = this.getCurrentFencingToken(lockId);
    const next = current + 1n;
    const fenceId = fenceEntityId(lockId);
    const exists = this.registry.getEntity(fenceId) !== null;
    const now = Date.now();
    // Use `applyRemoteUpdate` so we don't need ownership of the sidecar; the
    // version field is the integer view of the bigint counter — safe up to
    // 2^53 - 1 acquisitions per lockId, well beyond any realistic workload.
    await this.registry.applyRemoteUpdate({
      entityId: fenceId,
      ownerNodeId: this.localNodeId,
      version: Number(next),
      timestamp: now,
      operation: exists ? 'UPDATE' : 'CREATE',
      metadata: { fencingToken: next.toString() },
    });
    return next;
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
    this.registry.releaseEntity(lockId).catch((err: unknown) => {
      defaultLogger.warn(`[DistributedLock] release on TTL expiry failed for ${lockId}`, err);
      this.emit('lock:release-failed', { lockId, reason: 'ttl-expiry-cleanup', error: err });
      this.metrics?.counter('lock.release_failed.count').inc();
    });
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
