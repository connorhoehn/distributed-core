# Audit: Cluster, Connections, Routing

Date: 2026-04-23
Scope: `src/cluster/`, `src/connections/`, `src/routing/`

---

## Executive summary

The three highest-impact findings are: (1) `ClusterTopologyManager` registers
listeners with anonymous `.bind(this)` closures and then calls `.removeListener`
with freshly-created bound closures, making listener removal a guaranteed no-op
and leaking every handler for the lifetime of the process; (2) `ClusterCommunication`
(the `messaging/` copy, which `ClusterManager` actually imports) calls `handleMessage`
but the `core/` copy of the same class does not define that method — the two parallel
implementations are partially diverged; and (3) `DistributedLock._onExpired` silently
swallows `releaseEntity` errors via `.catch(() => {})`, meaning a failed release after
TTL expiry leaves the registry in an inconsistent state with no observable signal.
Event-naming debt is fully catalogued in `docs/EVENT-NAME-AUDIT.md` and is not
repeated here. API-composition friction is in `docs/API-FRICTION.md`. Overall code
health is good for the primitives that were recently refactored (`DistributedLock`,
`ResourceRouter`, `ConnectionRegistry`, `FailureDetectorBridge`); the older "manager"
layer classes carry more debt.

---

## High-severity findings

### H1. `ClusterTopologyManager.stop()` leaks all three member-event listeners

- **Where:** `src/cluster/topology/ClusterTopologyManager.ts:280–299`
- **What:** `start()` registers handlers using `this.handleNodeJoined.bind(this)` — each
  `.bind()` call creates a new function object. `stop()` then passes
  `this.handleNodeJoined.bind(this)` again to `.removeListener()`, which produces a
  *different* function object and therefore matches nothing. All three handlers
  (`member-joined`, `member-left`, `member-updated`) remain attached to the
  `ClusterManager` after `stop()` is called, and accumulate on every `start()/stop()`
  cycle.
- **Why it matters:** In long-running servers that restart the topology manager (e.g.,
  during rolling restarts or topology updates), each cycle leaks three listeners. Node's
  EventEmitter will emit the `MaxListenersExceededWarning` after 10 cycles and
  eventually degrade performance. The leaked handlers also hold a reference to the
  `ClusterTopologyManager` instance, preventing garbage collection.
- **Fix shape:** Store the bound closures as instance properties in the constructor
  (the same pattern used correctly in `ResourceRouter`, `ConnectionRegistry`,
  `DistributedSession`, and `FailureDetectorBridge`). Then pass those stored references
  to both `.on()` and `.off()`.

---

### H2. Two parallel `ClusterCommunication` classes are in diverged state

- **Where:** `src/cluster/core/communication/ClusterCommunication.ts` vs.
  `src/messaging/cluster/ClusterCommunication.ts`
- **What:** `ClusterManager` imports from `../messaging/cluster/ClusterCommunication`
  (line 24), which defines `handleMessage(message: Message)` at line 161. The other
  copy (`src/cluster/core/communication/`) implements a different subset: it has
  `handleGossipMessage` and `handleJoinMessage` but no `handleMessage`. Neither copy
  imports or delegates to the other. The `joinCluster()` method in the `core/` copy
  (line 62–68) does nothing beyond emitting a bare event — it does not contact seed
  nodes. These diverge silently with no compile error because both satisfy the same
  `IClusterCommunication` interface.
- **Why it matters:** If any future refactor wires `ClusterManager` to the `core/`
  copy instead of the `messaging/` copy, cluster join stops working with no exception.
  The abandoned copy also accumulates dead code that confuses contributors.
- **Fix shape:** Delete `src/cluster/core/communication/ClusterCommunication.ts` (the
  underperformed copy) and update the barrel `src/cluster/core/index.ts` to re-export
  from the canonical `messaging/` path. Or consolidate into the `core/` location and
  delete the `messaging/` copy — either direction is fine; both copies must not exist.

---

### H3. `DistributedLock._onExpired` silently swallows `releaseEntity` failure

- **Where:** `src/cluster/locks/DistributedLock.ts:168`
- **What:** When a lock's TTL timer fires, `_onExpired` deletes the local handle and
  emits `lock.expired.count` but then calls
  `this.registry.releaseEntity(lockId).catch(() => {})`. Any error from the registry
  (e.g., network partition, WAL write failure) is discarded.
- **Why it matters:** If the release fails, the remote registry still considers the
  lock held by this node. The next `acquire` attempt from any node will see the lock
  as still owned and block until a separate timeout. The metrics counter fires (giving
  the impression of a clean release) while the distributed state is inconsistent.
- **Fix shape:** At minimum, log or emit a metric on the catch arm. Ideally emit a
  `lock:release-failed` event (matching the `noun:verb` convention from
  `QuorumDistributedLock`) so callers can observe and remediate. A retry with backoff
  on ephemeral errors is a stronger fix.

---

## Medium-severity findings

### M1. `QuorumDistributedLock.stop()` does not drain pending requests or TTL timers

- **Where:** `src/cluster/locks/QuorumDistributedLock.ts:79–87`
- **What:** `stop()` unsubscribes from PubSub and clears `_started`, but does not
  cancel the in-flight `pendingRequests` (their `setTimeout` timers are left running)
  and does not clear `ttlTimers` or `remoteTimers`. If `stop()` is called while an
  `acquire` is outstanding, that acquire will eventually resolve (or time out) against
  a stopped instance, and the `_grantLocal` path will write into `heldLocks` on a
  stopped object, potentially confusing the next `start()` call.
- **Why it matters:** In test teardowns and rolling restarts, stale timers fire after
  the primitive is logically stopped, causing spurious `lock:acquired`/`lock:released`
  emissions. Compare `DistributedLock`, which clears all `ttlTimers` correctly on
  expiry, and `ConnectionPool`, which drains waiters on `drain()`.
- **Fix shape:** In `stop()`: iterate `pendingRequests` and call `pending.resolve(null)`
  after clearing timers; iterate `ttlTimers` and `remoteTimers` and clear each;
  clear all three maps.

---

### M2. `ClusterCommunication.sendPeriodicGossip` fans out `N` send calls but ignores the target list

- **Where:** `src/messaging/cluster/ClusterCommunication.ts` (the active copy) and
  `src/cluster/core/communication/ClusterCommunication.ts:277–289`
- **What:** In the `core/` copy, `sendPeriodicGossip` selects `targets` from the
  membership, then maps over `targets` calling
  `this.context!.gossipStrategy.sendPeriodicGossip(membership, recentUpdates)` —
  passing `membership` (the full list) rather than `target` (the specific recipient).
  The individual `target.id` is only referenced in the error emission, never in the
  actual send call. Gossip is therefore broadcast to every member every tick instead
  of only to the selected fanout subset.
- **Why it matters:** With a 100-node cluster and a fanout of 3, this is a 33× message
  amplification over the intended behaviour. Under load this degrades gossip
  convergence and saturates the transport layer.
- **Fix shape:** Pass `target` (the single `MembershipEntry`) to `sendPeriodicGossip`,
  or call `gossipStrategy.sendGossip([target], recentUpdates)`.

---

### M3. `ConnectionPool` uses `(connection as any).id` to retrieve the connection ID

- **Where:** `src/connections/ConnectionPool.ts:507`
- **What:** `getConnectionId(connection)` casts to `any` to access `.id`. The
  `Connection` class at `src/connections/Connection.ts:29` declares `id` as a
  `public readonly` property, so the cast is unnecessary and hides the contract.
  If a future `Connection` variant does not expose `.id`, this generates a
  fallback ID based on `Date.now() + Math.random()` — which breaks the O(1)
  lookup in `this.connections` because the generated key will never match an
  existing entry.
- **Why it matters:** A `Connection` whose `.id` is inaccessible via the cast would
  silently create a phantom key on every `acquire`, filling the pool with un-releasable
  entries until `drain()`.
- **Fix shape:** Remove the cast; use `connection.id` directly. If the type system
  complains, add `id: string` to the `Connection` interface in `types.ts`.

---

### M4. `DistributedSession.join` has a TOCTOU gap between `isLocal` check and `claim`

- **Where:** `src/cluster/sessions/DistributedSession.ts:100–119`
- **What:** `join()` calls `this.router.isLocal(sessionId)` (line 100), then — if not
  local — calls `this.router.claim(sessionId)` (line 106). Between the check and the
  claim, a concurrent caller on a different fiber could claim the same session ID,
  causing `claim` to throw. The catch block on line 107 then calls `isLocal` again.
  If that second `isLocal` check returns `true`, `this.sessions.get(sessionId)` is
  expected to return a value (line 109 uses `!` assertion), but this node's `sessions`
  map has not been populated because *this call* never reached the `sessions.set` at
  line 123 — the session was claimed by the concurrent fiber.
- **Why it matters:** The `!` non-null assertion at line 109 will panic (return
  `undefined` cast to `S`) if the session was claimed concurrently. Any downstream
  `apply` call will throw `SessionNotLocalError` even though `isLocal` returns `true`.
- **Fix shape:** After the second `isLocal` check returns `true`, guard with
  `this.sessions.has(sessionId)` before the `!` assertion and fall through to the
  routing response if the map entry is absent.

---

### M5. `ClusterManager.stop()` does not remove the `membership` event listeners set in the constructor

- **Where:** `src/cluster/ClusterManager.ts:143–155` (constructor), `196–219` (stop)
- **What:** Four `.on()` calls in the constructor wire the `MembershipTable`'s
  `member:joined`, `member:left`, `member:updated`, and `membership:updated` events to
  lambdas on `this`. `stop()` calls `this.removeAllListeners()` (line 219), which
  removes `ClusterManager`'s own listeners but does **not** remove the listeners
  registered on `this.membership` (a different `EventEmitter`). After `stop()`, the
  `MembershipTable` still holds four callbacks into the now-stopped `ClusterManager`,
  preventing GC and potentially emitting into a dead object.
- **Why it matters:** In environments that construct and destroy `ClusterManager`
  repeatedly (tests, hot-reload), memory grows with each instance. Compare
  `ResourceRouter.stop()` which explicitly calls `.off()` on both `registry` and
  `cluster`.
- **Fix shape:** In `stop()`, call `this.membership.off(...)` for each of the four
  event names using named/stored handler references, or call
  `this.membership.removeAllListeners()` if no other consumer shares the membership
  table instance.

---

## Low-severity findings

### L1. `ClusterLifecycle` has duplicate implementation in two locations

- **Where:** `src/cluster/lifecycle/ClusterLifecycle.ts` and
  `src/cluster/core/lifecycle/ClusterLifecycle.ts`
- **What:** Two files with the same class name, both extending `EventEmitter` and
  implementing `IClusterLifecycle`. The `ClusterManager` uses the `lifecycle/` version.
  The `core/lifecycle/` version may be unreachable dead code.
- **Fix shape:** Verify which copy is imported across the codebase, delete the orphan,
  and update any barrel exports.

---

### L2. `ConnectionManager` does not implement `LifecycleAware`

- **Where:** `src/connections/ConnectionManager.ts:6`
- **What:** `ConnectionManager` has `closeAll()` (sync) but no `start()`/`stop()`
  pair and does not implement `LifecycleAware`. Every peer primitive in scope
  (`ConnectionRegistry`, `ConnectionPool`, `DistributedSession`, `ResourceRouter`,
  `LeaderElection`, etc.) implements `LifecycleAware`. The absence makes it impossible
  to wire `ConnectionManager` into `ApplicationRegistry` or any lifecycle-aware
  composition harness uniformly.
- **Fix shape:** Add `async start(): Promise<void>` (no-op body) and rename `closeAll`
  to `stop()`, implementing `LifecycleAware`.

---

### L3. `ClusterRouting.getNodesForKey` with `ROUND_ROBIN` returns all nodes, ignoring `replicationFactor`

- **Where:** `src/routing/ClusterRouting.ts:61–62`
- **What:** The `ROUND_ROBIN` branch returns
  `this.getAliveMembers().map(member => member.id)` — every alive member — regardless
  of `opts.replicationFactor`. The `RANDOM` branch correctly slices to
  `opts.replicationFactor`. A caller expecting at most 3 replicas gets the full member
  list.
- **Fix shape:** Slice to `opts.replicationFactor` consistent with the other branches.

---

### L4. `heartbeat` in `ConnectionRegistry` re-schedules without metrics update

- **Where:** `src/connections/ConnectionRegistry.ts:170–181`
- **What:** The `heartbeat()` method reschedules the eviction timer but omits the
  `connection.active.gauge` metric update that `register()` includes. The gauge will
  under-report active connections after reconnect heartbeats.
- **Fix shape:** Add the metrics gauge update in the `heartbeat()` callback body,
  matching the pattern in `register()`.

---

### L5. `DistributedLock.release` does not verify the caller is the owner

- **Where:** `src/cluster/locks/DistributedLock.ts:80–89`
- **What:** `release(lockHandle)` checks `this.heldLocks.has(lockId)` but does not
  verify `lockHandle.nodeId === this.localNodeId`. A stale handle (e.g., from before
  a crash-and-restart) with a matching `lockId` from a different node would silently
  pass the guard and call `releaseEntity`, forcibly removing a lock not owned by this
  node.
- **Fix shape:** Add `|| lockHandle.nodeId !== this.localNodeId` to the early-return
  guard.

---

## Counts

- TODO/FIXME comments: 0 (none found in scope)
- `as any` / `as unknown as` instances: 6
  - `src/cluster/aggregation/StateAggregator.ts:711` — `strategy as any`
  - `src/cluster/config/ConfigManager.ts:99` — `def as unknown as ConfigKeyDefinition<unknown>`
  - `src/cluster/observability/ObservabilityManager.ts:605, 618, 636` — `timeHorizon as any` (×3)
  - `src/connections/ConnectionPool.ts:507` — `(connection as any).id`
- Listener registrations without paired removal: 3
  - `ClusterTopologyManager` (`member-joined`, `member-left`, `member-updated`) — H1
  - `ClusterManager` constructor listeners on `MembershipTable` — M5
- Public methods missing tests:
  - `ConnectionPool` — no unit test file exists; `acquire`, `release`, `drain`,
    `destroy`, `getHealthStatus`, `updateOptions` are untested at the unit level
  - `ConnectionManager` — no unit test file exists; `broadcast*`, `cleanup`,
    `updateConnectionIndex` are untested
  - `ClusterCommunication` (both copies) — no unit test; `runAntiEntropyCycle`,
    `handleGossipMessage`, `handleJoinMessage`, `sendJoinResponse` are untested
  - `ClusterTopologyManager` — `registerRoom`, `updateRoomMetadata`,
    `analyzeRoomSharding`, `getRoomDistributionRecommendations` lack unit tests

---

## Patterns that recur

Three cross-cutting issues appear across multiple files. First, the "store bound
handlers as instance properties" pattern is the established idiom (`ResourceRouter`,
`ConnectionRegistry`, `FailureDetectorBridge`, `AutoReclaimPolicy`,
`ResourceRouterSyncAdapter`, `DistributedSession` all follow it correctly), yet
`ClusterTopologyManager` and the `ClusterManager` constructor ignore it — any future
primitive that registers listeners in the constructor and removes them in `stop()`
should default to the stored-property pattern. Second, `stop()` cleanup completeness
is inconsistent: the newer primitives (`DistributedLock`, `ConnectionRegistry`,
`ServiceRegistry`) cancel all timers and clear all maps; the older or larger manager
classes (`QuorumDistributedLock`, `ClusterManager`) miss one or more cleanup steps.
A checklist comment in `LifecycleAware` (or a lint rule) would catch this. Third,
there are two orphaned parallel implementations (`ClusterCommunication` in two
locations, `ClusterLifecycle` in two locations) — both pairs arose during a modular
refactor that extracted functionality into `core/` subdirectories without removing the
originals. A dead-code pass should remove both orphans before they accumulate diverging
fixes.

---

## Action list (prioritized)

1. **Fix `ClusterTopologyManager` listener leak (H1)** — store bound handlers as
   instance properties; update `start()` and `stop()` to use them. Immediate risk of
   listener accumulation in any multi-lifecycle deployment.

2. **Delete the orphaned `ClusterCommunication` copy (H2)** — the `core/` version is
   not imported and is partially broken. Remove the file and update barrel exports to
   prevent any future accidental import.

3. **Emit on `DistributedLock._onExpired` catch arm (H3)** — replace
   `.catch(() => {})` with at minimum a metric increment and ideally a
   `lock:release-failed` event so operators can detect inconsistent lock state.

4. **Drain pending requests in `QuorumDistributedLock.stop()` (M1)** — clear all
   three timer maps and resolve outstanding pending requests with `null` to prevent
   post-stop event emissions.

5. **Remove `ClusterManager` constructor listeners on `stop()` (M5)** — store the
   four `MembershipTable` handler references in constructor and call `.off()` in
   `stop()` before `removeAllListeners()`.

6. **Fix `ClusterRouting.ROUND_ROBIN` to respect `replicationFactor` (L3)** — one-line
   fix with high correctness impact for any caller relying on bounded replica counts.

7. **Add `LifecycleAware` to `ConnectionManager` (L2)** — aligns with every other
   connection/session primitive in scope; enables uniform lifecycle management.

8. **Add unit tests for `ConnectionPool` and `ConnectionManager`** — both are
   non-trivial classes with zero unit test coverage; `ConnectionPool` has complex
   queue and health-check paths that are currently exercised only implicitly.
