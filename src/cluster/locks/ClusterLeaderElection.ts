import { EventEmitter } from 'events';
import { LeaderElection, LeaderElectionConfig } from './LeaderElection';
import { DistributedLock } from './DistributedLock';
import { ResourceRouter } from '../../routing/ResourceRouter';
import { RouteTarget } from '../../routing/types';

export interface ClusterLeaderElectionConfig extends LeaderElectionConfig {}

export class ClusterLeaderElection extends EventEmitter {
  private readonly groupId: string;
  private readonly nodeId: string;
  private readonly router: ResourceRouter;
  private readonly _election: LeaderElection;

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

  async start(): Promise<void> {
    await this.router.start();
    await this._election.start();
  }

  async stop(): Promise<void> {
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
