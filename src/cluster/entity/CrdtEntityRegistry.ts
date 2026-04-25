import { EventEmitter } from 'eventemitter3';
import {
  EntityRegistry,
  EntityRecord,
  EntitySnapshot,
  EntityUpdate,
} from './types';
import { EntityNotFoundError, EntityAlreadyExistsError, NotStartedError, NotOwnedByNodeError } from '../../common/errors';

/**
 * Internal record enriched with a logical clock timestamp used for CRDT
 * last-write-wins merge decisions.
 */
interface CrdtEntry {
  record: EntityRecord;
  /** Logical clock value at the time this entry was last written. */
  logicalTs: number;
  /** Node ID that produced this entry — used to break logical-clock ties. */
  authorNodeId: string;
}

/**
 * Tombstone metadata. `deletedAt` is wall-clock millis used for TTL eviction,
 * separate from `logicalTs` which is the Lamport timestamp used for LWW merge.
 */
interface CrdtTombstone {
  logicalTs: number;
  authorNodeId: string;
  /** Wall-clock millis when the tombstone was recorded locally. */
  deletedAt: number;
}

/**
 * Configuration for CrdtEntityRegistry tombstone TTL and compaction.
 *
 * RESURRECTION-WINDOW CONTRACT (AP/CP tradeoff — explicit by design):
 *   With `tombstoneTTLMs = Infinity` (default) the registry is strongly
 *   convergent: tombstones are retained forever and a stale CREATE for a
 *   deleted entityId can NEVER resurrect it.
 *
 *   With a finite `tombstoneTTLMs`, tombstones are evicted after that many
 *   wall-clock millis. A node that has been partitioned for longer than the
 *   TTL and then rejoins MAY observe a re-creation of the same entityId —
 *   this is the explicit resurrection window. Operators trade unbounded
 *   memory growth for a bounded re-creation risk and MUST size the TTL
 *   larger than the worst-case partition / sync lag.
 */
export interface CrdtRegistryOptions {
  /**
   * Time-to-live for tombstones in millis. Defaults to `Number.POSITIVE_INFINITY`
   * (preserve "tombstones forever" semantics). Set to a finite value to cap
   * memory; this opens a resurrection window of size `tombstoneTTLMs`.
   */
  tombstoneTTLMs?: number;

  /**
   * Compaction sweep interval in millis. Defaults to 60_000.
   * The sweep evicts tombstones older than `tombstoneTTLMs` and updateLog
   * entries older than `updateLogRetentionMs`.
   */
  compactionIntervalMs?: number;

  /**
   * Retention window for entries in `updateLog` in millis.
   * Defaults to `Number.POSITIVE_INFINITY` (retain forever — preserves current
   * `getUpdatesAfter` semantics for catch-up sync).
   */
  updateLogRetentionMs?: number;
}

/**
 * CrdtEntityRegistry — last-write-wins entity registry using logical timestamps.
 *
 * Concurrency semantics:
 *  - Every mutation increments a per-node logical clock that is piggybacked on
 *    the EntityUpdate version field.
 *  - On `applyRemoteUpdate`, the incoming logical timestamp is compared with the
 *    local one. Higher logical timestamp wins; on a tie, lexicographically higher
 *    nodeId wins (deterministic across all nodes).
 *  - DELETE is treated as a tombstone entry: the entity is removed from the live
 *    map and the tombstone logical timestamp is retained so stale CREATE/UPDATE
 *    updates arriving out of order do not resurrect it.
 */
export class CrdtEntityRegistry extends EventEmitter implements EntityRegistry {
  private readonly entries: Map<string, CrdtEntry> = new Map();
  /**
   * Tombstones: entityId -> { logicalTs, authorNodeId, deletedAt } for deleted entities.
   * Prevents out-of-order CREATE/UPDATE updates from resurrecting deleted entities,
   * subject to the configured `tombstoneTTLMs`.
   */
  private readonly tombstones: Map<string, CrdtTombstone> = new Map();
  private readonly updateLog: EntityUpdate[] = [];

  private readonly nodeId: string;
  private isRunning = false;

  /** Logical clock — monotonically increasing per-node counter. */
  private logicalClock = 0;

  // Compaction config + timer state
  private readonly tombstoneTTLMs: number;
  private readonly compactionIntervalMs: number;
  private readonly updateLogRetentionMs: number;
  private compactionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(nodeId: string, options: CrdtRegistryOptions = {}) {
    super();
    this.nodeId = nodeId;
    this.tombstoneTTLMs = options.tombstoneTTLMs ?? Number.POSITIVE_INFINITY;
    this.compactionIntervalMs = options.compactionIntervalMs ?? 60_000;
    this.updateLogRetentionMs = options.updateLogRetentionMs ?? Number.POSITIVE_INFINITY;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.isRunning = true;
    this.startCompactionTimer();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.stopCompactionTimer();
  }

  private startCompactionTimer(): void {
    if (this.compactionTimer !== null) return;
    // Skip the timer entirely if both retention windows are infinite — there
    // would be nothing to evict. Avoids unnecessary timer pressure.
    if (
      this.tombstoneTTLMs === Number.POSITIVE_INFINITY &&
      this.updateLogRetentionMs === Number.POSITIVE_INFINITY
    ) {
      return;
    }
    this.compactionTimer = setInterval(() => {
      try {
        this.compact();
      } catch (err: unknown) {
        // Compaction errors are non-fatal — log and continue.
        // eslint-disable-next-line no-console
        console.error('[CrdtEntityRegistry] compaction error:', err);
      }
    }, this.compactionIntervalMs);
    // Don't keep the event loop alive solely for compaction.
    if (typeof this.compactionTimer.unref === 'function') {
      this.compactionTimer.unref();
    }
  }

  private stopCompactionTimer(): void {
    if (this.compactionTimer !== null) {
      clearInterval(this.compactionTimer);
      this.compactionTimer = null;
    }
  }

  /**
   * Library invariant — entityIds with this prefix are exempt from BOTH
   * tombstone TTL eviction and updateLog retention sweeps.
   *
   * Currently reserved:
   *   - `__fence__:<lockId>` — fencing-token sidecar entities (see §1
   *     fencing-token contract). These persist monotonic counters that
   *     guard distributed locks; if compaction were allowed to evict them,
   *     a stale claim returning from a long partition could re-INCR a
   *     fence collected back to zero, presenting an artificially-low epoch
   *     and silently corrupting locking. Both downstream consumers
   *     (live-video-streaming, websocket-gateway) require this be a library
   *     invariant rather than a per-consumer config knob.
   */
  private static readonly COMPACTION_EXEMPT_PREFIXES: readonly string[] = ['__fence__:'];

  /**
   * Returns true if the given entityId is exempt from compaction
   * (tombstone-TTL eviction AND updateLog retention). See
   * {@link CrdtEntityRegistry.COMPACTION_EXEMPT_PREFIXES}.
   */
  private isCompactionExempt(entityId: string): boolean {
    for (const prefix of CrdtEntityRegistry.COMPACTION_EXEMPT_PREFIXES) {
      if (entityId.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Evict tombstones older than `tombstoneTTLMs` and updateLog entries older
   * than `updateLogRetentionMs`. Exposed (package-private via test access) for
   * deterministic testing; otherwise driven by the compaction interval timer.
   *
   * NOTE: entityIds matching {@link CrdtEntityRegistry.COMPACTION_EXEMPT_PREFIXES}
   * (currently `__fence__:*`) are intentionally exempt from both tombstone-TTL
   * eviction and updateLog retention sweeps, per the §1 fencing-token contract.
   * Evicting those sidecars would break the monotonic-counter invariant that
   * underpins distributed locking — see the prefix-table JSDoc above.
   */
  compact(now: number = Date.now()): { tombstonesEvicted: number; updatesEvicted: number } {
    let tombstonesEvicted = 0;
    let updatesEvicted = 0;

    if (this.tombstoneTTLMs !== Number.POSITIVE_INFINITY) {
      const cutoff = now - this.tombstoneTTLMs;
      for (const [entityId, tomb] of this.tombstones) {
        if (this.isCompactionExempt(entityId)) continue; // fence sidecars never expire
        if (tomb.deletedAt <= cutoff) {
          this.tombstones.delete(entityId);
          tombstonesEvicted += 1;
        }
      }
    }

    if (this.updateLogRetentionMs !== Number.POSITIVE_INFINITY) {
      const cutoff = now - this.updateLogRetentionMs;
      // updateLog is roughly time-ordered; do an in-place filter.
      let writeIdx = 0;
      for (let readIdx = 0; readIdx < this.updateLog.length; readIdx += 1) {
        const u = this.updateLog[readIdx];
        // Fence-sidecar updates are retained regardless of age — a fresh node
        // joining must see the latest fence values to preserve monotonicity.
        if (u.timestamp > cutoff || this.isCompactionExempt(u.entityId)) {
          this.updateLog[writeIdx] = u;
          writeIdx += 1;
        } else {
          updatesEvicted += 1;
        }
      }
      this.updateLog.length = writeIdx;
    }

    return { tombstonesEvicted, updatesEvicted };
  }

  // ---------------------------------------------------------------------------
  // Core operations
  // ---------------------------------------------------------------------------

  async proposeEntity(entityId: string, metadata?: Record<string, any>): Promise<EntityRecord> {
    this.ensureRunning();

    const existing = this.entries.get(entityId);
    if (existing) {
      throw new EntityAlreadyExistsError(entityId);
    }

    const ts = this.tick();
    const now = Date.now();

    const record: EntityRecord = {
      entityId,
      ownerNodeId: this.nodeId,
      version: ts,
      createdAt: now,
      lastUpdated: now,
      metadata: metadata ?? {},
    };

    this.entries.set(entityId, { record, logicalTs: ts, authorNodeId: this.nodeId });
    this.tombstones.delete(entityId);

    const update: EntityUpdate = {
      entityId,
      ownerNodeId: this.nodeId,
      version: ts,
      timestamp: now,
      operation: 'CREATE',
      metadata,
    };
    this.updateLog.push(update);

    this.emit('entity:created', record);
    return record;
  }

  getEntityHost(entityId: string): string | null {
    return this.entries.get(entityId)?.record.ownerNodeId ?? null;
  }

  getEntity(entityId: string): EntityRecord | null {
    return this.entries.get(entityId)?.record ?? null;
  }

  async releaseEntity(entityId: string): Promise<void> {
    this.ensureRunning();

    const entry = this.entries.get(entityId);
    if (!entry) {
      throw new EntityNotFoundError(entityId);
    }
    if (entry.record.ownerNodeId !== this.nodeId) {
      throw new NotOwnedByNodeError(entityId, this.nodeId);
    }

    const ts = this.tick();
    const now = Date.now();

    this.entries.delete(entityId);
    this.tombstones.set(entityId, {
      logicalTs: ts,
      authorNodeId: this.nodeId,
      deletedAt: now,
    });

    const update: EntityUpdate = {
      entityId,
      version: ts,
      timestamp: now,
      operation: 'DELETE',
      previousVersion: entry.record.version,
    };
    this.updateLog.push(update);

    this.emit('entity:deleted', entry.record);
  }

  async updateEntity(entityId: string, metadata: Record<string, any>): Promise<EntityRecord> {
    this.ensureRunning();

    const entry = this.entries.get(entityId);
    if (!entry) {
      throw new EntityNotFoundError(entityId);
    }
    if (entry.record.ownerNodeId !== this.nodeId) {
      throw new NotOwnedByNodeError(entityId, this.nodeId);
    }

    const ts = this.tick();
    const now = Date.now();

    const updated: EntityRecord = {
      ...entry.record,
      version: ts,
      lastUpdated: now,
      metadata: { ...entry.record.metadata, ...metadata },
    };

    this.entries.set(entityId, { record: updated, logicalTs: ts, authorNodeId: this.nodeId });

    const update: EntityUpdate = {
      entityId,
      ownerNodeId: this.nodeId,
      version: ts,
      timestamp: now,
      operation: 'UPDATE',
      metadata,
      previousVersion: entry.record.version,
    };
    this.updateLog.push(update);

    this.emit('entity:updated', updated);
    return updated;
  }

  async transferEntity(entityId: string, targetNodeId: string): Promise<EntityRecord> {
    this.ensureRunning();

    const entry = this.entries.get(entityId);
    if (!entry) {
      throw new EntityNotFoundError(entityId);
    }
    if (entry.record.ownerNodeId !== this.nodeId) {
      throw new NotOwnedByNodeError(entityId, this.nodeId);
    }

    const ts = this.tick();
    const now = Date.now();

    const transferred: EntityRecord = {
      ...entry.record,
      ownerNodeId: targetNodeId,
      version: ts,
      lastUpdated: now,
    };

    this.entries.set(entityId, { record: transferred, logicalTs: ts, authorNodeId: this.nodeId });

    const update: EntityUpdate = {
      entityId,
      ownerNodeId: targetNodeId,
      version: ts,
      timestamp: now,
      operation: 'TRANSFER',
      metadata: entry.record.metadata,
      previousVersion: entry.record.version,
    };
    this.updateLog.push(update);

    this.emit('entity:transferred', transferred);
    return transferred;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  getLocalEntities(): EntityRecord[] {
    return Array.from(this.entries.values())
      .filter((e) => e.record.ownerNodeId === this.nodeId)
      .map((e) => e.record);
  }

  getAllKnownEntities(): EntityRecord[] {
    return Array.from(this.entries.values()).map((e) => e.record);
  }

  getEntitiesByNode(nodeId: string): EntityRecord[] {
    return Array.from(this.entries.values())
      .filter((e) => e.record.ownerNodeId === nodeId)
      .map((e) => e.record);
  }

  // ---------------------------------------------------------------------------
  // CRDT merge — last-write-wins with logical timestamps
  // ---------------------------------------------------------------------------

  async applyRemoteUpdate(update: EntityUpdate): Promise<boolean> {
    try {
      // Advance our local clock so we always see causally-later events as newer.
      this.logicalClock = Math.max(this.logicalClock, update.version);

      const incomingTs = update.version;
      const authorNodeId = update.ownerNodeId ?? '';

      switch (update.operation) {
        case 'CREATE':
        case 'UPDATE':
        case 'TRANSFER': {
          // Do not apply if a tombstone with an equal-or-higher timestamp exists.
          const tomb = this.tombstones.get(update.entityId);
          if (tomb && this.winsOver(tomb.logicalTs, tomb.authorNodeId, incomingTs, authorNodeId)) {
            return true; // tombstone beats the incoming update — ignore
          }

          const existing = this.entries.get(update.entityId);
          if (existing && this.winsOver(existing.logicalTs, existing.authorNodeId, incomingTs, authorNodeId)) {
            return true; // existing entry beats the incoming update — ignore
          }

          // Apply: incoming wins (or there is no existing entry)
          const now = Date.now();
          const newRecord: EntityRecord = {
            entityId: update.entityId,
            ownerNodeId: update.ownerNodeId ?? (existing?.record.ownerNodeId ?? ''),
            version: incomingTs,
            createdAt: existing?.record.createdAt ?? update.timestamp,
            lastUpdated: now,
            metadata: update.operation === 'UPDATE'
              ? { ...(existing?.record.metadata ?? {}), ...(update.metadata ?? {}) }
              : (update.metadata ?? {}),
          };

          this.entries.set(update.entityId, {
            record: newRecord,
            logicalTs: incomingTs,
            authorNodeId,
          });
          this.tombstones.delete(update.entityId);
          break;
        }

        case 'DELETE': {
          const existing = this.entries.get(update.entityId);
          const existingTomb = this.tombstones.get(update.entityId);
          const nowMs = Date.now();

          // Check whether the incoming DELETE beats what we have
          if (existing && !this.winsOver(existing.logicalTs, existing.authorNodeId, incomingTs, authorNodeId)) {
            this.entries.delete(update.entityId);
            this.tombstones.set(update.entityId, {
              logicalTs: incomingTs,
              authorNodeId,
              deletedAt: nowMs,
            });
          } else if (!existing) {
            // No live entry; update tombstone if incoming is newer
            if (!existingTomb || !this.winsOver(existingTomb.logicalTs, existingTomb.authorNodeId, incomingTs, authorNodeId)) {
              this.tombstones.set(update.entityId, {
                logicalTs: incomingTs,
                authorNodeId,
                deletedAt: nowMs,
              });
            }
          }
          break;
        }
      }

      this.updateLog.push(update);
      return true;
    } catch (error: unknown) {
      console.error(`[CrdtEntityRegistry] Failed to apply remote update for ${update.entityId}:`, error);
      return false;
    }
  }

  getUpdatesAfter(version: number): EntityUpdate[] {
    return this.updateLog.filter((u) => u.version > version);
  }

  // ---------------------------------------------------------------------------
  // Snapshotting
  // ---------------------------------------------------------------------------

  exportSnapshot(): EntitySnapshot {
    return {
      timestamp: Date.now(),
      version: this.logicalClock,
      entities: Object.fromEntries(
        Array.from(this.entries.entries()).map(([id, e]) => [id, e.record])
      ),
      nodeId: this.nodeId,
    };
  }

  async importSnapshot(snapshot: EntitySnapshot): Promise<void> {
    this.ensureRunning();

    this.entries.clear();
    this.tombstones.clear();

    for (const [entityId, record] of Object.entries(snapshot.entities)) {
      this.entries.set(entityId, {
        record,
        logicalTs: record.version,
        authorNodeId: record.ownerNodeId,
      });
    }

    this.logicalClock = Math.max(this.logicalClock, snapshot.version);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Increment and return the logical clock.
   * Uses Lamport semantics: each local event advances the counter.
   */
  private tick(): number {
    this.logicalClock += 1;
    return this.logicalClock;
  }

  /**
   * Returns true if (aTs, aNode) beats (bTs, bNode) in the LWW ordering:
   *   higher logical timestamp wins; on tie, lexicographically higher nodeId wins.
   */
  private winsOver(aTs: number, aNode: string, bTs: number, bNode: string): boolean {
    if (aTs !== bTs) return aTs > bTs;
    return aNode > bNode;
  }

  private ensureRunning(): void {
    if (!this.isRunning) {
      throw new NotStartedError('CrdtEntityRegistry');
    }
  }
}
