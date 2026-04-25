import { EventEmitter } from 'events';
import { LeaderElection, LeaderElectionConfig } from './LeaderElection';
import { DistributedLock } from './DistributedLock';
import { ResourceRouter } from '../../routing/ResourceRouter';
import { RouteTarget } from '../../routing/types';
import { LifecycleAware } from '../../common/LifecycleAware';

export type ClusterLeaderElectionConfig = LeaderElectionConfig

export class ClusterLeaderElection extends EventEmitter implements LifecycleAware {
  private readonly groupId: string;
  private readonly nodeId: string;
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
}
