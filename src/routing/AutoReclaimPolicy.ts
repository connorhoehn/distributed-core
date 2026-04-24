import { EventEmitter } from 'events';
import { ResourceRouter } from './ResourceRouter';
import { PlacementStrategy, ResourceHandle } from './types';
import { LocalPlacement } from './PlacementStrategy';

export interface AutoReclaimPolicyConfig {
  strategy?: PlacementStrategy;
  jitterMs?: number;
  maxClaimAttempts?: number;
}

export class AutoReclaimPolicy extends EventEmitter {
  private readonly router: ResourceRouter;
  private readonly strategy: PlacementStrategy;
  private readonly jitterMs: number;
  private readonly maxClaimAttempts: number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private started = false;

  private readonly _onOrphaned: (handle: ResourceHandle) => void;

  constructor(router: ResourceRouter, config?: AutoReclaimPolicyConfig) {
    super();
    this.router = router;
    this.strategy = config?.strategy ?? new LocalPlacement();
    this.jitterMs = config?.jitterMs ?? 500;
    this.maxClaimAttempts = config?.maxClaimAttempts ?? 1;

    this._onOrphaned = (handle: ResourceHandle) => this._handleOrphaned(handle);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.router.on('resource:orphaned', this._onOrphaned);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.router.off('resource:orphaned', this._onOrphaned);
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  isStarted(): boolean {
    return this.started;
  }

  private _handleOrphaned(handle: ResourceHandle): void {
    const { resourceId } = handle;
    const candidates = this.router.getAliveNodeIds();
    const selected = this.strategy.selectNode(resourceId, this.router.nodeId, candidates);

    if (selected !== this.router.nodeId) {
      this.emit('reclaim:skipped', resourceId, 'strategy-chose-other');
      return;
    }

    this.emit('reclaim:attempted', resourceId);

    const delay = Math.random() * this.jitterMs;
    const timer = setTimeout(async () => {
      this.timers.delete(resourceId);
      await this._attemptClaim(resourceId, handle, this.maxClaimAttempts);
    }, delay);
    timer.unref();
    this.timers.set(resourceId, timer);
  }

  private async _attemptClaim(
    resourceId: string,
    handle: ResourceHandle,
    attemptsRemaining: number
  ): Promise<void> {
    const target = await this.router.route(resourceId);
    const alreadyClaimed =
      target !== null &&
      (target.isLocal || this.router.getAliveNodeIds().includes(target.nodeId));
    if (alreadyClaimed) {
      this.emit('reclaim:skipped', resourceId, 'already-claimed');
      return;
    }

    await this.router.applyRemoteUpdate({
      entityId: resourceId,
      ownerNodeId: handle.ownerNodeId,
      version: handle.version + 1,
      timestamp: Date.now(),
      operation: 'DELETE',
      metadata: {},
    });

    try {
      const newHandle = await this.router.claim(resourceId);
      this.emit('reclaim:succeeded', newHandle);
    } catch (err) {
      if (attemptsRemaining > 1) {
        await this._attemptClaim(resourceId, handle, attemptsRemaining - 1);
      } else {
        this.emit('reclaim:failed', resourceId, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
