# Changelog

## Unreleased

### Deprecated

- Event names `member-joined`, `member-left`, `member-updated`,
  `membership-updated` are deprecated in favor of `member:joined`,
  `member:left`, `member:updated`, `membership:updated`. Both names
  fire simultaneously via a dual-emit bridge. Old names will be removed in
  a future release. Affected classes: `MembershipTable`, `ClusterManager`,
  `ChannelManager`, `PubSubManager`.
- Bare `started`, `stopped` events on `ClusterManager`, `ClusterLifecycle`
  (both `src/cluster/lifecycle/` and `src/cluster/core/lifecycle/`),
  `ObservabilityManager`, and `ClusterTopologyManager` are deprecated in
  favor of `lifecycle:started` and `lifecycle:stopped`. Same dual-emit
  strategy applies — old names continue to fire.
- The bare `error` event on `ClusterLifecycle`, `ObservabilityManager`, and
  `ClusterTopologyManager` is intentionally **not** dual-emitted. Node's
  `EventEmitter` treats unhandled `error` events specially (throws if no
  listener); adding a silent alias would suppress that safety mechanism.
  Those classes will adopt `lifecycle:error` in a future breaking release.

### Added

- `PipelineModule.getPendingApprovals(): PendingApprovalRow[]` — returns structured rows for every approval step currently awaiting a decision on this node. Each row includes `runId`, `stepId`, `pipelineId`, `approvers`, optional `message`, and `requestedAt` (ISO 8601). Synchronous; data is in-memory. Intended for the `PendingApprovalsPage` bridge call — cluster-wide aggregation is the bridge's responsibility.
- `PendingApprovalRow` type exported from `distributed-core` (via `src/applications/pipeline/PipelineModule.ts`).

### Added — primitives and modules

- `LifecycleAware` interface in `src/common/LifecycleAware.ts`. All primitives
  with explicit start/stop declare `implements LifecycleAware` and expose
  `isStarted(): boolean`. Calls to `start()` and `stop()` are idempotent.
  Now extended to legacy modules: `ClusterManager`, `GossipStrategy`,
  `FailureDetector`.
- `CoreError` base class in `src/common/errors.ts` with subclasses:
  `NotStartedError`, `AlreadyStartedError`, `ConflictError`, `TimeoutError`,
  `InvalidTransferTargetError`, `NotOwnedError`, `SessionNotLocalError`,
  `WalNotConfiguredError`, `RemoteOwnerError`, plus reparented
  `LocalResourceError` and `UnroutableResourceError`.
- `ConfigManager` + `ServiceRegistry` primitives (typed distributed config,
  service discovery with selection strategies).
- `EntityRegistrySyncAdapter` — generic cross-node sync for any
  `EntityRegistry` (replaces the per-primitive sync pattern).
- `AutoReclaimPolicy` — observer that re-claims orphaned resources via the
  configured `PlacementStrategy`.
- `ClusterLeaderElection` — leader identity made cluster-visible via
  `ResourceRouter`.
- `QuorumDistributedLock` — majority-ACK lock over PubSub.
- `DistributedSession` — owned session containers with idle eviction.
- `SharedStateManager` — refactored onto `DistributedSession`, removing
  ~92 lines of duplicate ownership/eviction code (breaking constructor change).
- `FailureDetectorBridge` — translates `node-failed` events into cleanup on
  `ResourceRouter`, `ConnectionRegistry`, and `DistributedLock`.
- `ConnectionRegistry` — TTL-heartbeat connection ownership; opt-in
  `allowReconnect` revives existing entries on duplicate registration.
- `ServiceRegistry` — pluggable per-endpoint health checks with
  `service:unhealthy` / `service:healthy` / `service:healthcheck-error` events.
- `EventBus` — typed events with WAL persistence, durable subscriptions
  with checkpoint resume, configurable auto-compaction
  (`autoCompactIntervalMs`).
- `ForwardingRouter` + `HttpForwardingTransport` + `ForwardingServer` —
  pluggable cross-node RPC over an HTTP wire protocol.
- `BackpressureController` — per-key queues with drop-oldest /
  drop-newest / reject strategies + optional `RateLimiter`.
- `RateLimiter` — token-bucket per key with lazy refill.
- `MetricsRegistry` — Counter, Gauge, Histogram (bounded ring buffer).
  Optional `namespace` prefix and `defaultLabels` at construction; `child()`
  returns a sub-registry sharing the parent's store.
- `MetricsRegistry` integration: every primitive accepts an optional
  `metrics?: MetricsRegistry` config field with `?.`-guarded emissions.
- `PrometheusExporter` — `formatPrometheus()` and `PrometheusHttpExporter`
  (LifecycleAware, Node `http`).
- `WALSnapshotVersionStore` — durable snapshot store with `compact()`.
- `WriteAheadLogEntityRegistry.compact()` — log compaction for entity registries.
- `RealCompactionExecutor` (`src/persistence/compaction/`). All four
  compaction strategies (Time-, Size-Tiered-, Leveled-, Vacuum-Based) now
  perform real filesystem compaction when input segments exist; fall back
  to computed-metrics simulation otherwise (preserving unit-test
  compatibility).
- `EntityRegistryBootstrapper` (`src/cluster/entity/`) — snapshot-bootstrap
  for joining nodes. Performs a PubSub request/response round-trip to fetch
  current entity state from a peer before the joining node begins serving
  traffic. Complements `EntityRegistrySyncAdapter` (which handles incremental
  updates only).
- `PubSubHeartbeatSource` (`src/cluster/failure/`) — self-contained heartbeat
  driver that publishes heartbeat ticks over a PubSub topic, feeding
  `FailureDetector` without requiring the caller to manage a timer loop. Closes
  the "caller-wired heartbeat" gap noted in the Deferred section.
- `HttpsForwardingTransport` + `HttpsForwardingServer` (`src/routing/`) — TLS
  variants of `HttpForwardingTransport` / `ForwardingServer`. Identical wire
  protocol (POST `{pathPrefix}/{resourceId}`); transport layer upgraded to
  HTTPS. `HttpsForwardingTransport` uses a shared `HttpsAgent` for connection
  pooling and mTLS / CA-pinning via `tlsOptions`. `HttpsForwardingServer` wraps
  Node's `https.createServer` with the same `tlsOptions`.
- `ForwardingServer` `metricsRegistry` config field — mounts a Prometheus scrape
  endpoint at `GET /metrics` (configurable via `metricsPath`) on the same port
  as the forwarding server. Closes the "pull-based /metrics route" gap noted in
  the Deferred section.
- `RateLimiter.maxBuckets` and `idleEvictMs` — bounded bucket map; triggers lazy
  probabilistic eviction (1% chance per check) when `maxBuckets` is exceeded.
  Idle buckets (full and untouched for `idleEvictMs` ms) are evicted. Defaults:
  10 000 buckets, 5-minute idle TTL.
- `atomicWriteFile` and `fsyncFile` (`src/persistence/atomicWrite.ts`) —
  temp-write → fsync → rename helper used by WAL, snapshot, checkpoint, and
  compaction paths to guarantee durability on crash. `fsyncFile` flushes an
  existing file before unlinking input segments in a compaction pipeline.
- `SignedPubSubManager` — optional message authentication wrapper using
  `KeyManager`. Drops or flags unverified messages.
- `PipelineModule` + `PipelineExecutor` — server-side port of MockExecutor
  for cluster-aware pipeline execution. `LLMClient` is an interface only —
  vendor SDK implementations live in the consuming project.
  Phase-4 bridge surface: `getRun(runId)`, `getHistory(runId, fromVersion?)`,
  `listActiveRuns()`, `runsAwaitingApproval` metric, and a placeholder
  `pipeline.run.reassigned` event.

### Added — infrastructure and tooling

- `examples/cluster-collab/` — end-to-end demo composing 9 primitives,
  with multi-node failure / auto-reclaim simulation.
- `README.md`, `docs/ARCHITECTURE.md`, `docs/CLUSTER-READINESS-PLAN.md`,
  `docs/PIPELINE-INTEGRATION.md`, `docs/EVENT-NAME-AUDIT.md`,
  `docs/DEPLOYMENT.md`.
- `Dockerfile` (multi-stage, verified-building), `.dockerignore`,
  `k8s/` manifests (namespace, configmap, headless service, statefulset
  with anti-affinity + init container + probes).
- `benchmarks/` directory — per-primitive throughput + p50/p90/p99
  harness, runnable via `npm run bench`.
- `.gitignore` — keeps `node_modules/`, `dist/`, `coverage/`, `.claude/`
  out of commits.
- Multi-node integration test harness in `test/integration/helpers/`
  with `ClusterSimulator` for partition / heal / kill scenarios.

### Fixed

- `InMemoryEntityRegistry.applyRemoteUpdate` emits `entity:created` /
  `entity:updated` / `entity:deleted` / `entity:transferred` events, matching
  local-mutation paths. Required for `ConfigManager`,
  `EntityRegistrySyncAdapter`, and other downstream primitives.
- Persistence e2e test `high-throughput-compaction` now passes. Root cause:
  `TimeBasedCompactionStrategy.executeCompaction()` was simulated — no real
  I/O. Replaced with `RealCompactionExecutor`-backed path.
- Lint errors (45 → 0) blocking CI.
- Stale `test-e2e-chat` CI job + npm script removed (directory moved to
  `examples/` earlier).
- `EventBus` version counter resets on restart caused WAL collisions —
  counter now restored from max persisted version.
- `WALSnapshotVersionStore.compact()` propagates non-ENOENT unlink errors
  instead of silently swallowing them.
- `MetricsRegistry.Histogram` uses a bounded ring buffer (default 1000
  observations) — was unbounded.
- `DistributedSession.start/stop` lifecycle: `ownsRouter` config makes
  router shutdown opt-in for shared-router scenarios.
- `BackpressureController.drain()` now retries until queues are empty
  (previously a single flushAll, missed re-queued items on errors).
- `ConnectionRegistry.unregister()` logs via `defaultLogger.warn` instead
  of silently swallowing registry errors.

### Deprecated

- Pipeline event names using dot separators (`pipeline.run.started`, etc.)
  are deprecated in favor of colon-separated forms (`pipeline:run:started`,
  etc.). 22 names affected (all events in `PipelineEventMap`). Dual-emit
  active: the executor publishes both the canonical colon form and the legacy
  dot form on every event. Old dot-form names will be removed in a future
  major release. See `docs/EVENT-NAME-AUDIT.md` and
  `test/unit/applications/pipeline/EventRenameDeprecation.test.ts`.

### Test coverage

111 unit suites / 1921 tests; 39 integration suites / 274 tests; 6 e2e
persistence suites / ~40 tests; 12 e2e cluster + transport suites.
(+16 tests from EventRenameDeprecation suite.)

### Deferred (work explicitly out of scope this cycle)

- Method renames, constructor parameter standardization, event-name
  normalization (member-* / bare started/stopped/error).
  Catalog and rename targets in `docs/EVENT-NAME-AUDIT.md`. Pipeline
  events already renamed; member-* events are a separate task.
- CoreError migration extended to legacy modules (only new primitives
  swept; pre-session code untouched).
- Full partition-tolerance for `QuorumDistributedLock` (explicit non-goal —
  would require Raft/Paxos).
- TLS for `HttpForwardingTransport` — caller's responsibility.
- ~~Pull-based `/metrics` route on `ForwardingServer`.~~ Done: `metricsRegistry`
  config field added to `ForwardingServer`.
- ~~`FailureDetector` heartbeat over PubSub (currently caller-wired).~~ Done:
  `PubSubHeartbeatSource` ships.
- ~~State-snapshot bootstrap for newly-joining nodes.~~ Done:
  `EntityRegistryBootstrapper` ships.
