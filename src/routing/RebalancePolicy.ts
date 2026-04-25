import { EventEmitter } from 'events';
import { ResourceRouter } from './ResourceRouter';
import { PlacementStrategy, ResourceHandle } from './types';
import { HashPlacement } from './PlacementStrategy';
import { LifecycleAware } from '../common/LifecycleAware';

/**
 * Trigger that causes RebalancePolicy to walk locally-owned resources and
 * issue ideal-owner transfers.
 *
 * - 'member-joined' (default): rebalance when a new node enters the cluster.
 *   This is the typical scale-out case that motivates §2 of the GAPS doc.
 * - 'member-left': rebalance when a node leaves. Note: this does NOT replace
 *   AutoReclaimPolicy, which handles `resource:orphaned` re-placement of
 *   resources whose owner died. Use this trigger only if you also want
 *   surviving resources to migrate when membership shrinks.
 * - 'periodic': fires on a fixed interval (`periodicIntervalMs`). Useful
 *   when load distribution drifts independently of membership changes.
 */
export type RebalanceTrigger = 'member-joined' | 'member-left' | 'periodic';

export interface RebalancePolicyConfig {
  /**
   * Placement strategy used to compute the ideal owner for each
   * locally-owned resource. Defaults to `HashPlacement` since that is the
   * strategy that most benefits from rebalancing on join.
   */
  strategy?: PlacementStrategy;

  /**
   * Which event triggers a rebalance pass. Default: 'member-joined'.
   */
  trigger?: RebalanceTrigger;

  /**
   * Random delay (ms) applied before evaluation begins.
   * Effective sleep is `jitterMs * Math.random()`. Default: 2000.
   *
   * Jitter de-synchronizes rebalance passes across nodes so that several
   * nodes do not all attempt to transfer to the same new joiner at once.
   */
  jitterMs?: number;

  /**
   * Maximum number of `router.transfer()` calls per second across this
   * policy instance. Default: 5. Excess transfers are spaced out, never
   * dropped. Use 0 to disable throttling.
   */
  maxTransfersPerSecond?: number;

  /**
   * Skip a transfer when the load delta between local and ideal nodes is
   * below this fraction of the local load. Default: 0.2.
   *
   * Concretely: if local owns N resources and ideal owns M, the transfer
   * is skipped when `(N - M) / max(N, 1) < targetLoadDelta`. This avoids
   * rebalance churn on near-balanced clusters where the placement strategy
   * still emits a different node.
   */
  targetLoadDelta?: number;

  /**
   * Interval (ms) for the 'periodic' trigger. Ignored otherwise.
   * Default: 30_000.
   */
  periodicIntervalMs?: number;
}

interface ScheduledTransfer {
  resourceId: string;
  targetNodeId: string;
}

/**
 * RebalancePolicy — symmetric counterpart to AutoReclaimPolicy.
 *
 * AutoReclaimPolicy reacts to `resource:orphaned` (member-left) and
 * re-places dead-owner resources. RebalancePolicy reacts to
 * `member-joined` (or another configurable trigger) and migrates
 * locally-owned resources to their ideal owner under the configured
 * placement strategy.
 *
 * Walks ONLY resources owned by the local node — does not implement the
 * `evaluate: 'all-cluster'` mode (that needs core-team direction per the
 * GAPS doc).
 *
 * Lifecycle: call start() to subscribe to the trigger; call stop() to
 * unsubscribe and clear pending timers/throttle queue.
 *
 * Events:
 *  rebalance:scheduled    — trigger fired; rebalance pass scheduled after jitter
 *  rebalance:evaluated    — pass completed; emitted with { transferred, skipped }
 *  rebalance:transferred  — a single resource was transferred
 *  rebalance:skipped      — a single resource was not transferred (with reason)
 *  rebalance:failed       — `router.transfer()` threw for a resource
 */
export class RebalancePolicy extends EventEmitter implements LifecycleAware {
  private readonly router: ResourceRouter;
  private readonly strategy: PlacementStrategy;
  private readonly trigger: RebalanceTrigger;
  private readonly jitterMs: number;
  private readonly maxTransfersPerSecond: number;
  private readonly targetLoadDelta: number;
  private readonly periodicIntervalMs: number;

  private started = false;
  private readonly jitterTimers = new Set<NodeJS.Timeout>();
  private readonly throttleTimers = new Set<NodeJS.Timeout>();
  private periodicTimer: NodeJS.Timeout | null = null;

  // Throttle bookkeeping: timestamps (ms) of the most recent transfers,
  // capped at maxTransfersPerSecond. Used to compute the next allowed
  // transfer time within a sliding 1-second window.
  private readonly recentTransferTimes: number[] = [];

  private readonly _onTriggerEvent: () => void;

  constructor(router: ResourceRouter, config?: RebalancePolicyConfig) {
    super();
    this.router = router;
    this.strategy = config?.strategy ?? new HashPlacement();
    this.trigger = config?.trigger ?? 'member-joined';
    this.jitterMs = config?.jitterMs ?? 2000;
    this.maxTransfersPerSecond = config?.maxTransfersPerSecond ?? 5;
    this.targetLoadDelta = config?.targetLoadDelta ?? 0.2;
    this.periodicIntervalMs = config?.periodicIntervalMs ?? 30_000;

    this._onTriggerEvent = () => this._scheduleRebalance();
  }

  isStarted(): boolean {
    return this.started;
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;

    if (this.trigger === 'member-joined' || this.trigger === 'member-left') {
      // ResourceRouter holds the cluster reference; we subscribe via the
      // same ClusterManager it uses. Going through the router keeps the
      // surface area matching AutoReclaimPolicy (which uses
      // router.on('resource:orphaned', ...)).
      const cluster = this._getCluster();
      cluster.on(this.trigger, this._onTriggerEvent);
    } else if (this.trigger === 'periodic') {
      this.periodicTimer = setInterval(
        this._onTriggerEvent,
        this.periodicIntervalMs
      );
      this.periodicTimer.unref?.();
    }

    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (!this.started) return Promise.resolve();
    this.started = false;

    if (this.trigger === 'member-joined' || this.trigger === 'member-left') {
      const cluster = this._getCluster();
      cluster.off(this.trigger, this._onTriggerEvent);
    }

    if (this.periodicTimer !== null) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }

    for (const t of this.jitterTimers) clearTimeout(t);
    this.jitterTimers.clear();
    for (const t of this.throttleTimers) clearTimeout(t);
    this.throttleTimers.clear();
    this.recentTransferTimes.length = 0;

    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Reach into the router to get the underlying cluster emitter.
   * ResourceRouter does not expose `cluster` publicly, but it does expose
   * `getAliveNodeIds()` and forwards `member-left` events; for
   * `member-joined` we need direct access. We do this by subscribing
   * through a small getter on the router. To keep the test surface
   * narrow, we rely on the router constructor having stored the cluster.
   */
  private _getCluster(): {
    on: (event: string, handler: (...args: any[]) => void) => void;
    off: (event: string, handler: (...args: any[]) => void) => void;
  } {
    // Access via bracket to avoid TS private-field error; the ResourceRouter
    // class stores the ClusterManager on `this.cluster`.
    const cluster = (this.router as unknown as { cluster: any }).cluster;
    if (cluster === undefined || cluster === null) {
      throw new Error(
        'RebalancePolicy: ResourceRouter has no associated cluster manager'
      );
    }
    return cluster;
  }

  private _scheduleRebalance(): void {
    if (!this.started) return;

    const delay = Math.random() * this.jitterMs;
    this.emit('rebalance:scheduled', { delayMs: delay });

    const timer = setTimeout(() => {
      this.jitterTimers.delete(timer);
      this._evaluate().catch((err) => {
        this.emit(
          'rebalance:failed',
          null,
          err instanceof Error ? err : new Error(String(err))
        );
      });
    }, delay);
    timer.unref?.();
    this.jitterTimers.add(timer);
  }

  private async _evaluate(): Promise<void> {
    if (!this.started) return;

    const localNodeId = this.router.nodeId;
    const candidates = this.router.getAliveNodeIds();
    const owned = this.router.getOwnedResources();
    const allKnown = this.router.getAllResources();

    // Pre-compute load (resource count) per candidate node from the router's
    // global view, used for the targetLoadDelta gate.
    const loadByNode = new Map<string, number>(
      candidates.map((id) => [id, 0])
    );
    for (const handle of allKnown) {
      const c = loadByNode.get(handle.ownerNodeId);
      if (c !== undefined) loadByNode.set(handle.ownerNodeId, c + 1);
    }

    const transfers: ScheduledTransfer[] = [];
    let skippedCount = 0;

    for (const handle of owned) {
      const ideal = this.strategy.selectNode(
        handle.resourceId,
        localNodeId,
        candidates
      );

      if (ideal === localNodeId) {
        this.emit('rebalance:skipped', handle.resourceId, 'already-ideal');
        skippedCount++;
        continue;
      }

      if (!candidates.includes(ideal)) {
        this.emit('rebalance:skipped', handle.resourceId, 'ideal-not-alive');
        skippedCount++;
        continue;
      }

      const localLoad = loadByNode.get(localNodeId) ?? owned.length;
      const idealLoad = loadByNode.get(ideal) ?? 0;
      const denom = Math.max(localLoad, 1);
      const delta = (localLoad - idealLoad) / denom;
      if (delta < this.targetLoadDelta) {
        this.emit(
          'rebalance:skipped',
          handle.resourceId,
          'below-load-delta'
        );
        skippedCount++;
        continue;
      }

      transfers.push({ resourceId: handle.resourceId, targetNodeId: ideal });
      // Optimistically update the in-memory load map so downstream resources
      // in this same pass observe the rebalance progress.
      loadByNode.set(localNodeId, Math.max(0, (loadByNode.get(localNodeId) ?? 1) - 1));
      loadByNode.set(ideal, idealLoad + 1);
    }

    let transferredCount = 0;
    for (const t of transfers) {
      try {
        await this._throttledTransfer(t.resourceId, t.targetNodeId);
        transferredCount++;
      } catch (err) {
        this.emit(
          'rebalance:failed',
          t.resourceId,
          err instanceof Error ? err : new Error(String(err))
        );
      }
    }

    this.emit('rebalance:evaluated', {
      transferred: transferredCount,
      skipped: skippedCount,
      considered: owned.length,
    });
  }

  private async _throttledTransfer(
    resourceId: string,
    targetNodeId: string
  ): Promise<void> {
    if (this.maxTransfersPerSecond > 0) {
      await this._waitForThrottleSlot();
    }
    if (!this.started) return;

    const handle = await this.router.transfer(resourceId, targetNodeId);
    this.recentTransferTimes.push(Date.now());
    // Keep the rolling window bounded.
    while (this.recentTransferTimes.length > this.maxTransfersPerSecond) {
      this.recentTransferTimes.shift();
    }
    this.emit('rebalance:transferred', handle as ResourceHandle);
  }

  private _waitForThrottleSlot(): Promise<void> {
    const limit = this.maxTransfersPerSecond;
    const now = Date.now();
    const windowStart = now - 1000;
    while (
      this.recentTransferTimes.length > 0 &&
      this.recentTransferTimes[0] < windowStart
    ) {
      this.recentTransferTimes.shift();
    }
    if (this.recentTransferTimes.length < limit) {
      return Promise.resolve();
    }
    // Need to wait until the oldest transfer in the window ages out.
    const earliest = this.recentTransferTimes[0];
    const waitMs = Math.max(0, earliest + 1000 - now);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.throttleTimers.delete(timer);
        resolve();
      }, waitMs);
      timer.unref?.();
      this.throttleTimers.add(timer);
    });
  }
}
