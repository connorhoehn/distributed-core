import { EventEmitter } from 'events';
import { DistributedLock, LockHandle } from './DistributedLock';
import { LifecycleAware } from '../../common/LifecycleAware';

export interface LeaderElectionConfig {
  leaseDurationMs?: number;
  renewIntervalMs?: number;
}

const DEFAULT_LEASE_DURATION_MS = 15_000;
const DEFAULT_RENEW_INTERVAL_MS = 5_000;

export class LeaderElection extends EventEmitter implements LifecycleAware {
  private readonly groupId: string;
  private readonly nodeId: string;
  private readonly lock: DistributedLock;
  private readonly config: Required<LeaderElectionConfig>;
  private currentHandle: LockHandle | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(groupId: string, nodeId: string, lock: DistributedLock, config?: LeaderElectionConfig) {
    super();
    this.groupId = groupId;
    this.nodeId = nodeId;
    this.lock = lock;
    this.config = {
      leaseDurationMs: config?.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      renewIntervalMs: config?.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS,
    };
  }

  isStarted(): boolean {
    return this.isRunning;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    await this._cycle();
    this.renewTimer = setInterval(() => this._cycle(), this.config.renewIntervalMs);
    (this.renewTimer as NodeJS.Timeout).unref?.();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.renewTimer !== null) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    if (this.currentHandle !== null) {
      const handle = this.currentHandle;
      this.currentHandle = null;
      await this.lock.release(handle);
      this.emit('deposed');
      this.emit('leader-changed', null);
    }
  }

  isLeader(): boolean {
    return this.currentHandle !== null;
  }

  getLeaderId(): string | null {
    return this.isLeader() ? this.nodeId : null;
  }

  private async _cycle(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    if (this.currentHandle !== null) {
      try {
        this.currentHandle = await this.lock.extend(this.currentHandle, this.config.leaseDurationMs);
      } catch {
        this.currentHandle = null;
        this.emit('deposed');
        this.emit('leader-changed', null);
      }
    } else {
      const handle = await this.lock.tryAcquire(`election:${this.groupId}`, {
        ttlMs: this.config.leaseDurationMs,
      });
      if (handle !== null) {
        this.currentHandle = handle;
        this.emit('elected');
        this.emit('leader-changed', this.nodeId);
      }
    }
  }
}
