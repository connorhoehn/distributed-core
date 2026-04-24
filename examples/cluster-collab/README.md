# cluster-collab — Collaborative Counter Example

This example demonstrates how to compose six distributed-core primitives into a
working multi-node service. Multiple clients connect to one of three in-process
nodes; each counter lives on exactly one node; state propagates across nodes via
PubSub; when a node dies, its counters are automatically reclaimed by surviving
nodes. The whole cluster runs inside a single Node.js process, using an in-memory
PubSub bus so the demo is self-contained and reproducible.

## How to run

```bash
cd /path/to/distributed-core
npx ts-node examples/cluster-collab/run.ts
```

Completes in about 4 seconds and prints human-readable output with timestamps.

## Primitives composed

| Primitive | Why |
|---|---|
| `EntityRegistry` (InMemory) | Per-node store for "who owns which counter" |
| `EntityRegistrySyncAdapter` | Propagates ownership mutations over PubSub so every node has a consistent view |
| `ResourceRouter` | Claims / releases / locates a counter; emits `resource:orphaned` when a node dies |
| `DistributedSession` | Manages per-counter state lifecycle (create, apply update, idle eviction) |
| `SharedStateManager` | Wraps DistributedSession; adds cross-node PubSub fanout for follower nodes |
| `AutoReclaimPolicy` | Listens for `resource:orphaned` and re-claims orphaned counters after a jitter delay |
| `ConnectionRegistry` | Tracks which clients are connected to this node |
| `EventBus` | Typed cluster-wide event stream for observability |
| `MetricsRegistry` | Per-node counters and gauges, snapshotted in the final summary |

The key insight: a single `EntityRegistrySyncAdapter` wired to one shared
`EntityRegistry` makes every primitive that reads that registry cluster-aware
without changing any primitive's constructor signature.

## Expected output

```
--- PHASE 1: STARTUP — 3-node cluster ---
  node-A, node-B, node-C each started

--- PHASE 2: CLIENT CONNECT + COUNTER CREATION ---
  5 clients connect; each subscribes to one counter
  node-A: 2 local counters, node-B: 2, node-C: 1

--- PHASE 3: UPDATES FLOWING (2 seconds) ---
  ~100 random inc/dec/reset operations applied

--- PHASE 4: NODE FAILURE — killing node-B ---
  node-B killed; it owned counter-beta and counter-gamma

--- PHASE 5: AUTO-RECLAIM ---
  AutoReclaimPolicy fires on surviving nodes; one reclaims both counters

--- PHASE 6: UPDATES POST-FAILURE ---
  ~30-50 more updates flow on the reclaimed counters

--- PHASE 7: FINAL SUMMARY ---
  All 5 counters have final counts; per-node metrics snapshot printed
```
