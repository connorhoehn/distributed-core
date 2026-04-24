# Cluster-Readiness Plan

> **Status: ✅ Complete.** All 13 workstreams shipped across phases 1, 2a, 2b, and 3. Post-plan additions (`ConfigManager`, `ServiceRegistry`, README, ARCHITECTURE, `examples/cluster-collab/`) also landed. Suite: **107 unit suites, 1779 tests + 12 integration suites, 77 tests**. See `CHANGELOG.md` for deferred follow-ups.


## Context

Over recent sessions we built twelve primitives — `ResourceRouter`, `DistributedLock`, `ClusterLeaderElection`, `DistributedSession`, `ConnectionRegistry`, `EventBus`, `MetricsRegistry`, `BackpressureController`, `RateLimiter`, `WALSnapshotVersionStore`, `SharedStateManager`, plus CRDT/WAL entity registries. Unit tests pass (1615 tests, 94 suites). A recent audit identified 13 gaps separating the current code from a production-usable cluster-coordination kernel.

The **single most important gap** is that primitives depending on `EntityRegistry` have no cross-node visibility. Locks held on one node are invisible to another. The fix is one small primitive (`EntityRegistrySyncAdapter`) that propagates registry updates over PubSub. All other work either builds on this or is additive.

## Goals

1. Every cluster-wide primitive works correctly when each node has its own `EntityRegistry` and communicates via gossip/PubSub.
2. Every primitive emits metrics through `MetricsRegistry`.
3. Failure detection automatically triggers cleanup (lock release, session eviction, connection removal).
4. Integration tests verify multi-node behavior under gossip delay and partition.
5. API consistency across lifecycle, events, and config.
6. Optional message signing for PubSub traffic.

## Non-goals (explicit)

- **No Raft/Paxos consensus.** Quorum-based locks use "majority ACK with timeout," not a full log-replication protocol.
- **No RBAC or policy engine.** Message signing is the only auth feature; resource namespacing / permissions are out of scope.
- **No pluggable transport for the sync adapter.** PubSub is the transport; users who want a different backplane can plug a different `PubSubManager`.
- **No new CRDT implementations.** Existing `CrdtEntityRegistry` is the one we keep.

## Central Design Decision

Instead of giving every primitive its own sync adapter, we introduce one generic adapter that any `EntityRegistry` can opt into:

```typescript
export class EntityRegistrySyncAdapter {
  constructor(
    registry: EntityRegistry,
    pubsub: PubSubManager,
    localNodeId: string,
    config: { topic: string }
  );
  start(): void;
  stop(): void;
}
```

All existing primitives (`ResourceRouter`, `DistributedLock`, `ClusterLeaderElection`, `ConnectionRegistry`) already accept any `EntityRegistry` through their constructors. With one sync adapter wired on the shared registry, **every one of them becomes cluster-aware without changing its signature**.

```typescript
// Single sync adapter, many consumers
const registry = EntityRegistryFactory.createMemory(nodeId);
await registry.start();

const sync = new EntityRegistrySyncAdapter(registry, pubsub, nodeId, { topic: 'entities' });
sync.start();

const lock = new DistributedLock(registry, nodeId);
const connReg = new ConnectionRegistry(registry, nodeId);
const election = new ClusterLeaderElection('leader-x', nodeId, lock, router);
```

The existing `ResourceRouterSyncAdapter` is kept but becomes redundant for new users; docs direct people to the generic one.

---

## Phase 1 — Foundation (blocks everything else)

### 1A. `EntityRegistrySyncAdapter`

**Scope:** `src/cluster/entity/EntityRegistrySyncAdapter.ts` + tests.

**Behavior:**
- On `start()`: subscribe to `config.topic` on pubsub; register handlers for `entity:created`, `entity:updated`, `entity:deleted`, `entity:transferred` events on the registry.
- Local event → build an `EntityUpdate` with the correct `operation` (`'CREATE' | 'UPDATE' | 'DELETE' | 'TRANSFER'`) → publish to pubsub.
- Incoming pubsub message:
  - If `meta.publisherNodeId === localNodeId` → ignore (loop prevention).
  - Else → call `registry.applyRemoteUpdate(payload as EntityUpdate)`.
- On `stop()`: unsubscribe from pubsub; remove registry listeners.

**Acceptance:**
- Unit tests: local event publishes correct update; remote message applies; self-message ignored; clean stop/restart.
- Integration test: two in-process nodes, both with their own registry + shared pubsub (in-memory). Claim on node A → visible on node B after one event loop tick.

**Dependencies:** none.

---

## Phase 2 — Cluster features (parallel; all depend on 1A except where noted)

### 2A. Metrics emission across primitives  *(independent of 1A)*

**Scope:** no new files. Threads a `MetricsRegistry` through existing primitives.

**Approach:** each primitive accepts an optional `metrics?: MetricsRegistry` in its config. Emissions:

| Primitive | Metrics |
|---|---|
| `ResourceRouter` | `resource.claim.count{node}`, `resource.claim.latency_ms` (histogram), `resource.release.count`, `resource.orphaned.count` |
| `DistributedLock` | `lock.acquire.count{result=success|fail|timeout}`, `lock.acquire.latency_ms`, `lock.hold.gauge` |
| `DistributedSession` | `session.active.gauge`, `session.evicted.count`, `session.orphaned.count`, `session.apply.latency_ms` |
| `ConnectionRegistry` | `connection.registered.count`, `connection.expired.count`, `connection.active.gauge` |
| `EventBus` | `event.published.count{type}`, `event.received.count{type}`, `event.deadletter.count` |
| `BackpressureController` | `bp.enqueued.count`, `bp.dropped.count`, `bp.flushed.count`, `bp.queue_depth.gauge{key}` |

**Acceptance:** each primitive's tests assert metrics are incremented for the appropriate lifecycle events. No breaking API changes (metrics is optional).

### 2B. WAL compaction for `WriteAheadLogEntityRegistry`  *(independent of 1A)*

**Scope:** extend `WriteAheadLogEntityRegistry` with `compact()`.

**Behavior:** read current WAL, reconstruct in-memory map of latest record per `entityId`, exclude entities whose latest operation is `DELETE`. Rewrite the WAL with a single `CREATE` entry per surviving entity (same atomic-rename pattern as `WALSnapshotVersionStore.compact()`).

**Acceptance:** store → delete → compact shrinks the file and does not resurrect deleted entities. Bounded file size proven by test (apply 100 updates to 10 entities, compact, verify entry count ≤ 10).

**Open question:** should compaction be driven by an external coordinator (like `ClusterCompactionBridge`) or be self-triggered by a configurable threshold? Recommend external to keep the registry simple.

### 2C. `AutoReclaimPolicy`

**Scope:** `src/routing/AutoReclaimPolicy.ts` + tests.

**Behavior:** observer pattern on `ResourceRouter`. Listens for `resource:orphaned` events; decides whether this node should reclaim based on `PlacementStrategy`. If `strategy.selectNode(resourceId, localNodeId, aliveCandidates) === localNodeId`, attempts `router.claim(resourceId)` with configurable delay (jitter to avoid thundering-herd race with other nodes competing for the orphan).

```typescript
export class AutoReclaimPolicy {
  constructor(router: ResourceRouter, options?: { strategy?: PlacementStrategy; jitterMs?: number });
  start(): void;
  stop(): void;
}
```

**Acceptance:** 3-node integration test — node C owns `r1`; node C leaves; surviving nodes race via jittered delay; exactly one reclaims.

### 2D. `FailureDetectorBridge`

**Scope:** `src/cluster/failure/FailureDetectorBridge.ts` + tests.

**Behavior:** subscribes to `FailureDetector` events. When a node flips to `DEAD`:

1. For each local `ResourceRouter` / `EntityRegistry` pair: emit `resource:orphaned` for every resource owned by the dead node.
2. For each `DistributedLock` held remotely by the dead node: synthesize a release on the local view.
3. For each `ConnectionRegistry` entry owned by the dead node: emit `connection:expired`.
4. For each `DistributedSession` owned by the dead node: emit `session:orphaned`.

**Design note:** `FailureDetectorBridge` is constructed with references to the primitives that should be cleaned up. It doesn't own them; it just translates failure events into cleanup actions.

```typescript
export interface FailureDetectorBridgeTargets {
  router?: ResourceRouter;
  connectionRegistry?: ConnectionRegistry;
  // extend as needed
}

export class FailureDetectorBridge {
  constructor(detector: FailureDetector, targets: FailureDetectorBridgeTargets);
  start(): void;
  stop(): void;
}
```

**Acceptance:** simulated failure detector fires `node-dead` → each target receives the correct cleanup event.

### 2E. `QuorumDistributedLock`

**Scope:** `src/cluster/locks/QuorumDistributedLock.ts` + tests.

**Design:** majority-ACK, not consensus. `acquire(lockId)`:

1. Publish `LOCK_REQUEST{lockId, nodeId, requestId, ttlMs}` to pubsub.
2. Collect `LOCK_GRANT{requestId, fromNodeId}` responses until timeout or majority-of-alive-peers.
3. If majority ACKed and none of them currently hold a lock with the same id → acquired.
4. Remote nodes record the grant; on receiving a conflicting request they decline (respond `LOCK_DENY`) rather than silently ignoring, to make contention diagnosable.

Timeout strategy: if fewer than majority ACK within `acquireTimeoutMs`, release granted locks (broadcast `LOCK_ABANDON`) and fail.

**Non-goal:** this is NOT full distributed consensus. It is susceptible to split-brain during partitions where each side has a majority of a shrinking known-membership set. Partition tolerance requires `AdaptiveQuorumStrategy` integration (explicit follow-up).

**Acceptance:** 3-node integration test — two nodes race for same lock, exactly one wins; third node (minority) cannot acquire.

### 2F. Refactor `SharedStateManager` onto `DistributedSession`  *(breaking change)*

**Scope:** rewrite `src/gateway/state/SharedStateManager.ts`. Delete duplicate ownership/eviction logic and delegate to `DistributedSession`. Existing tests migrate.

**Motivation:** `SharedStateManager` today has its own ad-hoc ownership, session map, eviction timers, and pubsub wiring — all of which `DistributedSession` now provides. Having both causes drift and doubles the surface area.

**New shape:**

```typescript
export class SharedStateManager<S, U> {
  constructor(
    session: DistributedSession<S, U>,
    pubsub: PubSubManager,
    adapter: SharedStateAdapter<S, U>,
    options?: {
      topicPrefix?: string;        // default 'shared-state'
      snapshotStore?: ISnapshotVersionStore<S>;
      snapshotDebounceMs?: number; // debounce persist after apply
    }
  );
  async start(): Promise<void>;
  async stop(): Promise<void>;

  async subscribe(clientId: string, channelId: string): Promise<S>;
  async applyUpdate(channelId: string, update: U): Promise<void>;
  async getSnapshot(channelId: string): Promise<S | null>;
  async unsubscribe(clientId: string, channelId: string): Promise<void>;
  async onClientDisconnect(clientId: string): Promise<void>;
  getStats(): SharedStateManagerStats;
}
```

**Behavior:**
- `subscribe` → `session.join(channelId)`; if local, hydrate state from `snapshotStore` before returning; subscribe to `${topicPrefix}:${channelId}` on pubsub for remote updates.
- `applyUpdate` → `session.apply(channelId, update)`; publish update to pubsub; schedule debounced snapshot.
- Incoming pubsub → apply to session via adapter (loop-protected).
- Orphan → migrate channel to a different node (use `AutoReclaimPolicy`).
- Eviction → persist final snapshot before `session.leave`.

**Migration notes:**
- `SharedStateManager` constructor is NEW — first arg is now a `DistributedSession`, not a `ChannelManager`/`PubSubManager` stack.
- Tests at `test/unit/gateway/state/SharedStateManager.test.ts` will be rewritten to use a `DistributedSession` + `MockPubSubManager`.
- Downstream callers (not many — mostly the chat example) need one-line constructor update.

**Acceptance:**
- Existing functional coverage preserved (subscribe/apply/unsubscribe/evict).
- 2-node integration test: Y.js adapter, concurrent edits, eventual consistency.
- Deleted ≥ ~150 lines from the old `SharedStateManager` (de-duplication is measurable).

### 2G. `EventBus` — durable subscriptions + compaction  *(independent of 1A)*

**Scope:** extend existing `EventBus`.

**Durable subscribe:**

```typescript
subscribeDurable<K>(
  type: K,
  checkpointKey: string,
  handler: (event: BusEvent<EventMap[K]>) => Promise<void>
): string
```

Uses a `SnapshotVersionStore` to persist the last-processed version for `checkpointKey`. On reconnect/restart, replays from the stored checkpoint.

**Compaction:** `compact(keepLastNPerType?: number)` rewrites the WAL keeping only the most recent N events per `type`. Same atomic pattern as snapshot compaction.

**Acceptance:** publish 10 events; start durable sub from checkpoint 5; sub receives events 6-10. Compaction test: 100 events, compact to 10, replay still works.

### 2H. `ForwardingRouter` + default HTTP transport

**Scope:**
- `src/routing/ForwardingRouter.ts`
- `src/routing/HttpForwardingTransport.ts`
- `src/routing/ForwardingServer.ts` (minimal HTTP listener that dispatches incoming forwarded calls to locally-owned resources)
- tests

**Design:**

```typescript
export interface ForwardingTransport {
  call(target: RouteTarget, path: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
}

export class ForwardingRouter {
  constructor(router: ResourceRouter, transport: ForwardingTransport, options?: { timeoutMs?: number; retries?: number });
  async call(resourceId: string, path: string, payload: unknown): Promise<unknown>;
  // Local case: throws `LocalResourceError` (caller handles dispatch locally)
  // Remote case: wraps transport.call with timeout + single retry on 5xx
}

export class HttpForwardingTransport implements ForwardingTransport {
  constructor(options?: { fetch?: typeof fetch; headers?: Record<string,string> });
  async call(target: RouteTarget, path: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  // POST http://{target.address}:{target.port}{path} with JSON body
  // AbortController for timeout
}

export class ForwardingServer {
  constructor(router: ResourceRouter, port: number, handler: (resourceId: string, path: string, payload: unknown) => Promise<unknown>);
  async start(): Promise<void>;
  async stop(): Promise<void>;
  // Accepts POST requests at /forward/{resourceId}{path}
  // Verifies router.isLocal(resourceId); returns 421 MISDIRECTED if not
  // Calls handler, returns JSON response
}
```

**HTTP wire protocol (minimal):**
- Method: POST
- URL: `/forward/{resourceId}{path}`
- Body: JSON payload
- Response: JSON payload, or 421 + redirect body `{ owner: { address, port } }` if the target no longer owns the resource.

**Transport is swappable** — the interface is the contract; users who want gRPC/WS/Unix-sockets write their own.

**Acceptance:**
- Unit tests with mock transport.
- Integration test: two-node setup, node A calls `forwardingRouter.call('resource-on-b', ...)`, request hits `ForwardingServer` on B, correct response returns.
- Timeout test: slow server → call rejects with `TimeoutError` after `timeoutMs`.
- Ownership-change test: request arrives at B after B released the resource → 421 response; `ForwardingRouter` re-routes and retries.

---

## Phase 3 — Cross-cutting (after Phase 2)

### 3A. Integration tests

**Scope:** `test/integration/cluster-readiness/` — new directory.

**Test harness:**

```typescript
class ClusterSimulator {
  constructor(nodeCount: number);
  node(i: number): {
    pubsub: InMemoryPubSub;
    registry: EntityRegistry;
    sync: EntityRegistrySyncAdapter;
    // ... all the primitives each node needs
  };
  async startAll(): Promise<void>;
  async partition(groupA: number[], groupB: number[]): Promise<void>;
  async heal(): Promise<void>;
  async kill(i: number): Promise<void>;
  async gossipDelay(ms: number): Promise<void>;
}
```

Test scenarios:
1. Three nodes, one claims → all three see it.
2. Leader election with five nodes; kill the leader; new leader elected within `leaseDurationMs + renewIntervalMs`.
3. Partition a 5-node cluster into 3+2; each side thinks it's the cluster; heal; reconcile.
4. Quorum lock contention under load: 10 nodes, 100 concurrent acquires of the same lock; exactly one succeeds.
5. Cluster session sync: Y.js adapter; 3 nodes applying concurrent edits; eventual consistency.

**Acceptance:** all scenarios pass reliably (100 runs without flake).

### 3B. API consistency pass  *(breaking changes allowed)*

**Scope:** no new primitives; introduce one interface + refactor.

```typescript
export interface LifecycleAware {
  start(): Promise<void>;
  stop(): Promise<void>;
  isStarted(): boolean;
}
```

All primitives that need lifecycle implement this. Ones that don't (`RateLimiter`, `MetricsRegistry`) stay as-is.

**Standardize:**
- Event names: always `noun:verb` with colon (e.g. `resource:claimed`). Rename any offenders.
- Config defaulting: always `{ ...DEFAULTS, ...config }` pattern; no inline `??` on deeply-nested fields.
- Constructor parameter order: `(localNodeId, ...dependencies, config?)`. Rearrange where violated.
- `EventEmitter` inheritance: if a class emits events, it extends `EventEmitter`. No "conditional" event systems.
- Error types: define `CoreError` base class in `src/common/errors.ts`; all thrown errors inherit from it with stable `name` fields for programmatic handling.

**Breaking changes are expected.** Version bump to 0.x→0.(x+1) or similar — record every breaking change in a `CHANGELOG.md` section.

**Acceptance:** every lifecycle-bearing primitive implements `LifecycleAware`. CHANGELOG lists breaking changes. Full test suite passes after migrations.

### 3C. Message signing

**Scope:** `src/gateway/pubsub/SignedPubSubManager.ts` + tests.

**Design:** wraps `PubSubManager`, using `KeyManager` to sign outgoing messages and verify incoming. Drops unverified messages with an emitted `'message:rejected'` event. Opt-in — primitives don't change.

```typescript
export class SignedPubSubManager {
  constructor(inner: PubSubManager, keyManager: KeyManager, options?: { strictMode?: boolean });
  // Implements PubSubManager interface, delegating to inner with sign/verify wrapping
}
```

**Acceptance:** signed message verifies; tampered payload rejected; missing signature rejected when `strictMode: true`.

---

## Execution Plan

| Phase | Agents | Parallel | Notes |
|---|---|---|---|
| **1** (foundation) | 1 agent: 1A | n/a | `EntityRegistrySyncAdapter` — blocks Phase 2 |
| **2a** (independent) | 4 agents: 2A, 2B, 2G, 2H | all parallel | metrics, WAL-registry compaction, event bus durable+compact, forwarding (with HTTP transport) |
| **2b** (depends on 1A) | 4 agents: 2C, 2D, 2E, 2F | all parallel | auto-reclaim, failure bridge, quorum lock, SharedStateManager refactor |
| **3** (cross-cutting) | 3 agents: 3A, 3B, 3C | parallel | integration tests, API pass, signing |

Phase 2a can actually run **concurrently with Phase 1** since its items don't depend on the sync adapter. That collapses the critical path.

Total: ~12 agents. Running 2a + 1A together, then 2b, then 3 gives roughly three checkpoints.

## Decisions (confirmed)

1. **Quorum lock (2E):** majority-ACK only. No Raft.
2. **Cluster session (2F):** `SharedStateManager` is **refactored** to build on `DistributedSession` — not composed side-by-side. This is the bigger change; existing `SharedStateManager` callers may need migration.
3. **ForwardingRouter (2H):** includes a default HTTP transport in this repo (`HttpForwardingTransport` based on `undici` or Node's native `fetch`). The Transport interface stays so users can swap in gRPC/WS.
4. **Metrics naming (2A):** Prometheus-style `dot.separated.names{label=val}`.
5. **API consistency (3B):** breaking changes allowed during the pass. Major-version bump semantics.

## Risks

- **Integration test flakiness.** PubSub-backed sync has inherent async gaps. Tests will need careful event-loop pumping (`await setImmediate`) or explicit wait helpers. Mitigation: use `jest.useFakeTimers` + explicit `advanceTimersByTime`.
- **Quorum lock correctness.** Majority-ACK has corner cases (concurrent requests, partial acks). Mitigation: model-based testing + targeted partition tests.
- **Metrics overhead.** Metrics in hot paths (e.g., every `publish`) can be expensive. Mitigation: make `metrics?` optional; no-op when absent; histograms already bounded to 1000 observations.
- **Behavioral drift on refactor.** Phase 3B touching every primitive risks regressions. Mitigation: purely additive (implement interface, don't change behavior); test suite must pass without modification.

## Exit criteria

- All 13 gaps from the cluster-readiness audit addressed.
- Full test suite passes (unit + new integration tests).
- 94+ test suites, 1700+ passing tests.
- Every cluster-aware primitive has at least one multi-node integration test.
- One end-to-end example (`examples/cluster-collab/`) demonstrating the composition of `EntityRegistrySyncAdapter` + `ClusterDistributedSession` + `EventBus` + `ClusterLeaderElection` with real PubSub and WAL persistence.
