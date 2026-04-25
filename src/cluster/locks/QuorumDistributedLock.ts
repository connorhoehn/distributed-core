import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { PubSubManager } from '../../gateway/pubsub/PubSubManager';
import { PubSubMessageMetadata } from '../../gateway/pubsub/types';
import { ClusterManager } from '../ClusterManager';
import { LockHandle } from './DistributedLock';
import { LifecycleAware } from '../../common/LifecycleAware';

export interface QuorumDistributedLockConfig {
  topic?: string;
  defaultTtlMs?: number;
  acquireTimeoutMs?: number;
  ackTimeoutMs?: number;
}

type QuorumMsg =
  | { kind: 'LOCK_REQUEST'; lockId: string; requestId: string; nodeId: string; ttlMs: number }
  // `seenToken` is the stringified bigint of the highest fencing token this
  // peer has ever seen for `lockId`. The acquirer takes max + 1n across
  // grants to compute its own token, guaranteeing strict monotonicity.
  | { kind: 'LOCK_GRANT'; requestId: string; lockId: string; fromNodeId: string; seenToken: string }
  | { kind: 'LOCK_DENY'; requestId: string; lockId: string; fromNodeId: string; reason: string; seenToken: string }
  | { kind: 'LOCK_ABANDON'; lockId: string; nodeId: string }
  // `fencingToken` lets all peers update their lastSeen map so a future grant
  // returns the right max.
  | { kind: 'LOCK_RELEASE'; lockId: string; nodeId: string; fencingToken: string };

interface PendingRequest {
  resolve: (handle: LockHandle | null) => void;
  grants: Set<string>;
  denies: Set<string>;
  // Highest seenToken observed across all peers (including the local node)
  // for this in-flight request. The granted token will be `maxSeen + 1n`.
  maxSeenToken: bigint;
  timer: ReturnType<typeof setTimeout>;
  lockId: string;
  ttlMs: number;
}

const DEFAULT_TOPIC = 'quorum-lock';
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const DEFAULT_ACK_TIMEOUT_MS = 2_000;

export class QuorumDistributedLock extends EventEmitter implements LifecycleAware {
  private readonly localNodeId: string;
  private readonly pubsub: PubSubManager;
  private readonly cluster: ClusterManager;
  private readonly topic: string;
  private readonly defaultTtlMs: number;
  private readonly ackTimeoutMs: number;

  private readonly heldLocks = new Map<string, LockHandle>();
  private readonly remoteLocks = new Map<string, string>();
  private readonly remoteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly ttlTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Highest fencing token this node has ever seen for each lockId. Used to
   * (a) advertise our knowledge in `LOCK_GRANT.seenToken` so the acquirer
   * can compute `max + 1n`, and (b) guarantee that even after a network
   * flap our local view never goes backwards.
   *
   * Persistence note: this counter is currently in-memory per lock instance.
   * On full process restart, the counter resets to whatever max the cluster
   * has gossiped (eventually). Strict monotonicity within a stable cluster
   * is preserved; for cross-restart strict monotonicity an integrator must
   * back QuorumDistributedLock with a durable EntityRegistry — out of scope
   * here.
   */
  private readonly lastSeenTokens = new Map<string, bigint>();

  private subscriptionId: string | null = null;
  private _started = false;

  constructor(
    localNodeId: string,
    pubsub: PubSubManager,
    cluster: ClusterManager,
    config?: QuorumDistributedLockConfig,
  ) {
    super();
    this.localNodeId = localNodeId;
    this.pubsub = pubsub;
    this.cluster = cluster;
    this.topic = config?.topic ?? DEFAULT_TOPIC;
    this.defaultTtlMs = config?.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.ackTimeoutMs = config?.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  }

  isStarted(): boolean {
    return this._started;
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this.subscriptionId = this.pubsub.subscribe(this.topic, this._onMessage.bind(this));
  }

  async stop(): Promise<void> {
    if (!this._started) return;
    this._started = false;
    if (this.subscriptionId !== null) {
      this.pubsub.unsubscribe(this.subscriptionId);
      this.subscriptionId = null;
    }
  }

  /**
   * Try to acquire a cluster-wide lock via majority ACK.
   *
   * Corner cases not handled: split-brain partitions where two minority groups
   * each believe they have majority. Partition tolerance is out of scope per spec.
   */
  async tryAcquire(lockId: string, options?: { ttlMs?: number }): Promise<LockHandle | null> {
    if (this.heldLocks.has(lockId)) {
      return this.heldLocks.get(lockId)!;
    }
    if (this.remoteLocks.has(lockId)) {
      return null;
    }

    const ttlMs = options?.ttlMs ?? this.defaultTtlMs;
    const requestId = randomUUID();

    const alive = this.cluster.getMembership().size;
    const majority = Math.floor(alive / 2) + 1;

    return new Promise<LockHandle | null>((resolve) => {
      const grants = new Set<string>([this.localNodeId]);
      const denies = new Set<string>();
      // Seed with our own knowledge so a single-node majority still issues a
      // strictly-increasing token across acquire/release/acquire cycles.
      const initialSeen = this.lastSeenTokens.get(lockId) ?? 0n;

      const tryResolveEarly = () => {
        const pending = this.pendingRequests.get(requestId);
        if (pending && grants.size >= majority) {
          clearTimeout(timer);
          this.pendingRequests.delete(requestId);
          const handle = this._grantLocal(lockId, requestId, ttlMs, pending.maxSeenToken + 1n);
          resolve(handle);
        }
      };

      const timer = setTimeout(async () => {
        const pending = this.pendingRequests.get(requestId);
        this.pendingRequests.delete(requestId);
        if (pending && grants.size >= majority) {
          const handle = this._grantLocal(lockId, requestId, ttlMs, pending.maxSeenToken + 1n);
          resolve(handle);
        } else {
          await this.pubsub.publish(this.topic, {
            kind: 'LOCK_ABANDON',
            lockId,
            nodeId: this.localNodeId,
          } satisfies QuorumMsg);
          resolve(null);
        }
      }, this.ackTimeoutMs);

      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        timer.unref();
      }

      this.pendingRequests.set(requestId, {
        resolve,
        grants,
        denies,
        maxSeenToken: initialSeen,
        timer,
        lockId,
        ttlMs,
      });

      if (alive === 1) {
        tryResolveEarly();
        return;
      }

      this.pubsub
        .publish(this.topic, {
          kind: 'LOCK_REQUEST',
          lockId,
          requestId,
          nodeId: this.localNodeId,
          ttlMs,
        } satisfies QuorumMsg)
        .then(() => {
          const pending = this.pendingRequests.get(requestId);
          if (pending) {
            tryResolveEarly();
          }
        })
        .catch(() => {
          const pending = this.pendingRequests.get(requestId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(requestId);
            resolve(null);
          }
        });
    });
  }

  async release(lockHandle: LockHandle): Promise<void> {
    const { lockId } = lockHandle;
    const held = this.heldLocks.get(lockId);
    if (held === undefined) {
      return;
    }
    this._clearTtlTimer(lockId);
    this.heldLocks.delete(lockId);
    await this.pubsub.publish(this.topic, {
      kind: 'LOCK_RELEASE',
      lockId,
      nodeId: this.localNodeId,
      fencingToken: held.fencingToken.toString(),
    } satisfies QuorumMsg);
    this.emit('lock:released', lockId);
  }

  isHeldLocally(lockId: string): boolean {
    return this.heldLocks.has(lockId);
  }

  getHeldLocks(): LockHandle[] {
    return Array.from(this.heldLocks.values());
  }

  /**
   * Read the highest fencing token this node currently knows for `lockId`.
   * Returns `0n` if never seen. Useful for acceptance-gate implementations.
   */
  getCurrentFencingToken(lockId: string): bigint {
    return this.lastSeenTokens.get(lockId) ?? 0n;
  }

  private _grantLocal(lockId: string, _requestId: string, ttlMs: number, fencingToken: bigint): LockHandle {
    const now = Date.now();
    const handle: LockHandle = {
      lockId,
      nodeId: this.localNodeId,
      acquiredAt: now,
      expiresAt: now + ttlMs,
      fencingToken,
    };
    this.heldLocks.set(lockId, handle);
    // Update our own last-seen so any future grant we participate in returns
    // a strictly-larger seenToken.
    this._observeToken(lockId, fencingToken);
    this._scheduleTtlTimer(lockId, ttlMs);
    this.emit('lock:acquired', handle);
    return handle;
  }

  private _observeToken(lockId: string, token: bigint): void {
    const current = this.lastSeenTokens.get(lockId) ?? 0n;
    if (token > current) {
      this.lastSeenTokens.set(lockId, token);
    }
  }

  private _parseToken(raw: string | undefined): bigint {
    if (raw === undefined) return 0n;
    try {
      return BigInt(raw);
    } catch {
      return 0n;
    }
  }

  private _scheduleTtlTimer(lockId: string, ttlMs: number): void {
    this._clearTtlTimer(lockId);
    const timer = setTimeout(() => {
      this._onTtlExpired(lockId);
    }, ttlMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      timer.unref();
    }
    this.ttlTimers.set(lockId, timer);
  }

  private _clearTtlTimer(lockId: string): void {
    const t = this.ttlTimers.get(lockId);
    if (t !== undefined) {
      clearTimeout(t);
      this.ttlTimers.delete(lockId);
    }
  }

  private _onTtlExpired(lockId: string): void {
    this.ttlTimers.delete(lockId);
    const handle = this.heldLocks.get(lockId);
    if (handle) {
      this.heldLocks.delete(lockId);
      this.pubsub
        .publish(this.topic, {
          kind: 'LOCK_RELEASE',
          lockId,
          nodeId: this.localNodeId,
          fencingToken: handle.fencingToken.toString(),
        } satisfies QuorumMsg)
        .catch(() => {});
      this.emit('lock:released', lockId);
    }
  }

  private _scheduleRemoteTimer(lockId: string, ttlMs: number): void {
    this._clearRemoteTimer(lockId);
    const timer = setTimeout(() => {
      this.remoteLocks.delete(lockId);
      this.remoteTimers.delete(lockId);
    }, ttlMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      timer.unref();
    }
    this.remoteTimers.set(lockId, timer);
  }

  private _clearRemoteTimer(lockId: string): void {
    const t = this.remoteTimers.get(lockId);
    if (t !== undefined) {
      clearTimeout(t);
      this.remoteTimers.delete(lockId);
    }
  }

  private _onMessage(
    _topic: string,
    payload: unknown,
    metadata: PubSubMessageMetadata,
  ): void {
    const msg = payload as QuorumMsg;

    if (msg.kind === 'LOCK_REQUEST') {
      if (metadata.publisherNodeId === this.localNodeId) return;

      const { lockId, requestId, nodeId, ttlMs } = msg;
      const seenToken = (this.lastSeenTokens.get(lockId) ?? 0n).toString();

      if (this.heldLocks.has(lockId)) {
        this.pubsub
          .publish(this.topic, {
            kind: 'LOCK_DENY',
            requestId,
            lockId,
            fromNodeId: this.localNodeId,
            reason: 'locally-held',
            seenToken,
          } satisfies QuorumMsg)
          .catch(() => {});
        this.emit('lock:denied', lockId, nodeId, 'locally-held');
        return;
      }

      if (this.remoteLocks.has(lockId)) {
        this.pubsub
          .publish(this.topic, {
            kind: 'LOCK_DENY',
            requestId,
            lockId,
            fromNodeId: this.localNodeId,
            reason: 'already-acked',
            seenToken,
          } satisfies QuorumMsg)
          .catch(() => {});
        this.emit('lock:denied', lockId, nodeId, 'already-acked');
        return;
      }

      this.remoteLocks.set(lockId, nodeId);
      this._scheduleRemoteTimer(lockId, ttlMs);
      this.pubsub
        .publish(this.topic, {
          kind: 'LOCK_GRANT',
          requestId,
          lockId,
          fromNodeId: this.localNodeId,
          seenToken,
        } satisfies QuorumMsg)
        .catch(() => {});
      return;
    }

    if (msg.kind === 'LOCK_GRANT') {
      if (metadata.publisherNodeId === this.localNodeId) return;
      const { requestId, fromNodeId, lockId, seenToken } = msg;
      const pending = this.pendingRequests.get(requestId);
      if (!pending) return;

      pending.grants.add(fromNodeId);
      const peerSeen = this._parseToken(seenToken);
      if (peerSeen > pending.maxSeenToken) pending.maxSeenToken = peerSeen;
      this._observeToken(lockId, peerSeen);

      const alive = this.cluster.getMembership().size;
      const majority = Math.floor(alive / 2) + 1;

      if (pending.grants.size >= majority) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(requestId);
        const handle = this._grantLocal(pending.lockId, requestId, pending.ttlMs, pending.maxSeenToken + 1n);
        pending.resolve(handle);
      }
      return;
    }

    if (msg.kind === 'LOCK_DENY') {
      if (metadata.publisherNodeId === this.localNodeId) return;
      const { requestId, fromNodeId, reason, lockId, seenToken } = msg;
      const pending = this.pendingRequests.get(requestId);
      if (!pending) return;

      pending.denies.add(fromNodeId);
      const peerSeen = this._parseToken(seenToken);
      if (peerSeen > pending.maxSeenToken) pending.maxSeenToken = peerSeen;
      this._observeToken(lockId, peerSeen);
      this.emit('lock:denied', pending.lockId, fromNodeId, reason);

      const alive = this.cluster.getMembership().size;
      const majority = Math.floor(alive / 2) + 1;
      const remainingPeers = alive - 1 - pending.grants.size - pending.denies.size;

      if (pending.grants.size + remainingPeers < majority) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(requestId);
        this.pubsub
          .publish(this.topic, {
            kind: 'LOCK_ABANDON',
            lockId: pending.lockId,
            nodeId: this.localNodeId,
          } satisfies QuorumMsg)
          .catch(() => {});
        pending.resolve(null);
      }
      return;
    }

    if (msg.kind === 'LOCK_ABANDON') {
      if (metadata.publisherNodeId === this.localNodeId) return;
      const { lockId } = msg;
      this._clearRemoteTimer(lockId);
      this.remoteLocks.delete(lockId);
      return;
    }

    if (msg.kind === 'LOCK_RELEASE') {
      if (metadata.publisherNodeId === this.localNodeId) return;
      const { lockId, fencingToken } = msg;
      this._clearRemoteTimer(lockId);
      this.remoteLocks.delete(lockId);
      this._observeToken(lockId, this._parseToken(fencingToken));
      return;
    }
  }
}
