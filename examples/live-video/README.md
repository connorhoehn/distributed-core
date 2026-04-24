# live-video — Streaming Workload Stub

A **realistic stub** of a live-video SFU (Selective Forwarding Unit) built entirely
from distributed-core primitives. No real WebRTC, no real video frames; packets are
`setTimeout` timers dressed as media telemetry. The purpose is composition testing:
does the library cohere under a workload that is the opposite of `cluster-collab`?

## How to Run

```bash
cd /path/to/distributed-core
npx ts-node examples/live-video/run.ts
# Completes in ~6 seconds, exits 0
```

## What the Demo Does

| Phase | Action |
|-------|--------|
| 1 | 3 nodes start; `ClusterLeaderElection` elects a room controller |
| 2 | 10 rooms created across nodes via `ResourceRouter` + `DistributedSession` |
| 3 | 50 clients join random rooms via `ConnectionRegistry` (allowReconnect: true) |
| 4 | 5 seconds of simulated 100 Hz stats per client (~22 k packets) through `BackpressureController` |
| 5 | `node-B` is killed; `AutoReclaimPolicy` moves its 3 rooms to survivors |
| 6 | Displaced participants reconnect — `allowReconnect` absorbs duplicate registrations |
| 7 | Summary: rooms, participants, stats flushed, backpressure drops (zero) |

## Primitives Used

| Primitive | Role in this example |
|-----------|---------------------|
| `ResourceRouter` | Owns per-room SFU assignment (one node per room) |
| `DistributedSession` | Per-room state lifecycle (participants, transcoder flag) |
| `SharedStateManager` | Cross-node subscribe/apply for room state |
| `AutoReclaimPolicy` | Re-assigns rooms to surviving nodes on failure |
| `ConnectionRegistry` | Tracks participants; `allowReconnect: true` for failover |
| `DistributedLock` | Backing store for transcoder mutual exclusion |
| `TranscoderLock` | Domain wrapper: "one transcoder per stream" |
| `ClusterLeaderElection` | Elects a single room-controller node |
| `EventBus` | Room lifecycle events (participant.joined, transcoder.up, etc.) |
| `MetricsRegistry` | Per-node counters/gauges with child namespaces per room |
| `BackpressureController` | Throttles the stats firehose; `drop-oldest` strategy |
| `EntityRegistrySyncAdapter` | Two instances: one for routing, one for locks |

## What the Demo Proves

**The abstractions hold under streaming load.** A workload with exclusive ownership,
high-frequency writes, and hard failover composes from the same primitives as the
CRDT-friendly cluster-collab counter example — no primitive needed modification.

Specifically:
- `ResourceRouter` is not just for CRDT sessions; it owns SFU assignments cleanly.
- `AutoReclaimPolicy` + `DistributedSession` survive hard node kill with no manual
  intervention beyond calling `handleNodeLeft()`.
- `ConnectionRegistry(allowReconnect:true)` absorbs the "same clientId, new socket"
  pattern without special-casing.
- `BackpressureController` with `drop-oldest` and a 50ms flush interval absorbs a
  100 Hz firehose without starving the event loop.

## Honest Observations

These are real friction points discovered while building this example. They are
recorded here as the second-consumer validation signal.

### 1. Registry proliferation (most significant)
Composing three stateful primitives (ConnectionRegistry, DistributedLock,
ClusterLeaderElection) onto one node required **four separate EntityRegistry
instances** — because each primitive calls `registry.stop()` in its own teardown.
Sharing a single registry causes one primitive's teardown to break others mid-flight.

Wished-for API: a `registry.child()` or `registry.lease()` method that hands out
a sub-registry whose `stop()` is a no-op. The parent registry controls the actual
lifecycle. This would reduce four registries to one without lifecycle coupling.

### 2. Two sync adapters for two lock registries
Making `DistributedLock` cluster-wide (necessary for real mutual exclusion) required
a **second `EntityRegistrySyncAdapter`** on a separate PubSub topic. The connection
between "I need this primitive to be cluster-visible" and "I need a sync adapter for
its registry" is not surfaced in the docs or type signatures — you discover it by
watching the election elect a leader on every node simultaneously.

Wished-for: `DistributedLock` or `ClusterLeaderElection` could accept a PubSub
reference and manage their own sync adapter internally, hiding the wiring.

### 3. ClusterLeaderElection owns its router's lifecycle
`ClusterLeaderElection.start()` calls `router.start()` internally. If you pass the
same router that your session/reclaim policy uses, you get a double-start (harmless
but confusing) and a double-stop (destructive). The doc comment says the election
"owns" the router, but the constructor signature does not enforce this — it accepts
any `ResourceRouter`.

Wished-for: make the router an internal implementation detail of `ClusterLeaderElection`,
or accept a `(groupId) => ResourceRouter` factory so the election can own what it creates.

### 4. `session.hydrate()` after `session.join()` is the only way to set roomId
`DistributedSession.createState()` is called via the adapter; there's no way to pass
constructor arguments to the initial state. Setting `roomId` inside the session state
required a `hydrate()` call immediately after `join()`. Not broken, but slightly awkward
for domain types that need identity baked in from creation.

Wished-for: `session.join(sessionId, initialStateOverride?)` so the adapter's
`createState()` receives the sessionId as a hint.

### 5. Transcoder lock does not automatically re-acquire after failover
After `AutoReclaimPolicy` re-establishes room ownership, the reclaimed room shows
`transcoderLocked: false` in its state. The reclaim path does not automatically
re-acquire the transcoder lock — that's a separate, explicit operation. Correct
behaviour, but the implication is that you need a second "who is the transcoder?"
primitive working in parallel with the reclaim flow.

This is more an architectural observation than a library deficiency: the library
correctly separates room ownership from transcoder exclusion, and the caller must
coordinate both.

---

**This is NOT a real SFU.** No video is produced. No WebRTC handshakes occur.
Stats packets are random integers sent through `setTimeout` loops. The value is
demonstrating that the library's primitives compose correctly under a different
workload shape, not building production infrastructure.
