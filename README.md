# distributed-core

![CI](https://github.com/connorhoehn/distributed-core/actions/workflows/ci.yml/badge.svg)

A TypeScript kernel for cluster-coordinated applications — locks, leader election, session ownership, cross-node state sync, and more, all composable over any PubSub transport.

## What is this?

distributed-core is a modular library of distributed systems primitives for Node.js applications that need to coordinate across multiple processes or machines. It provides the building blocks — resource ownership, distributed locking, session management, failure detection cleanup, and event buses — without imposing a framework or application structure.

The central abstraction is `EntityRegistry`: a local map of "who owns what." A single `EntityRegistrySyncAdapter` wires that registry over PubSub, making every primitive built on top of it automatically cluster-aware. Applications pick the primitives they need and compose them; the library makes no assumptions about your transport, storage, or business logic.

This is a research kernel and pre-production library. The primitives are tested and composable but have documented limitations under network partition (see `docs/ARCHITECTURE.md`).

## Quick start

```typescript
import {
  EntityRegistryFactory,
  EntityRegistrySyncAdapter,
  ResourceRouter,
  DistributedLock,
  ClusterLeaderElection,
} from 'distributed-core';

// 1. A shared EntityRegistry — the local ownership map
const registry = EntityRegistryFactory.createMemory('node-A');
await registry.start();

// 2. Wire it over PubSub so other nodes see changes
const sync = new EntityRegistrySyncAdapter(registry, pubsub, 'node-A', {
  topic: 'entities',
});
await sync.start();

// 3. Build higher-level primitives on top — all cluster-aware automatically
const router = new ResourceRouter('node-A', registry, clusterManager);
await router.start();

const lock = new DistributedLock(registry, 'node-A');
const election = new ClusterLeaderElection('my-group', 'node-A', lock, router);
await election.start();

election.on('elected', () => console.log('node-A is leader'));
```

See `examples/cluster-collab/` for a complete multi-node demonstration including `SharedStateManager`, `EventBus`, and failure handling.

## Primitives

| Primitive | Purpose | Depends on |
|---|---|---|
| `EntityRegistry` (interface) | Per-node ownership map; three implementations: `InMemory`, `WAL`, `CRDT` | — |
| `EntityRegistryFactory` | Create `InMemory`, `WAL`, or `CRDT` registries | — |
| `EntityRegistrySyncAdapter` | Cross-node sync of entity ownership over PubSub | `EntityRegistry` + `PubSubManager` |
| `ResourceRouter` | "Which node owns X?" + claim/release/transfer + placement strategies | `EntityRegistry` + `ClusterManager` |
| `ResourceRouterSyncAdapter` | Router-specific sync adapter (legacy; prefer `EntityRegistrySyncAdapter`) | `ResourceRouter` + `PubSubManager` |
| `AutoReclaimPolicy` | Observe orphaned resources and reclaim with jitter | `ResourceRouter` |
| `DistributedLock` | Local TTL-based mutex backed by `EntityRegistry` | `EntityRegistry` |
| `QuorumDistributedLock` | Majority-ACK cluster-wide lock over PubSub | `PubSubManager` + `ClusterManager` |
| `LeaderElection` | Single-node leader with renewable lease | `DistributedLock` |
| `ClusterLeaderElection` | Cluster-visible leader; publishes ownership via `ResourceRouter` | `DistributedLock` + `ResourceRouter` |
| `DistributedSession` | Owned session containers with idle eviction | `ResourceRouter` + `EvictionTimer` |
| `SharedStateManager` | Cross-node state sync over PubSub with optional snapshot persistence | `DistributedSession` + `PubSubManager` |
| `ConnectionRegistry` | Track which node owns each client connection, with TTL expiry | `EntityRegistry` |
| `ForwardingRouter` | Forward calls to the owning node; throws `LocalResourceError` if local | `ResourceRouter` + `ForwardingTransport` |
| `HttpForwardingTransport` | Default HTTP transport for `ForwardingRouter` (POST `/forward/{id}{path}`) | `ForwardingTransport` interface |
| `ForwardingServer` | HTTP server that receives forwarded calls, verifies ownership, dispatches handler | `ResourceRouter` |
| `FailureDetectorBridge` | On node-failed: emit orphaned resources and expire connections | `FailureDetector` |
| `EventBus` | Typed cluster-wide event bus with optional WAL durability and replay | `PubSubManager` (+optional WAL) |
| `MetricsRegistry` | Counter / Gauge / Histogram with Prometheus-style labels | — |
| `BackpressureController` | Per-key queues with configurable drop policies and optional rate limiting | (optional `RateLimiter`) |
| `RateLimiter` | Token-bucket rate limiter per key | — |
| `WALSnapshotVersionStore` | Durable snapshot store backed by Write-Ahead Log | WAL |
| `SignedPubSubManager` | PubSub wrapper that signs outgoing and verifies incoming messages | `PubSubManager` + `KeyManager` |
| `EntityRegistryBootstrapper` | Snapshot-bootstrap for joining nodes via PubSub request/response; complements `EntityRegistrySyncAdapter` | `EntityRegistry` + `PubSubManager` |
| `PubSubHeartbeatSource` | Self-contained heartbeat driver over PubSub; feeds `FailureDetector` without a manual timer loop | `PubSubManager` + `FailureDetector` |
| `HttpsForwardingTransport` | TLS variant of `HttpForwardingTransport`; shared `HttpsAgent` for connection pooling and mTLS | `ForwardingTransport` interface |
| `HttpsForwardingServer` | TLS variant of `ForwardingServer`; identical wire protocol over HTTPS | `ResourceRouter` |
| `LifecycleAware` | Standard `start()` / `stop()` / `isStarted()` contract implemented by all stateful primitives | — |

### Placement strategies

`ResourceRouter` accepts any `PlacementStrategy`. Built-in strategies:

| Strategy | Behaviour |
|---|---|
| `LocalPlacement` | Always claim on the local node (default) |
| `HashPlacement` | Consistent hash of resource ID across alive nodes |
| `LeastLoadedPlacement` | Assign to node with fewest owned resources |
| `RandomPlacement` | Random alive node |

## Installation

```bash
git clone https://github.com/connorhoehn/distributed-core
cd distributed-core
npm install
npm test
```

## Testing

```bash
npm test                        # unit tests (~2 000 cases, 158 suites)
npm run test:integration        # multi-node integration tests
```

## Status

**Pre-1.0 / Research kernel.** The primitives are well-tested (~2 000 test cases across 158 suites) and the public surface is stabilising, but the library has not been used in production. Known limitations are documented honestly in `docs/ARCHITECTURE.md` — in particular, partition tolerance for `QuorumDistributedLock` and `ClusterLeaderElection` relies on majority-ACK without full consensus; split-brain is possible during network partition.

See `CHANGELOG.md` for what has changed recently and `docs/CLUSTER-READINESS-PLAN.md` for the design history and deferred work.

## Contributing

Issues and PRs welcome. The project has no formal contribution guide yet.

## License

See repository for license details.
