# State of the Repo — v0.2.0

Date: 2026-04-25
Tag: `v0.2.0` at `8d510fa`
Scope: full repo audit at the v0.2.0 release boundary

---

## Headline

Library is in **genuinely shippable shape for early consumers**. Not "production-ready" in the unqualified sense — there are documented sharp edges — but the failure modes are known, the audit findings are catalogued, and downstream consumers can wire up against a stable surface.

What's *not* here: real-workload validation. The websocket-gateway Phase-4 wire-up is the first consumer attempting non-test usage. Until that lands, every claim about behavior is "passes the test suite" not "works in production."

## Numbers

| | |
|---|---|
| TypeScript source files | 216 |
| Source lines | ~45,500 |
| Test files | 183 |
| Unit suites passing | 127/127 |
| Unit tests passing | 2,115 |
| Tests `it.todo()` | 29 (real outstanding work, surfaced) |
| Integration suites passing | 39 |
| E2E suites (cluster/persistence/transport) | 12+ |
| Lint errors | 0 |
| Lint warnings | 178 (all type-safety class, not auto-fixable) |
| Known flakes | 0 |
| Stale worktrees / branches | 0 |
| Critical/high audit findings open | 0 |

## What shipped

Twenty primitives across six layers. Public surface from `'distributed-core'`:

**Foundation:** `EntityRegistry` (InMemory, WAL, CRDT variants), `EntityRegistrySyncAdapter`, `EntityRegistryBootstrapper`, `PubSubManager`, `SignedPubSubManager`, `KeyManager`, `ClusterManager`, `MembershipTable`, `GossipStrategy`, `FailureDetector`, `PubSubHeartbeatSource`.

**Coordination:** `ResourceRouter`, `ResourceRouterFactory`, `ResourceRouterSyncAdapter`, `AutoReclaimPolicy`, `RebalancePolicy`, `DistributedLock`, `LeaderElection`, `ClusterLeaderElection`, `QuorumDistributedLock`, `DistributedSession`, `ConnectionRegistry`, `ServiceRegistry`, `ConfigManager`, `FailureDetectorBridge`.

**State / persistence:** `WALWriterImpl`, `WALReaderImpl`, `WALFileImpl`, `WALCoordinatorImpl`, `WriteAheadLogEntityRegistry` (with `compact()`), `InMemorySnapshotVersionStore`, `WALSnapshotVersionStore`, `RealCompactionExecutor` + four strategy classes, `CheckpointWriter`, `atomicWriteFile`, `fsyncFile`.

**Messaging:** `EventBus<T>` (typed, WAL-backed, durable subs, auto-compact), `BackpressureController`, `RateLimiter`.

**RPC / forwarding:** `ForwardingRouter`, `ForwardingServer` (with `/metrics` mount), `HttpForwardingTransport`, `HttpsForwardingTransport`, `HttpsForwardingServer`.

**Observability:** `MetricsRegistry` (with `child()` and `namespace`), `formatPrometheus`, `PrometheusHttpExporter`, `MetricsTracker`, `MetricsExporter`.

**Application layer:** `ApplicationModule`, `ApplicationRegistry`, `PipelineModule` + `PipelineExecutor` (vendor-neutral; six bridge surfaces: `getRun`, `getHistory`, `listActiveRuns`, `getMetrics().runsAwaitingApproval`, `getPendingApprovals()`, `pipeline.run.reassigned` event), `LLMClient` interface + `FixtureLLMClient`.

**Common:** `LifecycleAware` interface, `CoreError` hierarchy (12 subclasses), `Cluster.create()` facade.

## Honest verdict per layer

### Foundation — ✅ Solid

Sync adapter pattern is the right abstraction. Every primitive that needs cross-node visibility composes naturally with `EntityRegistrySyncAdapter`. CRDT variant has TTL-based tombstone eviction. Bootstrapper handles late-joining nodes via PubSub request/response.

Caveat: `ClusterManager` and `GossipStrategy` are pre-session legacy — recently retrofitted with `LifecycleAware` but their internal idioms differ from the newer primitives. Works fine; would benefit from a future consistency pass.

### Coordination — ⚠️ Solid for happy path; partition-tolerant only at the documented level

`ResourceRouter` ownership semantics are clean. `DistributedLock` per-node is correct. `ClusterLeaderElection` uses `ResourceRouter` for cluster-wide leader visibility — works.

**Sharp edge — explicitly documented non-goal:** `QuorumDistributedLock` is majority-ACK with timeout, **not** Raft/Paxos. Both sides of a network partition can independently believe they hold the lock if each side has a majority of its known-membership view. Caller-side fencing tokens or external consensus required for true mutual exclusion under partition.

### State / persistence — ✅ Solid; data-loss windows closed at v0.2.0

Atomicity wired at all four delete-then-rewrite sites (`atomicWriteFile`/`fsyncFile`). Compaction strategies all have real-filesystem paths exercised by e2e tests. Checkpoint pointer is now atomically swapped.

Caveat: WAL replay silently drops checksum-failed entries with a `console.warn`. After a power-loss mid-`append()`, the last partial write is unrecoverable — that's intentional but should be documented more loudly for operators.

### Messaging — ✅ Solid

`EventBus<T>` durability is honest now (sync before publish). Compaction is mutex-guarded against concurrent publishes. Auto-compact schedule is configurable. Durable subscriptions resume from checkpoint correctly.

`RateLimiter` has bounded bucket eviction (was previously a leak). `BackpressureController` drain semantics are correct.

### RPC / forwarding — ✅ Solid; production needs caller-side TLS terminator OR `HttpsForwardingTransport`

HTTPS variant ships. Wire protocol is a minimal subset (`POST {pathPrefix}/{resourceId}`); no built-in retry/circuit-breaking — caller wraps. `/metrics` co-mounted on the same port. ForwardingServer correctly returns 421 on ownership change.

Caveat: HTTPS transport tests use mocked `https.createServer`. Real TLS handshake path is not exercised in CI. Operators should validate against their actual cert infrastructure.

### Observability — ✅ Solid

`MetricsRegistry` is bounded (Histogram ring buffer). Namespace + `child()` enables per-tenant isolation. `formatPrometheus` produces valid exposition-format output. `PrometheusHttpExporter` is `LifecycleAware` and lifecycle-clean.

Every primitive accepts `metrics?: MetricsRegistry` — emissions are `?.`-guarded so metrics is truly optional with zero overhead when absent.

### Application layer — ✅ Solid for pipelines; vendor-neutral

`PipelineModule` + `PipelineExecutor` is a faithful port of MockExecutor with cluster-aware ownership, WAL-backed events, AbortSignal-cancellable LLM streaming, and template interpolation (`{{context.X}}`).

LLMClient is an interface — no Anthropic/Bedrock SDK coupling in this kernel. Consumers vendor concrete implementations.

Six bridge surfaces are stable. PipelineEventMap dual-emits dot-form (deprecated) and colon-form (canonical) — removal scheduled for a future major.

### Common — ✅ Solid

`LifecycleAware` interface adopted across 18+ primitives with idempotent `start()`/`stop()`/`isStarted()`. `CoreError` hierarchy gives consumers programmatic error handling via stable `code` strings.

## Open work, prioritized

### Should be done before broad adoption
None. Library is consumable as-is for early adopters who tolerate documented sharp edges.

### Should be done before production claims
1. **Type-safety codemod completion** — ~150 untyped catches, ~25 unsafe `Map.get()!`, ~150 unmigrated `throw new Error()`. Mechanical. ~1 day of focused work.
2. **Test-isolation medium findings** — 47 real-time `setTimeout` in unit tests that should be fake timers. Reduces wall-clock test time and removes a class of slow-test flake risk.
3. **Pull-based heartbeat / partition tolerance audit** — confirm `FailureDetector` + `PubSubHeartbeatSource` behavior under simulated network partition. Currently tested at the unit level; e2e partition scenarios are thin.

### Should be done before 1.0
1. **Dual-emit removal** — once consumers migrate off dot-form events (`member-*`, `pipeline.*`), remove the deprecated emissions. Schedule into CHANGELOG once consumer telemetry confirms zero dot-form subscribers remain.
2. **API friction observations** — five items from the `examples/live-video/` consumer captured in `docs/API-FRICTION.md`. Wait for second-consumer (websocket-gateway Phase-4) signal to confirm the friction is general before designing fixes.
3. **Older modules → CoreError migration** — pre-session code (`transport/`, `gossip/`, etc.) still uses `throw new Error()`. Lower priority than the new primitives.
4. **Real consensus for `QuorumDistributedLock` partition tolerance** — explicit non-goal at v0.2.0; would be its own multi-week project.

### Nice to have (not blocking anything)
- `node.applications.register(module)` auto-wiring for `ApplicationModuleContext` (the 6-field boilerplate the live-video and pipelines examples both surface as friction).
- Sub-path exports beyond the current four (`./applications/pipeline`, `./gateway`, `./routing`).
- Performance baselines under multi-node cluster load (current benchmarks are single-process).

## Recommendation

**Tag v0.2.0 is a real release.** Downstream consumers can install via `file:` link (working today) or after `npm publish` (one command from a maintainer with credentials).

The only legitimate next move from a maintenance perspective: **wait for the websocket-gateway Phase-4 wire-up bug report.** That's the first real-consumer signal. Speculative work without that signal risks designing for hypothetical needs.

For productization beyond Phase-4: complete the type-safety codemod, harden the partition-tolerance test matrix, and validate the HTTPS transport against real cert infrastructure.

— end of audit
