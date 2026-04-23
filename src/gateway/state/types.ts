import { SnapshotType } from '../../persistence/snapshot/types';

/**
 * Callbacks the host application provides to teach SharedStateManager how to
 * work with the concrete state type. The manager is agnostic to the actual
 * CRDT library (Yjs, Automerge, plain JSON, etc.).
 */
export interface SharedStateAdapter<S, U> {
  /** Return a new, empty initial state for a session that has no prior snapshot. */
  createState(): S;

  /** Apply a single update to state and return the new state (may mutate in place). */
  applyUpdate(state: S, update: U): S;

  /** Serialize state for snapshot storage or cross-node broadcast. */
  serialize(state: S): Uint8Array | string;

  /** Reconstruct state from a serialized snapshot. */
  deserialize(raw: Uint8Array | string): S;

  /**
   * Optional: combine multiple buffered updates into a smaller set before
   * they are broadcast (e.g. Yjs `mergeUpdates`, JSON-patch squash).
   */
  mergeUpdates?(updates: U[]): U[];
}

export interface SharedStateManagerConfig {
  /** How long a session idles with 0 subscribers before it is evicted. Default: 600_000 ms */
  idleEvictionMs?: number;
  /** Coalescing window before buffered updates are broadcast. Default: 50 ms */
  coalescingWindowMs?: number;
  /** Checkpoint after this many operations. Default: 50 */
  operationsBeforeCheckpoint?: number;
  /** Debounce window before writing a snapshot on update activity. Default: 5_000 ms */
  snapshotDebounceMs?: number;
}

export interface SharedStateSession<S> {
  channelId: string;
  state: S;
  subscriberCount: number;
  operationCount: number;
  createdAt: number;
  lastActivity: number;
}

export interface SharedStateManagerStats {
  activeSessions: number;
  pendingCoalesce: number;
  pendingEvictions: number;
}
