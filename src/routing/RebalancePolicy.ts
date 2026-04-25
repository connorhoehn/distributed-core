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

/**
 * Caller-supplied function used to ask peer nodes for their current load.
 *
 * The contract is intentionally narrow: return a Map keyed by nodeId of the
 * loads the caller currently knows about. Inclusion of the local node is
 * optional — RebalancePolicy will fill in (or override) the local entry from
 * its own measurement.
 *
 * Wire this through whatever telemetry channel the integrator already runs
 * (PubSub, Prometheus scrape, gossip metadata, ...). RebalancePolicy treats
 * the response as point-in-time and does no caching beyond the dampening
 * window for the local node.
 *
 * Returning a Map with one or zero peer entries (i.e. only knowing the
 * local node) causes the policy to no-op with a `peer-load-unavailable`
 * warning emitted as `rebalance:skipped`.
 */
export type PeerLoadProvider = () => Promise<Map<string, number>>;

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
   * Interval (ms) for the 'periodic' trigger. Ignored otherwise.
   * Default: 30_000.
   */
  periodicIntervalMs?: number;

  /**
   * Caller-provided load function. Maps a resourceId to a numeric weight
   * representing its current load contribution. Default: `() => 1`
   * (count-based — every owned resource contributes 1).
   *
   * Examples:
   *  - SFU: `(rid) => egressBpsByRoom.get(rid) ?? 0`
   *  - Gateway: `(rid) => activePipelineRunsByJob.get(rid) ?? 0`
   *  - Default: count of owned resources.
   *
   * The function MUST be cheap (called once per locally-owned resource on
   * every trigger fire) and MUST NOT throw. Negative values are coerced
   * to 0; NaN is treated as 0.
   */
  loadFn?: (resourceId: string) => number;

  /**
   * Asymmetric trigger threshold: the policy only rebalances when this
   * node's load is more than `(1 + thresholdAboveMean) * clusterMean`.
   * Default: 0.20 (20% above the cluster mean).
   *
   * "Asymmetric" means: a node BELOW the mean never rebalances toward
   * itself — only over-loaded nodes shed work. This is the convergence
   * shape both the SFU and gateway integrations independently asked for.
   */
  thresholdAboveMean?: number;

  /**
   * Sliding window (ms) over which `localLoad` samples are retained for
   * P95 dampening. Default: 60_000 (60s).
   *
   * Each trigger fire records one sample of the current localLoad. The
   * window is bounded by wall-clock age, not sample count.
   */
  dampeningWindowMs?: number;

  /**
   * Percentile of the dampening window used as the spike-resistant
   * load estimate. Default: 0.95 (P95).
   *
   * The smaller this is, the more aggressive (more reactive); the
   * larger, the more conservative (slower to act on sustained load).
   */
  dampeningPercentile?: number;

  /**
   * Caller-provided source of peer loads. Without this, RebalancePolicy
   * cannot compute a cluster mean and degrades to a no-op (with a
   * one-time-per-pass `rebalance:skipped` warning, reason
   * `peer-load-unavailable`).
   *
   * The provider is invoked once per rebalance pass, after jitter and
   * after the local sample has been recorded. It is async to allow
   * scrape-based implementations.
   */
  peerLoadProvider?: PeerLoadProvider;
}

/**
 * Smoothing factor applied to the dampening-side guard. The instantaneous
 * `localLoad / clusterMean` ratio must clear `1 + thresholdAboveMean`, but
 * the P95-of-window ratio only needs to clear
 * `1 + thresholdAboveMean * DAMPENING_SMOOTHING_FACTOR`.
 *
 * The intent is: if instantaneous load JUST barely crosses the threshold,
 * the dampened view is allowed to be slightly more permissive (we'd
 * otherwise need P95 to cross the same line, which by construction lags
 * the instantaneous value). 0.85 is empirical — it lets a sustained burst
 * trigger but a single spike does not, while still requiring some
 * dampened evidence (not pure instantaneous reactivity).
 */
const DAMPENING_SMOOTHING_FACTOR = 0.85;

interface ScheduledTransfer {
  resourceId: string;
  targetNodeId: string;
}

interface DampeningSample {
  t: number;
  load: number;
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
 * The decision algorithm is **cluster-mean-relative with asymmetric
 * triggering and P95 dampening over a sliding window**:
 *
 *   1. Sleep `jitterMs * random()`.
 *   2. Compute `localLoad = sum(loadFn(r) for r in locallyOwnedResources)`.
 *   3. Append the sample to the dampening window; evict aged-out samples.
 *   4. Ask `peerLoadProvider()` for peer loads. If the result yields no
 *      peers, no-op with `peer-load-unavailable`.
 *   5. Compute `clusterMean = average(allNodeLoads)`. (Local entry is
 *      taken from our own measurement, overriding any value the provider
 *      reported for ourselves.)
 *   6. Asymmetric guard:
 *        localLoad / clusterMean > 1 + thresholdAboveMean
 *      AND
 *        p95(window) / clusterMean
 *          > 1 + thresholdAboveMean * DAMPENING_SMOOTHING_FACTOR
 *      Both must hold.
 *   7. If guard passes, walk locally-owned resources; for each, ask the
 *      strategy. If `ideal !== local`, transfer. Throttle by
 *      `maxTransfersPerSecond`.
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
 *  rebalance:skipped      — a single resource (or whole pass) was not transferred
 *                           (with reason: 'already-ideal' | 'ideal-not-alive' |
 *                           'peer-load-unavailable' | 'below-threshold' |
 *                           'dampened')
 *  rebalance:failed       — `router.transfer()` threw for a resource
 */
export class RebalancePolicy extends EventEmitter implements LifecycleAware {
  private readonly router: ResourceRouter;
  private readonly strategy: PlacementStrategy;
  private readonly trigger: RebalanceTrigger;
  private readonly jitterMs: number;
  private readonly maxTransfersPerSecond: number;
  private readonly periodicIntervalMs: number;
  private readonly loadFn: (resourceId: string) => number;
  private readonly thresholdAboveMean: number;
  private readonly dampeningWindowMs: number;
  private readonly dampeningPercentile: number;
  private readonly peerLoadProvider: PeerLoadProvider | null;

  private started = false;
  private readonly jitterTimers = new Set<NodeJS.Timeout>();
  private readonly throttleTimers = new Set<NodeJS.Timeout>();
  private periodicTimer: NodeJS.Timeout | null = null;

  // Throttle bookkeeping: timestamps (ms) of the most recent transfers,
  // capped at maxTransfersPerSecond. Used to compute the next allowed
  // transfer time within a sliding 1-second window.
  private readonly recentTransferTimes: number[] = [];

  // Dampening window: append-only ring of (timestamp, load) samples.
  // Aged out by wall-clock at the start of each pass.
  private readonly loadSamples: DampeningSample[] = [];

  private readonly _onTriggerEvent: () => void;

  constructor(router: ResourceRouter, config?: RebalancePolicyConfig) {
    super();
    this.router = router;
    this.strategy = config?.strategy ?? new HashPlacement();
    this.trigger = config?.trigger ?? 'member-joined';
    this.jitterMs = config?.jitterMs ?? 2000;
    this.maxTransfersPerSecond = config?.maxTransfersPerSecond ?? 5;
    this.periodicIntervalMs = config?.periodicIntervalMs ?? 30_000;
    this.loadFn = config?.loadFn ?? (() => 1);
    this.thresholdAboveMean = config?.thresholdAboveMean ?? 0.2;
    this.dampeningWindowMs = config?.dampeningWindowMs ?? 60_000;
    this.dampeningPercentile = config?.dampeningPercentile ?? 0.95;
    this.peerLoadProvider = config?.peerLoadProvider ?? null;

    this._onTriggerEvent = () => this._scheduleRebalance();
  }

  isStarted(): boolean {
    return this.started;
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;

    if (this.trigger === 'member-joined' || this.trigger === 'member-left') {
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
    this.loadSamples.length = 0;

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
   * through a small getter on the router.
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

  /**
   * Coerce a loadFn result into a non-negative finite number. NaN, -Infinity,
   * +Infinity, and negatives all collapse to 0 — the policy treats unmeasurable
   * load as "no load" rather than failing the entire pass.
   */
  private _safeLoad(resourceId: string): number {
    let v: number;
    try {
      v = this.loadFn(resourceId);
    } catch {
      return 0;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
    return v;
  }

  /**
   * Compute the configured percentile (e.g. 0.95) over the dampening window.
   * Uses linear interpolation between the two surrounding samples — close
   * enough for steady-state dampening; we don't need perfect tail accuracy.
   * Returns 0 if the window is empty.
   */
  private _percentileOfWindow(now: number): number {
    // Evict aged-out samples in place.
    const cutoff = now - this.dampeningWindowMs;
    while (
      this.loadSamples.length > 0 &&
      this.loadSamples[0].t < cutoff
    ) {
      this.loadSamples.shift();
    }
    if (this.loadSamples.length === 0) return 0;

    const sorted = this.loadSamples
      .map((s) => s.load)
      .sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0];

    const rank = this.dampeningPercentile * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return sorted[lo];
    const frac = rank - lo;
    return sorted[lo] * (1 - frac) + sorted[hi] * frac;
  }

  private async _evaluate(): Promise<void> {
    if (!this.started) return;

    const localNodeId = this.router.nodeId;
    const candidates = this.router.getAliveNodeIds();
    const owned = this.router.getOwnedResources();

    // Step 2: localLoad
    let localLoad = 0;
    for (const handle of owned) {
      localLoad += this._safeLoad(handle.resourceId);
    }

    // Step 3: append sample, compute P95 over window.
    const now = Date.now();
    this.loadSamples.push({ t: now, load: localLoad });
    const p95 = this._percentileOfWindow(now);

    // Step 4: peer load provider.
    if (this.peerLoadProvider === null) {
      this.emit(
        'rebalance:skipped',
        null,
        'peer-load-unavailable'
      );
      this.emit('rebalance:evaluated', {
        transferred: 0,
        skipped: 1,
        considered: owned.length,
        reason: 'peer-load-unavailable',
      });
      return;
    }

    let peerLoads: Map<string, number>;
    try {
      peerLoads = await this.peerLoadProvider();
    } catch (err) {
      this.emit(
        'rebalance:failed',
        null,
        err instanceof Error ? err : new Error(String(err))
      );
      return;
    }
    if (!this.started) return;

    // Override the local entry with our own measurement — it's the
    // authoritative source-of-truth for ourselves.
    const allLoads = new Map<string, number>(peerLoads);
    allLoads.set(localNodeId, localLoad);

    // If we only know our own load (no peers reported), no-op.
    if (allLoads.size < 2) {
      this.emit(
        'rebalance:skipped',
        null,
        'peer-load-unavailable'
      );
      this.emit('rebalance:evaluated', {
        transferred: 0,
        skipped: 1,
        considered: owned.length,
        reason: 'peer-load-unavailable',
      });
      return;
    }

    // Step 5: cluster mean.
    let sum = 0;
    for (const v of allLoads.values()) sum += v;
    const clusterMean = sum / allLoads.size;

    // If the cluster mean is zero, no relative comparison makes sense.
    if (clusterMean <= 0) {
      this.emit('rebalance:skipped', null, 'below-threshold');
      this.emit('rebalance:evaluated', {
        transferred: 0,
        skipped: 1,
        considered: owned.length,
        reason: 'below-threshold',
      });
      return;
    }

    // Step 6: asymmetric guard with dampening.
    const ratio = localLoad / clusterMean;
    const dampenedRatio = p95 / clusterMean;
    const instantaneousGate = 1 + this.thresholdAboveMean;
    const dampenedGate =
      1 + this.thresholdAboveMean * DAMPENING_SMOOTHING_FACTOR;

    if (ratio <= instantaneousGate) {
      this.emit('rebalance:skipped', null, 'below-threshold');
      this.emit('rebalance:evaluated', {
        transferred: 0,
        skipped: 1,
        considered: owned.length,
        reason: 'below-threshold',
      });
      return;
    }
    if (dampenedRatio <= dampenedGate) {
      this.emit('rebalance:skipped', null, 'dampened');
      this.emit('rebalance:evaluated', {
        transferred: 0,
        skipped: 1,
        considered: owned.length,
        reason: 'dampened',
      });
      return;
    }

    // Step 7: walk owned resources and schedule transfers.
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

      transfers.push({ resourceId: handle.resourceId, targetNodeId: ideal });
    }

    let transferredCount = 0;
    for (const t of transfers) {
      try {
        await this._throttledTransfer(t.resourceId, t.targetNodeId);
        transferredCount++;
      } catch (err: unknown) {
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
