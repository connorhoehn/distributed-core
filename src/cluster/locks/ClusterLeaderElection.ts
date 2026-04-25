import { EventEmitter } from 'events';
import { LeaderElection, LeaderElectionConfig } from './LeaderElection';
import { DistributedLock } from './DistributedLock';
import { ResourceRouter } from '../../routing/ResourceRouter';
import { RouteTarget } from '../../routing/types';
import { LifecycleAware } from '../../common/LifecycleAware';
import { StaleLeaderError } from '../../common/errors';

export type ClusterLeaderElectionConfig = LeaderElectionConfig

export class ClusterLeaderElection extends EventEmitter implements LifecycleAware {
  private readonly groupId: string;
  private readonly nodeId: string;
  private readonly lock: DistributedLock;
  private readonly router: ResourceRouter;
  private readonly _election: LeaderElection;
  private _started = false;

  constructor(
    groupId: string,
    nodeId: string,
    lock: DistributedLock,
    router: ResourceRouter,
    config?: ClusterLeaderElectionConfig
  ) {
    super();
    this.groupId = groupId;
    this.nodeId = nodeId;
    this.lock = lock;
    this.router = router;
    this._election = new LeaderElection(groupId, nodeId, lock, config);

    this._election.on('elected', () => {
      this.router.claim(`election:${this.groupId}`, { metadata: { nodeId: this.nodeId } }).catch(() => {});
      this.emit('elected');
      this.emit('leader-changed', this.nodeId);
    });

    this._election.on('deposed', () => {
      this.router.release(`election:${this.groupId}`).catch(() => {});
      this.emit('deposed');
      this.emit('leader-changed', null);
    });
  }

  isStarted(): boolean {
    return this._started;
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    await this.router.start();
    await this._election.start();
  }

  async stop(): Promise<void> {
    if (!this._started) return;
    this._started = false;
    await this._election.stop();
    await this.router.release(`election:${this.groupId}`).catch(() => {});
    await this.router.stop();
  }

  isLeader(): boolean {
    return this._election.isLeader();
  }

  async getLeaderRoute(): Promise<RouteTarget | null> {
    return this.router.route(`election:${this.groupId}`);
  }

  getLeaderId(): string | null {
    return this._election.getLeaderId();
  }

  /**
   * Fencing token of the currently-held lease, treated as the leader's
   * epoch. Strictly monotonic per group across the lifetime of the cluster
   * (subject to the persistence guarantees of the underlying registry).
   *
   * Throws if this node is not leader.
   */
  currentEpoch(): bigint {
    return this._election.currentEpoch();
  }

  /**
   * Run leader-only work `fn`, passing the current `epoch`. After `fn`
   * resolves, re-read the underlying lock's fencing token and throw
   * `StaleLeaderError` if it has changed (i.e., the lease was lost and
   * re-acquired — possibly by another node — while `fn` was running). The
   * caller must abort any side-effects in that case.
   *
   * Note: `guard` does NOT cancel `fn` mid-flight. It checks at the boundary.
   * For long-running side-effects, use the epoch-as-fencing-token directly
   * with a downstream acceptance gate (see `LockHandle.fencingToken`).
   */
  async guard<T>(fn: (epoch: bigint) => Promise<T>): Promise<T> {
    const heldEpoch = this.currentEpoch();
    const result = await fn(heldEpoch);

    // Re-check after `fn` completes. The leader's currently-held handle (if
    // any) is the local source of truth: if its token differs from the one
    // we captured at entry, our lease was lost (and possibly re-acquired by
    // someone else) during execution.
    const stillHeld = this._election.getCurrentHandle();
    if (stillHeld === null) {
      throw new StaleLeaderError(this.groupId, heldEpoch, null);
    }
    if (stillHeld.fencingToken !== heldEpoch) {
      throw new StaleLeaderError(this.groupId, heldEpoch, stillHeld.fencingToken);
    }
    // Belt-and-braces: also check the registry-side fencing token.
    // If a remote node took over and bumped the counter while our local
    // renewal cycle hasn't yet noticed, the registry token will be larger.
    const registryToken = this.lock.getCurrentFencingToken(`election:${this.groupId}`);
    if (registryToken > heldEpoch) {
      throw new StaleLeaderError(this.groupId, heldEpoch, registryToken);
    }
    return result;
  }
}
