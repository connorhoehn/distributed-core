/**
 * TranscoderLock.ts — thin wrapper around DistributedLock for
 * "exactly one transcoder per stream" semantics.
 *
 * A streaming workload requires that only ONE node ever runs the transcoder
 * pipeline for a given room's source stream. DistributedLock provides the
 * mutual exclusion; this file wraps it with domain-specific naming and TTL
 * tuning so the calling code reads as "transcoder domain" rather than
 * "distributed systems primitives".
 *
 * Design note: we deliberately do NOT subclass DistributedLock. Composition
 * over inheritance — the lock is a field, not a base class. This keeps the
 * surface area that callers depend on narrow.
 *
 * Primitive: DistributedLock (src/cluster/locks/DistributedLock.ts)
 */

import { DistributedLock, LockHandle } from '../../src/cluster/locks/DistributedLock';

// How long a transcoder lock lives before it must be renewed.
// Kept short so a hard-killed node releases its lock quickly.
const TRANSCODER_TTL_MS = 10_000;

// Prefix so transcoder locks are visually distinct from other lock types
// in observability tooling.
const LOCK_PREFIX = 'transcoder:stream:';

export class TranscoderLock {
  private readonly lock: DistributedLock;
  private readonly heldHandles = new Map<string, LockHandle>();

  constructor(lock: DistributedLock) {
    this.lock = lock;
  }

  /**
   * Attempt to become the transcoder for `streamId`.
   * Returns the lock handle on success, or null if another node already holds it.
   * Non-blocking: this never waits — real transcoder logic would fall back to
   * receiving the encoded stream from the holder instead.
   */
  async tryBecomeTranscoder(streamId: string): Promise<LockHandle | null> {
    const lockId = `${LOCK_PREFIX}${streamId}`;
    const handle = await this.lock.tryAcquire(lockId, { ttlMs: TRANSCODER_TTL_MS });
    if (handle !== null) {
      this.heldHandles.set(streamId, handle);
    }
    return handle;
  }

  /**
   * Renew the transcoder lease for `streamId`.
   * Call this on a heartbeat interval shorter than TRANSCODER_TTL_MS.
   * Returns null if the lock is no longer held by this node.
   */
  async renewTranscoder(streamId: string): Promise<LockHandle | null> {
    const existing = this.heldHandles.get(streamId);
    if (existing === undefined) return null;
    try {
      const renewed = await this.lock.extend(existing, TRANSCODER_TTL_MS);
      this.heldHandles.set(streamId, renewed);
      return renewed;
    } catch {
      // Lock expired or was taken by another node — we lost it.
      this.heldHandles.delete(streamId);
      return null;
    }
  }

  /**
   * Yield the transcoder role for `streamId`.
   */
  async yieldTranscoder(streamId: string): Promise<void> {
    const handle = this.heldHandles.get(streamId);
    if (handle !== undefined) {
      this.heldHandles.delete(streamId);
      await this.lock.release(handle);
    }
  }

  /**
   * Returns true if this node is currently the transcoder for `streamId`.
   */
  isTranscoding(streamId: string): boolean {
    const lockId = `${LOCK_PREFIX}${streamId}`;
    return this.lock.isHeldLocally(lockId);
  }

  /**
   * How many transcoder locks does this node currently hold?
   */
  get heldCount(): number {
    return this.heldHandles.size;
  }

  /**
   * Called externally on node failure to release this node's lock book-keeping.
   * The underlying DistributedLock registry handles the actual cleanup via
   * handleRemoteNodeFailure(); we only need to clear our local handle map.
   */
  clearAllHandles(): void {
    this.heldHandles.clear();
  }
}
