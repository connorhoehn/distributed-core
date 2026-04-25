# API Friction Observations

Real-use feedback from the `examples/live-video/` stub (a second-consumer
validation exercise composing 11 primitives in a different shape from
`examples/cluster-collab/`). Captured here so the signal isn't lost.

These are not bugs. The library works. They are ergonomic observations
that would inform a future API polish pass.

## How to read this

Each entry has: **Observation**, **Workaround used**, **Root cause**,
**Suggested fix** (with API sketch), and **Priority** (High / Medium / Low).

Priorities are calibrated to consumer shipping pain, not problem
interestingness. None of these block usage.

---

## 1. Registry proliferation when composing primitives [High]

**Observation.** Composing `ConnectionRegistry` + `DistributedLock` +
`ClusterLeaderElection` on one node required four separate `EntityRegistry`
instances. Each primitive calls `registry.stop()` in its own teardown; sharing
one causes the first teardown to destroy the registry that all others are
still using.

**Workaround used.** One `createMemory(nodeId)` per primitive. Works, but
multiplies setup boilerplate and makes integration tests harder to read.

**Root cause.** `EntityRegistry.stop()` terminates the store unconditionally.
There is no shared-ownership primitive.

**Suggested fix.** Reference-counted leases:

```typescript
const shared = createMemory(nodeId);
const r1 = shared.lease();  // increments refcount
const r2 = shared.lease();
await r1.release();          // decrements; stop fires only when refcount hits 0
```

Alternatively, `registry.child()` — a scoped view whose `stop()` is a no-op
on the parent. Either collapses four allocations to one.

**Priority: High.** Four registries per node is the normal shape when composing
primitives, not an edge case. Scales poorly as the count grows.

---

## 2. Cross-node lock visibility requires hidden coupling [High]

**Observation.** `DistributedLock` uses `proposeEntity` on its registry. For
cluster-visible locking the registry must have an `EntityRegistrySyncAdapter`
wired to a PubSub topic. Without it every node independently wins its own
election on its own private registry. The symptom (all three nodes elect
themselves leader) does not point toward the missing adapter; the connection
between "cross-node visibility" and "sync adapter required" is invisible in the
type signatures.

**Workaround used.** Wire a second `EntityRegistrySyncAdapter` on a dedicated
topic to the lock's registry. Works once you know to do it; discovery requires
observing impossible behavior then reading source.

**Root cause.** `DistributedLock` accepts a plain `EntityRegistry` regardless
of whether cross-node sync is wired. See `docs/CLUSTER-READINESS-PLAN.md` —
the adapter was kept generic and external by design; the cost is invisible
wiring requirements.

**Suggested fix.** Make the requirement structural — either a marker interface
or a factory:

```typescript
// Option A: marker interface narrows the constructor
interface ClusterScopedRegistry extends EntityRegistry { readonly syncTopic: string; }
class DistributedLock { constructor(registry: ClusterScopedRegistry, ...); }

// Option B: factory wires both at once
const { registry, syncAdapter } = createClusteredRegistry({ pubsub, nodeId, topic });
```

**Priority: High.** Silent correctness failure (every node wins) is the worst
discovery path. Workaround is a one-liner once known.

---

## 3. ClusterLeaderElection assumes exclusive router ownership [Medium]

**Observation.** `ClusterLeaderElection.start()` calls `router.start()`
internally, treating the passed `ResourceRouter` as exclusively owned. The
constructor accepts any `ResourceRouter` with no indication of ownership
transfer. Passing the main application router causes double-start and
double-stop.

**Workaround used.** A dedicated `electionRegistry` + `electionRouter` used
only by `ClusterLeaderElection`. Avoids the conflict but leaves the node
maintaining two separate routers.

**Root cause.** `ClusterLeaderElection` calls lifecycle methods on the router
it receives but does not communicate this. `DistributedSession` already has an
`ownsRouter` config field; `ClusterLeaderElection` does not follow the same
pattern.

**Suggested fix.** Mirror the convention from `DistributedSession`:

```typescript
config: ClusterLeaderElectionConfig & { ownsRouter?: boolean }
// default true for backward compat; false = caller manages lifecycle
```

**Priority: Medium.** Dedicated router is low-cost. Footgun is loud
(double-start fails immediately) rather than silent.

---

## 4. No initial-state hint on session.join [Low]

**Observation.** `DistributedSession.join(sessionId)` calls
`adapter.createState()` with no arguments. Setting `roomId` in `RoomState`
required an immediate `session.hydrate(roomId, {...})` after `join()` — a
two-step join where the ID was known at join time.

**Workaround used.** `join` then `hydrate`. No observable problem because
all downstream wiring happens after `join` returns.

**Root cause.** `SharedStateAdapter.createState()` takes no arguments, so
there is no channel for session identity to flow into initial state.

**Suggested fix.**

```typescript
// Adapter form (keeps state construction in one place):
interface SharedStateAdapter<S, U> { createState(sessionId?: string): S; }

// Or call-site form (no adapter change needed):
session.join(sessionId, initialStateHint?: Partial<S>);
```

**Priority: Low.** Only matters if `createState` has side effects requiring
the id (e.g., a store load). It did not in this case.

---

## 5. Auto-reclaim does not re-acquire associated locks [Medium]

**Observation.** After `node-B` failure, `AutoReclaimPolicy` re-establishes
routing and session state for reclaimed rooms but does not re-acquire any
`DistributedLock` associated with those rooms on the failed node. The
transcoder lock must be explicitly re-acquired by the caller. The
`reclaim:succeeded` event provides the `resourceId` needed to do this, but
the pattern is non-obvious.

**Workaround used.**

```typescript
autoReclaim.on('reclaim:succeeded', async (handle) => {
  await transcoderLock.acquire(handle.resourceId);
});
```

**Root cause.** Architecturally correct — room ownership and transcoder
exclusion are orthogonal concerns; `AutoReclaimPolicy` has no knowledge of
which locks a caller associated with a resource. The gap is documentation, not
design.

**Suggested fix.** Either document the `reclaim:succeeded` + lock re-acquisition
pattern in `AutoReclaimPolicy` JSDoc (zero code change), or add an optional hook:

```typescript
new AutoReclaimPolicy(router, {
  onReclaim: async (resourceId) => { await transcoderLock.acquire(resourceId); },
});
```

**Priority: Medium.** Workaround is clean. Risk: callers who add a lock later
may omit the reclaim handler — a silent failure until the next node failure.

---

## What we're NOT doing about these

- Not breaking existing APIs now. `social-api` and the gateway bridge are
  wiring Phase 4 against the current shape. Polish waits for more consumer
  signal.
- Not designing a generic "primitive composition kit" yet. Wait for at least
  one more consumer (`social-api` Phase 4). Two consumers hitting the same
  friction = real abstraction; one consumer = idiosyncratic.

## How to add to this list

When you build on distributed-core and hit friction:
1. Workaround it locally so you can ship.
2. Open a PR adding an entry here with the five fields above.
3. Do not fix the API in the same PR — that is a separate decision.

Two consumers reporting the same friction = signal worth designing around.
One consumer = idiosyncratic.
