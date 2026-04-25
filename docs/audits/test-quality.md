# Audit: Test Suite Quality

Date: 2026-04-23
Scope: test/unit/ (111 files), test/integration/ (38 files), test/e2e/ (18 files)

---

## Executive Summary

The suite is large (167 test files across three tiers) and generally well-structured. The most
significant problems are concentrated in three areas: timing-dependent unit tests that rely on
real-wall-clock `setTimeout` delays (45 occurrences in unit/ alone), two test files that open
real network sockets on hardcoded ports that overlap between tiers, and a cluster of orphaned
`setInterval` timers in the metrics tests caused by `MetricsExporter` starting its flush interval
in its own constructor. There are also six misclassified files (integration-grade tests living in
`unit/`), one pair of byte-for-byte duplicate test files, and nine local `makeCluster`/`makeRouter`
factories that duplicate shared helper logic already available in `test/helpers/`.

---

## High-Severity Findings

### H-1 — MetricsExporter starts a `setInterval` in its constructor; test file leaks it for the default instance

`MetricsExporter` calls `this.startAutoFlush()` from its constructor when `enableBuffering` is
`true` (the default). `test/unit/metrics/MetricsExporter.test.ts:120` creates:

```ts
const defaultExporter = new MetricsExporter({ destinations: [] });
```

No `flushInterval` is overridden, so the production default of 30 000 ms fires. The instance is
never stopped. The `afterEach` on line 113 only calls `exporter.stopAutoFlush()` on the shared
`exporter` variable, not on `defaultExporter`. The orphaned timer runs for the lifetime of the
Jest worker.

**Files:** `test/unit/metrics/MetricsExporter.test.ts:120`
**Also affects:** same file lines 139 (`customExporter` — `enableBuffering:false` in config at
line 131, so safe) — only the default-config instance is at risk.

### H-2 — Real HTTP server opened on port 9001 in a unit test; same port used in integration test

`test/unit/transport/HTTPAdapter.test.ts` binds port 9001 (line 137, 229, 257). The
`test/integration/transport/HTTPAdapter.integration.test.ts` uses port 9004 and 9005. Port 9005
is also claimed by `HTTPAdapter.test.ts` line 203. If both suites run concurrently (e.g., with
`--maxWorkers` > 1 and no suite isolation), an `EADDRINUSE` kills one test. More broadly, the
unit test file starts a real HTTP server — it is misclassified (see M-3).

**Files:** `test/unit/transport/HTTPAdapter.test.ts:137,203,229,257`,
`test/integration/transport/HTTPAdapter.integration.test.ts:9,133`

### H-3 — `seed-node-registry` unit test sleeps 350 ms waiting for a health-monitoring timer; will fail under load

Two tests (`'should recover failed seeds automatically'`, `'should emit health check completed events'`)
call `registry.startHealthMonitoring()` and then:

```ts
await new Promise(resolve => setTimeout(resolve, 350));
```

The health check interval is presumably configured just under 350 ms. On a loaded CI runner the
timer fires late; the assertion on `healthStatus.availableSeeds` or `healthCheckEvent` then fails.

**Files:** `test/unit/cluster/seeding/seed-node-registry.unit.test.ts:281,307`

### H-4 — `checkpoint-recovery` unit test writes to relative paths shared across parallel workers

All four `beforeEach`/`afterEach` blocks use the hard-coded relative paths:

```ts
const testDir = './test-data/checkpoints';
const walDir  = './test-data/wal';
```

If Jest runs two workers pointing at the same CWD these directories collide. Other test files
correctly use `os.tmpdir() + randomUUID()`.

**Files:** `test/unit/cluster/checkpoint-recovery.test.ts:8-9`

### H-5 — `MetricsTracker` test: `shortTracker` with 150 ms wall-clock wait in a unit test

```ts
const shortTracker = new MetricsTracker({ retentionPeriod: 100 });
await new Promise(resolve => setTimeout(resolve, 150));
```

The retention check is purely algorithmic — `Date.now()` comparisons on stored timestamps. This
can be tested instantly with `jest.useFakeTimers()` and `jest.advanceTimersByTime(150)`.
Currently the test adds 150 ms of wall-clock time to every run.

**Files:** `test/unit/metrics/MetricsTracker.test.ts:228`

**Related:** `test/unit/observability/metrics-system.test.ts:554` waits 600 ms for the same
reason (`shortRetentionTracker`). `test/unit/metrics/MetricsExporter.test.ts:331,350` use 200 ms
and 150 ms waits for flush-timer tests that could use fake timers.

---

## Medium-Severity Findings

### M-1 — `cross-adapter-integration.test.ts` lives in `unit/` but starts real HTTP and WebSocket servers

`test/unit/transport/cross-adapter-integration.test.ts` imports `HTTPAdapter` and
`WebSocketAdapter`, calls `.start()` and `.stop()` on both, and at line 33 waits:

```ts
await new Promise(resolve => setTimeout(resolve, 100));
```

This is integration behaviour — real OS sockets, real async I/O. Jest's default unit config
(in `jest.config.js`) excludes `.integration.test.ts` files but picks this up as a unit test.

**Files:** `test/unit/transport/cross-adapter-integration.test.ts`

### M-2 — `cluster-lifecycle-e2e.test.ts` lives in `unit/` with a 15 s timeout

The file header says "End-to-End Cluster Lifecycle Integration Test" and its `jest.setTimeout`
is 15 000 ms. It uses real `Node` instances with `InMemoryAdapter`. It belongs in
`test/integration/cluster/`.

**Files:** `test/unit/cluster/lifecycle/cluster-lifecycle-e2e.test.ts:1,29`

### M-3 — `HTTPAdapter.test.ts` and `WebSocketAdapter.test.ts` open real sockets in `unit/`

Both files call `adapter.start()`, which binds real ports (9001–9013, 9050 for WS; 9001 for
HTTP). `HTTPAdapter.test.ts` also makes real HTTP requests using `http.request` in done-callback
style (lines 226, 254). These are integration-level.

**Files:** `test/unit/transport/HTTPAdapter.test.ts`,
`test/unit/transport/WebSocketAdapter.test.ts`

### M-4 — `yaml-seed-configuration.integration.test.ts` placed inside `test/unit/config/`

The filename explicitly says "integration" and reads from `test/fixtures/config-examples/`. It
should live in `test/integration/`.

**Files:** `test/unit/config/yaml-seed-configuration.integration.test.ts`

### M-5 — Identical duplicate test files: `entity-registry.unit.test.ts` and `entity-registry-clean.unit.test.ts`

Both files are 307 lines and have the same MD5 checksum (`21eae9183ac180c9920fd61bb2b1c658`).
Every test is run twice with identical assertions. One should be deleted.

**Files:** `test/unit/cluster/entity-registry.unit.test.ts`,
`test/unit/cluster/entity-registry-clean.unit.test.ts`

### M-6 — `Math.random()` without seeding in `delta-sync-network.test.ts` and related files

Node metrics are populated with:

```ts
requests: Math.floor(Math.random() * 10000),
latency:  Math.floor(Math.random() * 200),
```

If any assertion depends on ordering or thresholds derived from these values, the test is
non-deterministic. Currently assertions appear to be structural ("fields exist", "sync
completes"), so this is a medium-risk data-quality concern.

**Files:** `test/unit/cluster/delta-sync-network.test.ts:91-98`,
`test/integration/state/delta-sync-algorithms.test.ts:92-96`,
`test/integration/cluster/multi-node-cluster.integration.test.ts:127-129`

### M-7 — `done`-callback style in five unit tests; async equivalents are cleaner

The `done` pattern is error-prone (a second `done()` call after an assertion failure swallows the
error). All five sites are straightforward EventEmitter listener patterns that would be simpler
with `Promise`/`async`.

**Files:**
- `test/unit/cluster/bootstrap-config.unit.test.ts:102`
- `test/unit/transport/CircuitBreaker.test.ts:123,133`
- `test/unit/transport/HTTPAdapter.test.ts:226,254`

### M-8 — `cluster-convergence.test.ts` individual test timeout of 60 s is unusually high for an integration test

Two tests use `it('…', async () => { … }, 60000)` with `waitForConvergence(30000)`. The 30 s
convergence budget is reasonable for e2e, but this file is in `test/integration/frontdoor/`.
Flag for review: should it live in `test/e2e/`?

**Files:** `test/integration/frontdoor/cluster-convergence.test.ts:16,33,48`

---

## Low-Severity Findings

### L-1 — `makeCluster` factory reimplemented in nine separate test files

A near-identical stub that creates an `EventEmitter`-backed cluster with a `Map<string,
MembershipEntry>` appears in:

```
test/unit/routing/ResourceRouter.test.ts:19
test/unit/routing/AutoReclaimPolicy.test.ts:23
test/unit/routing/ResourceRouterSyncAdapter.test.ts:13
test/unit/cluster/locks/ClusterLeaderElection.test.ts:12
test/unit/cluster/locks/QuorumDistributedLock.test.ts:49
test/unit/cluster/sessions/DistributedSession.test.ts:15
test/unit/cluster/failure/FailureDetectorBridge.test.ts:22
test/unit/gateway/state/SharedStateManager.test.ts:31
test/unit/gateway/pubsub/SignedPubSubManager.test.ts:25
```

`test/helpers/` already exists (contains `mockTransport.ts`, `spyLogger.ts`, etc.). A shared
`makeClusterStub` helper there would reduce duplication and ensure consistent behaviour (e.g., the
`ResourceRouter` version omits a `lastUpdated` field present in `AutoReclaimPolicy` — spotted by
`diff`).

### L-2 — `makeRouter` reimplemented in six routing unit test files

Same pattern for the router factory:

```
test/unit/routing/ForwardingRouter.test.ts:6
test/unit/routing/ForwardingServer.test.ts:7
test/unit/routing/ForwardingServer.metrics.test.ts:12
test/unit/routing/HttpsForwardingServer.test.ts:63
test/unit/routing/ResourceRouter.test.ts:67
test/unit/routing/ResourceRouterSyncAdapter.test.ts:79
```

### L-3 — `makeFakeLLMClient` duplicated between unit and integration pipeline test files

Implementations are functionally identical. Should be exported from a shared helper.

**Files:** `test/unit/applications/pipeline/EventRenameDeprecation.test.ts:66`,
`test/integration/pipeline/pipelineModule.integration.test.ts:51`

### L-4 — `makeNode` duplicated across three integration cluster test files with identical bodies

```
test/integration/cluster/quorum-real-cluster.integration.test.ts:17
test/integration/cluster/rolling-restart.integration.test.ts:17
test/integration/cluster/seed-node-failover.integration.test.ts:17
```

### L-5 — Exact `timestamp` ordering assertion without fake timers in `MetricsTracker.test.ts`

```ts
expect(history[0].timestamp).toBeLessThan(history[1].timestamp); // line 219
```

Depends on two `collectMetrics()` calls returning different `Date.now()` values. Will pass in
practice but is technically order-sensitive without `jest.useFakeTimers()`.

**Files:** `test/unit/metrics/MetricsTracker.test.ts:219`

### L-6 — Integration tests with large timing sleeps that are legitimate but should be documented

Files with 500 ms or longer waits that relate to real protocol behaviour (not algorithmic tests):
- `test/integration/cluster/rolling-restart.integration.test.ts:149,155` (500 ms)
- `test/integration/transport/cross-adapter-interop.integration.test.ts:120` (500 ms)
- `test/integration/transport/http-websocket-integration.test.ts:142,192,207,224` (300–400 ms)

These are not necessarily wrong (they test real timeout/retry behaviour), but a comment
explaining the expected range would prevent future developers from blindly tightening them.

### L-7 — `EventRenameDeprecation.test.ts` in unit/ uses 8 wall-clock `setTimeout` waits for event propagation

All 8 waits are 10 ms. The underlying `EventEmitter` calls are synchronous; the waits are
defensive padding. `jest.useFakeTimers()` or restructuring to await a resolved promise would
remove the delays entirely.

**Files:** `test/unit/applications/pipeline/EventRenameDeprecation.test.ts:270,310,348,385,419,456,489,512`

---

## Counts

| Metric | Value |
|---|---|
| Total test files (unit/integration/e2e) | 167 |
| Unit files with timing-dependent `setTimeout` waits | 13 |
| Integration files with timing-dependent waits | 18 |
| Total `await new Promise(r => setTimeout(r, X))` occurrences in unit/ | 45 |
| Tests with `jest.setTimeout` > 10 000 ms | 8 |
| Skipped / todo tests | 0 |
| Hardcoded-port conflicts between tiers | 2 (port 9005 HTTP, port 8081 WS) |
| Orphaned `setInterval` instances (confirmed) | 1 (`defaultExporter` in MetricsExporter.test.ts) |
| Misclassified test files | 4 (cross-adapter, lifecycle-e2e, HTTPAdapter, yaml-integration) |
| Duplicate test files (byte-identical) | 1 pair |
| Duplicated helper factories (`makeCluster` variants) | 9 files |

**Skipped / TODO tests:** None found — `.skip`, `xit`, `xtest`, `.todo` returned zero matches
across all three tiers.

**Slow tests (jest.setTimeout > 5 000 ms):**
- `test/unit/cluster/entity-registry-clean.unit.test.ts` — 10 000 ms
- `test/unit/cluster/entity-registry.unit.test.ts` — 10 000 ms (duplicate)
- `test/unit/cluster/entity/WALEntityRegistry.test.ts` — 15 000 ms
- `test/unit/cluster/entity/EntityRegistryFactory.test.ts` — 10 000 ms
- `test/unit/cluster/entity/CrdtEntityRegistry.test.ts` — 10 000 ms
- `test/unit/cluster/lifecycle/cluster-lifecycle-e2e.test.ts` — 15 000 ms (misclassified)
- `test/integration/cluster/seed-node-failover.integration.test.ts` — 20 000 ms
- `test/integration/pipeline/pipelineModule.integration.test.ts` — 30 000 ms (two suites)
- `test/integration/cluster/quorum-real-cluster.integration.test.ts` — 20 000 ms
- `test/integration/cluster/gossip-protocol.integration.test.ts` — 20 000 ms
- `test/integration/cluster/rolling-restart.integration.test.ts` — 30 000 ms
- `test/integration/frontdoor/cluster-convergence.test.ts` — 60 000 ms (per-test)

---

## Patterns That Recur

1. **Wall-clock polling in algorithmic unit tests.** Retention expiry, health-check recovery, and
   metrics flush are all pure timer logic tested with real `setTimeout`. `jest.useFakeTimers()`
   would make these tests instant and deterministic.

2. **Local `makeCluster` stub.** Nine files define the same thin EventEmitter wrapper. The
   signatures diverge slightly (some include `lastUpdated`, some do not), making subtle
   behavioural differences possible.

3. **Transport adapters in `unit/`.** Three adapter files open real OS sockets and then call
   production `.start()`. They belong in `test/integration/transport/` alongside the explicit
   integration tests already there.

4. **Hardcoded ports with no randomisation.** Neither transport unit tests nor integration tests
   use `port: 0` (OS-assigned). Running the full suite with `--maxWorkers` exposes EADDRINUSE
   races.

---

## Action List (Prioritised)

1. **(High — likely flaky today)** Fix `seed-node-registry.unit.test.ts:281,307`: replace the
   350 ms wall-clock wait with an event-driven assertion or `jest.useFakeTimers()`. This is the
   test most likely to fail intermittently on a loaded CI runner.

2. **(High — confirmed leak)** Stop the orphaned `defaultExporter` interval in
   `MetricsExporter.test.ts:120`: add `defaultExporter.stopAutoFlush()` at the end of the test
   or switch to `enableBuffering: false` since the test only inspects `getStats()`.

3. **(High — port collision risk)** Move `HTTPAdapter.test.ts`, `WebSocketAdapter.test.ts`, and
   `cross-adapter-integration.test.ts` from `test/unit/transport/` to
   `test/integration/transport/`, and switch all hardcoded ports to `port: 0`. Also eliminate
   the remaining `done`-callback tests in `HTTPAdapter.test.ts` (H-2, M-3, M-7).

4. **(Medium)** Delete `entity-registry-clean.unit.test.ts` (byte-identical duplicate of
   `entity-registry.unit.test.ts`).

5. **(Medium)** Replace the 150 ms / 600 ms wall-clock waits in `MetricsTracker.test.ts:228`
   and `metrics-system.test.ts:554` with `jest.useFakeTimers()` + `jest.advanceTimersByTime()`.

6. **(Medium)** Move `cluster-lifecycle-e2e.test.ts` and `yaml-seed-configuration.integration
   .test.ts` to their correct tiers.

7. **(Medium)** Fix `checkpoint-recovery.test.ts:8-9`: replace `'./test-data/…'` with
   `path.join(os.tmpdir(), randomUUID(), …)` to prevent parallel-worker collisions.

8. **(Low)** Extract `makeCluster`, `makeRouter`, `makeNode`, and `makeFakeLLMClient` to
   `test/helpers/` and import from there in all nine affected test files.
