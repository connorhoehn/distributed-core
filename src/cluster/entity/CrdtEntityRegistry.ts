import { EventEmitter } from 'eventemitter3';
import {
  EntityRegistry,
  EntityRecord,
  EntitySnapshot,
  EntityUpdate,
} from './types';

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
   * Tombstones: entityId -> { logicalTs, authorNodeId } for deleted entities.
   * Prevents out-of-order CREATE/UPDATE updates from resurrecting deleted entities.
   */
  private readonly tombstones: Map<string, { logicalTs: number; authorNodeId: string }> =
    new Map();
  private readonly updateLog: EntityUpdate[] = [];

  private readonly nodeId: string;
  private isRunning = false;

  /** Logical clock — monotonically increasing per-node counter. */
  private logicalClock = 0;

  constructor(nodeId: string) {
    super();
    this.nodeId = nodeId;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.isRunning = true;
  }

  async stop(): Promise<void> {
    this.isRunning = false;
  }

  // ---------------------------------------------------------------------------
  // Core operations
  // ---------------------------------------------------------------------------

  async proposeEntity(entityId: string, metadata?: Record<string, any>): Promise<EntityRecord> {
    this.ensureRunning();

    const existing = this.entries.get(entityId);
    if (existing) {
      throw new Error(`Entity ${entityId} already exists`);
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
      throw new Error(`Entity ${entityId} not found`);
    }
    if (entry.record.ownerNodeId !== this.nodeId) {
      throw new Error(`Cannot release entity ${entityId} — not owned by this node`);
    }

    const ts = this.tick();
    const now = Date.now();

    this.entries.delete(entityId);
    this.tombstones.set(entityId, { logicalTs: ts, authorNodeId: this.nodeId });

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
      throw new Error(`Entity ${entityId} not found`);
    }
    if (entry.record.ownerNodeId !== this.nodeId) {
      throw new Error(`Cannot update entity ${entityId} — not owned by this node`);
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
      throw new Error(`Entity ${entityId} not found`);
    }
    if (entry.record.ownerNodeId !== this.nodeId) {
      throw new Error(`Cannot transfer entity ${entityId} — not owned by this node`);
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

          // Check whether the incoming DELETE beats what we have
          if (existing && !this.winsOver(existing.logicalTs, existing.authorNodeId, incomingTs, authorNodeId)) {
            this.entries.delete(update.entityId);
            this.tombstones.set(update.entityId, { logicalTs: incomingTs, authorNodeId });
          } else if (!existing) {
            // No live entry; update tombstone if incoming is newer
            if (!existingTomb || !this.winsOver(existingTomb.logicalTs, existingTomb.authorNodeId, incomingTs, authorNodeId)) {
              this.tombstones.set(update.entityId, { logicalTs: incomingTs, authorNodeId });
            }
          }
          break;
        }
      }

      this.updateLog.push(update);
      return true;
    } catch (error) {
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
      throw new Error('CrdtEntityRegistry is not running. Call start() first.');
    }
  }
}
