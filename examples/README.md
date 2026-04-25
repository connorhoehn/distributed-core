# distributed-core Examples

Six example applications demonstrating the core primitives of the distributed-core library.

## Prerequisites

Build the library from the repository root before running any example:

```bash
npm run build
```

## Examples

### 1. kv-database (Key-Value Store)

Demonstrates RangeCoordinator, RangeHandler, and StateStore for a distributed key-value database with consistent hash routing.

```bash
cd examples/kv-database
npm install
npx ts-node src/index.ts
npm test
```

### 2. queue-worker (Distributed Task Queue)

Demonstrates RangeCoordinator for work partitioning where each range acts as a task queue partition with ENQUEUE, DEQUEUE, and ACK operations.

```bash
cd examples/queue-worker
npm install
npx ts-node src/index.ts
npm test
```

### 3. api-server (HTTP-like API Cluster)

Demonstrates the Node class with Router, ConnectionManager, and message handlers for HTTP-like route handling across a cluster.

```bash
cd examples/api-server
npm install
npx ts-node src/index.ts
npm test
```

### 4. management-agent (Cluster Management Dashboard)

Demonstrates DiagnosticTool, MetricsTracker, and ChaosInjector for cluster monitoring, health dashboards, and fault injection experiments.

```bash
cd examples/management-agent
npm install
npx ts-node src/index.ts
npm test
```

### 5. cluster-collab (Collaborative Counter)

The canonical multi-node demonstration. Multiple clients connect to one of three
in-process nodes; each counter is owned by exactly one node; ownership propagates
via `EntityRegistrySyncAdapter` over an in-memory PubSub bus; when a node dies its
counters are automatically reclaimed by surviving nodes via `AutoReclaimPolicy`.
Composes nine primitives: `EntityRegistry`, `EntityRegistrySyncAdapter`,
`ResourceRouter`, `DistributedSession`, `SharedStateManager`, `AutoReclaimPolicy`,
`ConnectionRegistry`, `EventBus`, and `MetricsRegistry`. Completes in ~4 seconds
and prints a timestamped human-readable trace of every phase (startup, client
connect, updates, node kill, reclaim, final metrics snapshot).

```bash
tsx examples/cluster-collab/run.ts
```

### 6. live-video (Streaming Workload Stub)

A realistic stub of a live-video SFU (Selective Forwarding Unit) built entirely
from distributed-core primitives — no real WebRTC or video frames. Timer-driven
"media telemetry" packets exercise `BackpressureController` at ~100 Hz per
simulated client. Composes twelve primitives: `ResourceRouter`,
`DistributedSession`, `SharedStateManager`, `AutoReclaimPolicy`,
`ConnectionRegistry`, `DistributedLock`, `ClusterLeaderElection`, `EventBus`,
`MetricsRegistry`, `BackpressureController`, `EntityRegistrySyncAdapter`, and a
domain `TranscoderLock` wrapper. Demonstrates that exclusive ownership, high-
frequency writes, and hard failover all compose from the same primitives as the
CRDT-friendly cluster-collab example without modification to any primitive.
Completes in ~6 seconds and exits 0.

```bash
tsx examples/live-video/run.ts
```

## Shared Utilities

The `shared/` directory contains helpers used across examples:

- **cluster-helper.ts** -- factory functions for creating in-memory example clusters
- **logger.ts** -- simple console logger with timestamps and labels

## Architecture Notes

- All examples use `in-memory` transport (single-process demos)
- All imports use `'distributed-core'` to prove the package boundary
- Each example is self-contained and runnable standalone
