/**
 * Classifies why a snapshot was taken. Applications can extend this
 * with additional labels by using a union with string literals.
 *
 * - auto        Created automatically by interval or operation threshold
 * - manual      User-initiated, optionally named; typically never expires
 * - checkpoint  Created before a destructive operation (restore, clear) as a safety net
 */
export type SnapshotType = 'auto' | 'manual' | 'checkpoint';

export interface SnapshotEntry<T> {
  id: string;
  key: string;
  timestamp: number;
  type: SnapshotType;
  /** Only meaningful for type 'manual'. */
  name?: string;
  data: T;
  sizeBytes?: number;
  /** Epoch ms. Undefined means this entry never expires. */
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

export interface StoreSnapshotOptions {
  type?: SnapshotType;
  name?: string;
  /** Time-to-live in ms from now. Undefined = never expires. */
  ttlMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ISnapshotVersionStore<T> {
  store(key: string, data: T, options?: StoreSnapshotOptions): Promise<SnapshotEntry<T>>;
  getLatest(key: string): Promise<SnapshotEntry<T> | null>;
  /** Returns entries newest-first, filtered to non-expired. */
  list(key: string, limit?: number): Promise<SnapshotEntry<T>[]>;
  getAt(key: string, timestamp: number): Promise<SnapshotEntry<T> | null>;
  delete(key: string, timestamp: number): Promise<boolean>;
  /** Removes all expired entries across all keys; returns count removed. */
  purgeExpired(): Promise<number>;
}
