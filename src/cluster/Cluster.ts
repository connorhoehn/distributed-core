/**
 * Cluster — top-level facade that absorbs the 5-object boilerplate that every
 * distributed-core consumer otherwise has to write by hand.
 *
 * The facade wires:
 *   PubSubManager      (in-memory or Redis)
 *   EntityRegistry     (memory | wal | crdt)
 *   EntityRegistrySyncAdapter
 *   ClusterManager + FailureDetector
 *   ResourceRouter
 *   DistributedLock
 *   AutoReclaimPolicy  (default-on; pass autoReclaim: false to skip)
 *   ClusterLeaderElection (lazy, per groupId)
 *
 * Lifecycle ordering — start():
 *   registry → sync → cluster → router → lock → autoReclaim
 * stop() reverses the order. Consumers call cluster.start() / cluster.stop()
 * once; the facade owns ordering.
 *
 * Power users can still reach the underlying primitives via the readonly
 * fields (router, registry, lock, pubsub, clusterManager, failureDetector)
 * and compose lower-level behavior on top.
 */

import { ClusterManager } from './ClusterManager';
import { FailureDetector } from '../monitoring/FailureDetector';
import { BootstrapConfig } from '../config/BootstrapConfig';
import { Transport } from '../transport/Transport';
import { InMemoryAdapter } from '../transport/adapters/InMemoryAdapter';

import { EntityRegistry } from './entity/types';
import { EntityRegistryFactory } from './entity/EntityRegistryFactory';
import { EntityRegistrySyncAdapter } from './entity/EntityRegistrySyncAdapter';
import { CrdtRegistryOptions } from './entity/CrdtEntityRegistry';

import { PubSubManager } from '../gateway/pubsub/PubSubManager';
import type { RedisPubSubManagerConfig, RedisLikeClient } from '../gateway/pubsub/RedisPubSubManager';

import { ResourceRouter } from '../routing/ResourceRouter';
import { LocalPlacement } from '../routing/PlacementStrategy';
import { PlacementStrategy } from '../routing/types';
import { AutoReclaimPolicy } from '../routing/AutoReclaimPolicy';

import { DistributedLock } from './locks/DistributedLock';
import { ClusterLeaderElection, ClusterLeaderElectionConfig } from './locks/ClusterLeaderElection';

import { MetricsRegistry } from '../monitoring/metrics/MetricsRegistry';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structural-superset Logger interface. Both `pino()` (Pino) and
 * `winston.createLogger()` (Winston, with `format.simple()`) satisfy this
 * shape, so consumers can drop in either without an adapter. If `logger` is
 * omitted from {@link ClusterConfig}, the facade uses a no-op (it does NOT
 * print to console).
 */
export interface Logger {
  trace?(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export type TransportConfig =
  | { type: 'memory' }
  | {
      type: 'redis';
      url: string;
      /**
       * Optional client factory. Forwarded to {@link RedisPubSubManagerConfig.createClient}.
       * Useful for tests and custom socket / TLS options.
       */
      createClient?: () => RedisLikeClient | Promise<RedisLikeClient>;
    };

export type RegistryConfig =
  | { type: 'memory' }
  | { type: 'wal'; walPath: string }
  | { type: 'crdt'; crdtOptions?: CrdtRegistryOptions };

export interface ClusterFailureDetectionConfig {
  heartbeatMs?: number;
  deadTimeoutMs?: number;
  activeProbing?: boolean;
}

export interface ClusterAutoReclaimConfig {
  jitterMs?: number;
}

export interface ClusterLocksConfig {
  ttlMs?: number;
}

export interface ClusterConfig {
  // ---- REQUIRED — no defaults; consumers must make explicit ops decisions ----
  nodeId: string;
  topic: string;
  transport: TransportConfig;
  registry: RegistryConfig;

  // ---- DEFAULTED ----
  placement?: PlacementStrategy;
  failureDetection?: ClusterFailureDetectionConfig;
  /**
   * AutoReclaim is **default-on** with `jitterMs: 500`. Pass `false` to skip
   * starting the policy entirely (e.g. when you want to drive reclaim
   * yourself).
   */
  autoReclaim?: false | ClusterAutoReclaimConfig;
  locks?: ClusterLocksConfig;

  // ---- OPTIONAL plumbing — no defaults ----
  metrics?: MetricsRegistry;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_FAILURE_DETECTION: Required<ClusterFailureDetectionConfig> = {
  heartbeatMs: 1000,
  deadTimeoutMs: 6000,
  activeProbing: true,
};

const DEFAULT_AUTO_RECLAIM: Required<ClusterAutoReclaimConfig> = {
  jitterMs: 500,
};

const NOOP_LOGGER: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireField<T>(value: T | undefined, name: string): asserts value is T {
  if (value === undefined || value === null || (typeof value === 'string' && value.length === 0)) {
    throw new Error(
      `Cluster.create: '${name}' is required. The Cluster facade has no default for this field — ` +
        `it forces an explicit operational decision.`
    );
  }
}

/**
 * Lazy-load the Redis PubSub adapter. Mirrors the
 * {@link RedisPubSubManager.defaultClientFactory} pattern: the `redis` package
 * is an optional peer dependency and is NOT a regular dependency of this
 * library. Importing this module is fine without it; only constructing a
 * Redis-backed Cluster pulls it in, and we throw a clear actionable error if
 * the package is missing.
 */
function loadRedisPubSubManager(): typeof import('../gateway/pubsub/RedisPubSubManager').RedisPubSubManager {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../gateway/pubsub/RedisPubSubManager');
    return mod.RedisPubSubManager;
  } catch (err: unknown) {
    throw new Error(
      "Cluster: failed to load RedisPubSubManager. The 'redis' peer dependency is " +
        'required for transport.type=\'redis\'. Install it with `npm install redis@^5`.'
    );
  }
}

/**
 * Minimal duck-typed PubSub surface needed by EntityRegistrySyncAdapter +
 * any sync-style consumers. Intentionally narrower than PubSubManager so
 * RedisPubSubManager can stand in by structural typing.
 */
interface PubSubLike {
  subscribe(topic: string, handler: (topic: string, payload: unknown, meta: unknown) => void): string;
  unsubscribe(id: string): boolean | void;
  publish(topic: string, payload: unknown): Promise<void>;
}

interface LifecycleLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  isStarted?(): boolean;
}

// ---------------------------------------------------------------------------
// Cluster facade
// ---------------------------------------------------------------------------

export class Cluster {
  // Composed primitives — exposed for power users who need to drop down a level
  readonly router: ResourceRouter;
  readonly registry: EntityRegistry;
  readonly lock: DistributedLock;
  readonly pubsub: PubSubManager;
  readonly clusterManager: ClusterManager;
  readonly failureDetector: FailureDetector;

  // Internals owned by the facade
  private readonly _nodeId: string;
  private readonly _topic: string;
  private readonly _logger: Logger;
  private readonly _config: ClusterConfig;

  private readonly _syncAdapter: EntityRegistrySyncAdapter;
  private readonly _autoReclaim: AutoReclaimPolicy | null;
  private readonly _transport: Transport;
  private readonly _pubsubIsLifecycle: boolean;

  private readonly _elections = new Map<string, ClusterLeaderElection>();
  private _started = false;

  private constructor(
    config: ClusterConfig,
    transport: Transport,
    pubsub: PubSubManager,
    pubsubIsLifecycle: boolean,
    registry: EntityRegistry,
    clusterManager: ClusterManager,
    syncAdapter: EntityRegistrySyncAdapter,
    router: ResourceRouter,
    lock: DistributedLock,
    autoReclaim: AutoReclaimPolicy | null,
  ) {
    this._config = config;
    this._nodeId = config.nodeId;
    this._topic = config.topic;
    this._logger = config.logger ?? NOOP_LOGGER;
    this._transport = transport;
    this.pubsub = pubsub;
    this._pubsubIsLifecycle = pubsubIsLifecycle;
    this.registry = registry;
    this.clusterManager = clusterManager;
    this.failureDetector = clusterManager.failureDetector;
    this._syncAdapter = syncAdapter;
    this.router = router;
    this.lock = lock;
    this._autoReclaim = autoReclaim;
  }

  /**
   * Build a fully-wired Cluster from declarative config.
   *
   * Throws Error with an actionable message if any required field is missing.
   * Returns a Cluster that has NOT been started — call {@link start} next.
   */
  static async create(config: ClusterConfig): Promise<Cluster> {
    requireField(config?.nodeId, 'nodeId');
    requireField(config?.topic, 'topic');
    requireField(config?.transport, 'transport');
    requireField(config?.registry, 'registry');

    if (config.transport.type === 'redis') {
      requireField(config.transport.url, 'transport.url');
    }
    if (config.registry.type === 'wal') {
      requireField((config.registry as { walPath: string }).walPath, 'registry.walPath');
    }

    const nodeId = config.nodeId;
    const topic = config.topic;
    const fdCfg = { ...DEFAULT_FAILURE_DETECTION, ...(config.failureDetection ?? {}) };

    // (1) Registry
    const registry = EntityRegistryFactory.create({
      type: config.registry.type,
      nodeId,
      walConfig:
        config.registry.type === 'wal'
          ? { filePath: (config.registry as { walPath: string }).walPath }
          : undefined,
      crdtOptions:
        config.registry.type === 'crdt'
          ? (config.registry as { crdtOptions?: CrdtRegistryOptions }).crdtOptions
          : undefined,
    });

    // (2) Transport + ClusterManager (provides FailureDetector + membership for ResourceRouter)
    const transport = new InMemoryAdapter({ id: nodeId, address: '127.0.0.1', port: 0 });
    const bootstrapConfig = BootstrapConfig.create({
      seedNodes: [],
      gossipInterval: 1000,
      enableLogging: false,
      failureDetector: {
        heartbeatInterval: fdCfg.heartbeatMs,
        deadTimeout: fdCfg.deadTimeoutMs,
        enableActiveProbing: fdCfg.activeProbing,
      },
    });
    const clusterManager = new ClusterManager(nodeId, transport, bootstrapConfig);

    // (3) PubSub — in-memory uses the production PubSubManager (which itself
    //     piggybacks on Transport for cross-node delivery; with InMemoryAdapter
    //     it stays in-process). Redis branch lazy-loads the optional peer dep.
    let pubsub: PubSubManager;
    let pubsubIsLifecycle = false;
    if (config.transport.type === 'memory') {
      pubsub = new PubSubManager(nodeId, transport, clusterManager);
    } else {
      const RedisCtor = loadRedisPubSubManager();
      const redisCfg: RedisPubSubManagerConfig = {
        localNodeId: nodeId,
        url: config.transport.url,
        createClient: config.transport.createClient,
      };
      // RedisPubSubManager is a structural superset of the surface we need.
      // The cast is local to the facade so consumers see the unified type.
      pubsub = new RedisCtor(redisCfg) as unknown as PubSubManager;
      pubsubIsLifecycle = true;
    }

    // (4) Sync adapter — bridges registry events ↔ pubsub topic
    const syncAdapter = new EntityRegistrySyncAdapter(
      registry,
      pubsub as unknown as PubSubManager,
      nodeId,
      { topic },
    );

    // (5) Router (placement default = LocalPlacement)
    const router = new ResourceRouter(nodeId, registry, clusterManager, {
      placement: config.placement ?? new LocalPlacement(),
      metrics: config.metrics,
    });

    // (6) Lock
    const lock = new DistributedLock(registry, nodeId, {
      defaultTtlMs: config.locks?.ttlMs,
      metrics: config.metrics,
    });

    // (7) AutoReclaim (default-on; pass `false` to disable)
    let autoReclaim: AutoReclaimPolicy | null = null;
    if (config.autoReclaim !== false) {
      const arCfg = { ...DEFAULT_AUTO_RECLAIM, ...((config.autoReclaim as ClusterAutoReclaimConfig) ?? {}) };
      autoReclaim = new AutoReclaimPolicy(router, {
        jitterMs: arCfg.jitterMs,
        strategy: config.placement,
      });
    }

    return new Cluster(
      config,
      transport,
      pubsub,
      pubsubIsLifecycle,
      registry,
      clusterManager,
      syncAdapter,
      router,
      lock,
      autoReclaim,
    );
  }

  /**
   * Lazily construct a {@link ClusterLeaderElection} for `groupId`, caching
   * the instance so subsequent calls with the same `groupId` return the same
   * election handle (and therefore share lifecycle + listener state). All
   * elections share the facade's `lock` and `router`.
   *
   * Election instances are NOT auto-started. Call `election.start()` yourself.
   * The facade's `stop()` will tear them all down.
   */
  election(groupId: string, config?: ClusterLeaderElectionConfig): ClusterLeaderElection {
    const existing = this._elections.get(groupId);
    if (existing !== undefined) return existing;
    const created = new ClusterLeaderElection(groupId, this._nodeId, this.lock, this.router, config);
    this._elections.set(groupId, created);
    return created;
  }

  isStarted(): boolean {
    return this._started;
  }

  /**
   * Start every primitive in the correct order:
   *   transport → pubsub (if lifecycle-managed) → registry → sync → cluster → router → lock-side → autoReclaim
   *
   * The lock has no explicit start() — it derives its lifecycle from the
   * registry it composes over. AutoReclaim is started last so it can
   * subscribe to the router's `resource:orphaned` events from the get-go.
   */
  async start(): Promise<void> {
    if (this._started) return;

    this._logger.info({ nodeId: this._nodeId, topic: this._topic }, 'cluster.starting');

    await this._transport.start();

    if (this._pubsubIsLifecycle) {
      await (this.pubsub as unknown as LifecycleLike).start();
    }

    await this.registry.start();
    await this._syncAdapter.start();
    await this.clusterManager.start();
    await this.router.start();

    if (this._autoReclaim !== null) {
      await this._autoReclaim.start();
    }

    this._started = true;
    this._logger.info({ nodeId: this._nodeId }, 'cluster.started');
  }

  /**
   * Stop in reverse order. Caches of leader-elections are torn down here so
   * a second `cluster.election('x')` after `stop() → start()` returns a fresh
   * instance instead of reviving a corpse.
   */
  async stop(): Promise<void> {
    if (!this._started) return;

    this._logger.info({ nodeId: this._nodeId }, 'cluster.stopping');

    // Stop elections first — they're the highest-level consumers
    for (const election of this._elections.values()) {
      try {
        await election.stop();
      } catch {
        // ignore — best-effort teardown
      }
    }
    this._elections.clear();

    if (this._autoReclaim !== null) {
      await this._autoReclaim.stop();
    }
    await this.router.stop();
    await this.clusterManager.stop();
    await this._syncAdapter.stop();
    await this.registry.stop();

    if (this._pubsubIsLifecycle) {
      try {
        await (this.pubsub as unknown as LifecycleLike).stop();
      } catch {
        // ignore
      }
    } else {
      // PubSubManager (in-memory) has no async stop, only `destroy()`
      try {
        (this.pubsub as unknown as { destroy?: () => void }).destroy?.();
      } catch {
        // ignore
      }
    }

    await this._transport.stop();

    this._started = false;
    this._logger.info({ nodeId: this._nodeId }, 'cluster.stopped');
  }
}
