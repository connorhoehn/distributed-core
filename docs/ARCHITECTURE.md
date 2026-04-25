# Architecture

## Core idea

Ownership of named resources is the center of gravity. Every useful distributed primitive in this library reduces to "who owns this right now, and how do other nodes find out?" `EntityRegistry` is the local answer; `EntityRegistrySyncAdapter` is the cross-node layer. Everything else — locks, sessions, connections, leader election — is a specialization built on those two.

A single `EntityRegistry` + `EntityRegistrySyncAdapter` pair makes all primitives cluster-aware at once. None of the primitives above the foundation layer do their own cross-node sync; they rely entirely on registry events.

## The layering

```
┌─────────────────────────────────────────────────────────┐
│ Applications (examples/, user code)                      │
├─────────────────────────────────────────────────────────┤
│ Composition layer                                        │
│   SharedStateManager, ClusterLeaderElection,            │
│   AutoReclaimPolicy, FailureDetectorBridge,             │
│   ForwardingRouter, ForwardingServer, EventBus          │
├─────────────────────────────────────────────────────────┤
│ Primitive layer                                          │
│   ResourceRouter, DistributedSession,                   │
│   DistributedLock, QuorumDistributedLock,               │
│   ConnectionRegistry, LeaderElection                    │
├─────────────────────────────────────────────────────────┤
│ Foundation                                               │
│   EntityRegistry (InMemory | WAL | CRDT),               │
│   EntityRegistrySyncAdapter, PubSubManager,             │
│   ClusterManager, FailureDetector                       │
└─────────────────────────────────────────────────────────┘
```

Source locations:
- Foundation: `src/cluster/entity/`, `src/gateway/pubsub/`, `src/cluster/ClusterManager.ts`, `src/monitoring/FailureDetector.ts`
- Primitive layer: `src/routing/ResourceRouter.ts`, `src/cluster/locks/`, `src/cluster/sessions/`, `src/connections/ConnectionRegistry.ts`
- Composition layer: `src/gateway/state/SharedStateManager.ts`, `src/cluster/locks/ClusterLeaderElection.ts`, `src/routing/AutoReclaimPolicy.ts`, `src/cluster/failure/FailureDetectorBridge.ts`, `src/routing/ForwardingRouter.ts`, `src/messaging/EventBus.ts`

## Key design principles

**1. Pluggable storage.** Every `EntityRegistry`-based primitive works with any registry implementation. `InMemoryEntityRegistry` is zero-overhead for unit tests. `WriteAheadLogEntityRegistry` adds disk durability. `CrdtEntityRegistry` uses a CRDT for multi-master scenarios. Switch by passing a different registry to the constructor — no other code changes.

**2. Opt-in cross-node sync.** Attaching one `EntityRegistrySyncAdapter` to a registry makes every primitive built on that registry cluster-aware. Without the adapter, you get local-only semantics, which is exactly what you want in unit tests. The adapter subscribes to `entity:created`, `entity:updated`, `entity:deleted`, and `entity:transferred` events and forwards them over PubSub. Incoming messages call `registry.applyRemoteUpdate()`; self-messages are dropped by comparing `publisherNodeId` to `localNodeId`.

**3. Transport independence.** PubSub is the cross-node backplane; PubSubManager implementations are swappable. `SignedPubSubManager` wraps any PubSub with HMAC signing and verification. `ForwardingRouter` and `ForwardingServer` use a `ForwardingTransport` interface — the default is `HttpForwardingTransport` (POST over HTTP), but gRPC, WebSocket, or Unix socket implementations can be dropped in.

**4. LifecycleAware contract.** Every stateful primitive implements `LifecycleAware`: `start(): Promise<void>`, `stop(): Promise<void>`, `isStarted(): boolean`. Both `start()` and `stop()` are idempotent. Construction is side-effect-free.

**5. Metrics are optional.** Every primitive that emits metrics accepts `metrics?: MetricsRegistry` in its config. When absent, the metrics path is a null-check and adds no overhead. Metrics use Prometheus-style dot-separated names with label maps: `resource.claim.count{result="success"}`, `lock.hold.gauge`, etc.

## Composition examples

### Minimal: local registry + cluster sync + router

```typescript
import { EntityRegistryFactory, EntityRegistrySyncAdapter, ResourceRouter } from 'distributed-core';

const registry = EntityRegistryFactory.createMemory('node-A');
await registry.start();

const sync = new EntityRegistrySyncAdapter(registry, pubsub, 'node-A', {
  topic: 'entities',
});
await sync.start();

const router = new ResourceRouter('node-A', registry, clusterManager);
await router.start();

const handle = await router.claim('resource-1');
// All nodes with a sync adapter on the same topic will see resource-1 → node-A
```

### Add a lock and cluster leader election

```typescript
import { DistributedLock, ClusterLeaderElection } from 'distributed-core';

// DistributedLock uses the same registry — cluster-aware via the sync adapter above
const lock = new DistributedLock(registry, 'node-A', { defaultTtlMs: 15_000 });

const election = new ClusterLeaderElection('worker-group', 'node-A', lock, router);
await election.start();

election.on('elected', () => { /* this node is now leader */ });
election.on('deposed', () => { /* leadership lost or renounced */ });

// Any node can query the current leader's routing info
const leaderRoute = await election.getLeaderRoute();
```

### Add failure cleanup and auto-reclaim

```typescript
import {
  FailureDetectorBridge,
  AutoReclaimPolicy,
  ConnectionRegistry,
} from 'distributed-core';

const connRegistry = new ConnectionRegistry(registry, 'node-A');
await connRegistry.start();

// When failure detector fires 'node-failed', bridge triggers cleanup
const bridge = new FailureDetectorBridge(failureDetector, {
  router,
  connectionRegistry: connRegistry,
});
await bridge.start();

// Orphaned resources are re-claimed by a surviving node after jitter
const reclaim = new AutoReclaimPolicy(router);
reclaim.start();
```

For a full working multi-node example see `examples/cluster-collab/`.

## Lifecycle rules

- Construction is side-effect-free. Primitives bind event listeners and allocate state only in `start()`.
- `start()` is idempotent: calling it twice is safe and has no effect after the first call.
- `stop()` reverses all of `start()`: removes listeners, cancels timers, stops owned sub-primitives.
- When a primitive wraps another (e.g., `ClusterLeaderElection` wraps `LeaderElection`; `DistributedSession` wraps `ResourceRouter` when `ownsRouter: true`), the outer wrapper's `start()`/`stop()` transitively manages the inner.
- `DistributedSession` has an `ownsRouter` config flag (default `true`). Set it to `false` when the router is shared with other primitives so lifecycle is managed externally.
- `ConnectionRegistry` and `ResourceRouter` both call `registry.start()`/`registry.stop()` internally — do not start the registry separately if you are using these wrappers.

## Partition behavior (honest assessment)

**`EntityRegistrySyncAdapter`**: Best-effort delivery. During a partition each side accumulates updates locally. After reconnection, `applyRemoteUpdate()` handles incoming updates with last-write-wins semantics. Consistency is eventual; there is no reconciliation protocol beyond replaying missed events.

**`DistributedLock`**: Local-only (backed by `EntityRegistry`). With `EntityRegistrySyncAdapter` wired, lock visibility is as strong as the PubSub delivery guarantee. Without it, two nodes can hold the same lock simultaneously.

**`QuorumDistributedLock`**: Majority-ACK, not consensus. A lock is granted when `floor(N/2)+1` nodes respond with `LOCK_GRANT`. During a network partition where each side has a stable membership view with a local majority, both sides can independently grant the same lock. This is a documented non-goal for the current version — callers that need stronger guarantees should layer fencing tokens. See `CLUSTER-READINESS-PLAN.md` for the explicit non-goal statement.

**`ClusterLeaderElection`**: Wraps `DistributedLock` with a renewable lease and publishes leadership via `ResourceRouter`. During a partition, both sides can elect a leader. The same fencing-token caveat applies. `getLeaderRoute()` returns the address of the leader visible on this node's side of the partition.

**`SharedStateManager` / `DistributedSession`**: State sync is pubsub-delivered. Follower nodes apply updates as they arrive; the authoritative (owning) node holds the canonical state. Partition causes followers to stale; healing resumes the update stream from the next update forward. There is no re-sync of missed updates currently.

## Fencing tokens (lock & leader-election contract)

Every `LockHandle` returned by `DistributedLock.acquire()`, `DistributedLock.extend()`, and `QuorumDistributedLock.tryAcquire()` carries a `fencingToken: bigint`. The contract is: **`fencingToken` is monotonically increasing for the life of a given `lockId`. Implementations may reset the counter only on explicit registry truncation.** Concretely, `DistributedLock` persists the per-lockId counter into the underlying `EntityRegistry` via a sidecar entity (`__fence__:<lockId>`) so monotonicity survives lock release/re-acquire, TTL expiry, and process restarts that share the registry; `QuorumDistributedLock` derives its token by taking `max + 1n` over all `seenToken` values reported by the majority of grants, so cross-node monotonicity holds within a stable cluster (a full process restart of every node simultaneously is the documented reset boundary). `ClusterLeaderElection` exposes the leader's current fencing token as `currentEpoch(): bigint` and offers an optional `guard<T>(fn: (epoch) => Promise<T>): Promise<T>` helper that re-reads the lock at the boundary and throws `StaleLeaderError` if the token changed during execution. Integrators include the token in any side-effect they want guarded; a downstream acceptance gate compares the held token to the highest seen token per resource and rejects writes whose token is lower (Kleppmann fencing-token pattern). Note that `guard()` does **not** cancel `fn` mid-flight — for long-running side-effects, embed the epoch directly in the write and rely on the gate.

## Where next

- `docs/CLUSTER-READINESS-PLAN.md` — the original design audit and build plan, including deferred work (WAL compaction for entity registries, full integration test harness, API consistency pass, adaptive quorum).
- `CHANGELOG.md` — recent changes, including the `LifecycleAware` interface and `CoreError` hierarchy added in the most recent pass.
