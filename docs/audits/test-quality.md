# Audit: Test Suite Quality

Date: 2026-04-23
Scope: `test/unit/` (111 files), `test/integration/` (38 files), `test/e2e/` (18 files), `examples/*/run.ts` (2 files)
Auditor: Claude (Sonnet 4.6), read-only pass

---

## Executive Summary

The suite is large (167 test files) and structurally sound for the core cluster primitives. However, significant quality debt accumulates across four areas:

1. **Pervasive real-time sleeps** — 47 in unit tests alone; timer-based assertions should use `jest.useFakeTimers()`.
2. **Coverage gaps** — 68 source files carry exported classes or functions with zero corresponding test file; the entire gateway layer (ChannelManager, PresenceManager, MessageRouter, DurableQueueManager) is untested.
3. **Misclassified tests** — transport adapter unit tests (`HTTPAdapter`, `TCPAdapter`, `WebSocketAdapter`) bind real OS ports; a lifecycle "e2e" test lives under `test/unit/`; an integration-named file lives under `test/unit/config/`.
4. **Placeholder system tests** — five files under `test/system/` contain only `// TODO:` bodies that register as passes.

Severity breakdown: **Critical: 4 | High: 9 | Medium: 8 | Low: 5**

---

## Findings

### CRITICAL

#### C1 — Transport adapter unit tests bind real OS ports
**Files:**
- `test/unit/transport/HTTPAdapter.test.ts:59–95` — calls `await adapter.start()` ~10 times, each binding port 9001
- `test/unit/transport/TCPAdapter.test.ts:31` — calls `await adapter.start()`, binding port 9000
- `test/unit/transport/WebSocketAdapter.test.ts:60–251` — calls `await adapter.start()` ~10 times

These are labeled unit tests but spin up real TCP/HTTP/WebSocket servers. Parallel test runs collide on the same hardcoded port numbers. The HTTP and WebSocket tests mock `CircuitBreaker`/`RetryManager` but leave the server binding real. Move to `test/integration/transport/` or introduce a port allocator and explicit mock-server strategy.

#### C2 — Five `test/system/` files are all-TODO shells that pass silently
**Files (all bodies are `// TODO:`):**
- `test/system/chaos/chaos-testing.test.ts:20–32` — 7× `it.todo()`; setup/teardown stubs
- `test/system/metrics/metrics-collection.test.ts:19–53` — 8 tests, all `// TODO:` bodies
- `test/system/state/state-persistence.test.ts:19–45` — 6 tests, all `// TODO:`
- `test/system/transport/transport-layer.test.ts` — similar pattern

All these `it()` bodies are empty; Jest reports them as passed. This inflates pass counts while providing zero coverage assurance. Either implement or convert to `it.todo()` so they are visibly pending.

#### C3 — `checkpoint-recovery.test.ts` writes to relative CWD paths
`test/unit/cluster/checkpoint-recovery.test.ts:8–9`:
```
const testDir = './test-data/checkpoints';
const walDir  = './test-data/wal';
```
Relative paths resolve to wherever Jest is invoked from. Concurrent test workers or a CI run from a different directory will share or corrupt state. Use `os.tmpdir()` + `randomUUID()` (the pattern already used correctly in `WALFile.test.ts` and `CheckpointWriter.test.ts`).

#### C4 — `EntityRegistryFactory.test.ts` uses fixed `/tmp` paths
`test/unit/cluster/entity/EntityRegistryFactory.test.ts:74,87`:
```
filePath: '/tmp/test-factory.wal'
filePath: '/tmp/test-factory-convenience.wal'
```
These are shared across all parallel test workers and are not cleaned up between runs. Successive runs may read stale data; parallel CI runs collide.

---

### HIGH

#### H1 — Pervasive arbitrary sleeps in unit tests (47 instances)
Unit tests should not sleep. The following files contain real-time waits that make them slow and flaky under CPU contention:

| File | Sleeps | Longest delay |
|---|---|---|
| `test/unit/observability/metrics-system.test.ts:242,310,425,550,554` | 5 | 600 ms |
| `test/unit/metrics/MetricsTracker.test.ts:213,228,553,672` | 4 | 350 ms |
| `test/unit/metrics/MetricsExporter.test.ts:331,350,628` | 3 | 200 ms |
| `test/unit/cluster/seeding/seed-node-registry.unit.test.ts:281,307` | 2 | 350 ms |
| `test/unit/persistence/snapshot/WALSnapshotVersionStore.test.ts:38–318` | 14 | 10 ms |
| `test/unit/applications/pipeline/EventRenameDeprecation.test.ts:270–419` | 5 | 100 ms |
| `test/unit/cluster/entity-registry.unit.test.ts:50` | 1 | 10 ms |
| `test/unit/cluster/entity-registry-clean.unit.test.ts:50` | 1 | 10 ms |
| `test/unit/transport/InMemoryAdapter.test.ts:89,133,248` | 3 | 50 ms |
| `test/unit/transport/WebSocketAdapter.test.ts:62` | 1 | 10 ms |
| `test/unit/cluster/checkpoint-recovery.test.ts:157` | 1 | 100 ms |

**Recommended fix:** Switch to `jest.useFakeTimers()` + `jest.advanceTimersByTimeAsync()` (already used correctly in `test/unit/cluster/locks/` and `test/unit/gateway/eviction/EvictionTimer.test.ts`).

#### H2 — Integration gossip tests use 13 real-time sleeps totalling ~2.4 s
`test/integration/gossip/membership-sync.integration.test.ts:22,48,78,109,131,144,168,178,206,250,271` — 13 sleeps ranging 100–200 ms. The suite also uses a file-level `jest.setTimeout(20000)`, indicating the test author knows this is borderline. Introduce a `waitForCondition()` poll helper (one exists in `test/e2e/helpers/clusterTestHelpers.ts:20` — import it rather than sleeping).

#### H3 — `rolling-restart.integration.test.ts` sleeps 500 ms × 2 = 1 s minimum
`test/integration/cluster/rolling-restart.integration.test.ts:149,155` — two 500 ms waits with `jest.setTimeout(30000)`. This is intentional for restart stabilisation but should be documented, and a `waitForCondition` would tighten it.

#### H4 — Private field mutation in MetricsTracker tests breaks encapsulation
`test/unit/metrics/MetricsTracker.test.ts:498,524,528,533,536,585,626`:
```ts
tracker['alerts'].push({ ... })   // line 498
tracker['alerts'] = [...]          // line 585
tracker['isCollecting']            // line 524
tracker['collectionTimer']         // line 533
```
Tests that mutate or read private fields couple to implementation details. Any rename or refactor silently breaks coverage. Expose test-only accessors or use observable side-effects.

#### H5 — `Date.now()` used as ordering anchor in `delta-sync.test.ts`
`test/unit/cluster/delta-sync.test.ts:57,149,164,166,202,233,269,296,315,342,398,414,416,483,485,523,538,540` — ~18 calls to `Date.now()` as timestamp seeds. Tests that assert ordering of delta entries will produce different relative timestamps depending on execution speed. Use a monotonic counter or fake clock.

#### H6 — Duplicate `entity-registry` test files (identical line counts)
`test/unit/cluster/entity-registry.unit.test.ts` and `test/unit/cluster/entity-registry-clean.unit.test.ts` are both 307 lines with only minor header differences. Running both doubles execution time without adding coverage. One should be removed.

#### H7 — Misclassified lifecycle e2e test resides in `test/unit/`
`test/unit/cluster/lifecycle/cluster-lifecycle-e2e.test.ts` — the file name, the header comment ("End-to-End Cluster Lifecycle Integration Test"), and 20 usages of real `InMemoryAdapter` / `Node` instances all indicate this is an integration test. It carries `jest.setTimeout(15000)`. Move to `test/integration/cluster/`.

#### H8 — `yaml-seed-configuration.integration.test.ts` lives under `test/unit/`
`test/unit/config/yaml-seed-configuration.integration.test.ts` — the `.integration.` infix in the filename conflicts with its location under `test/unit/`. If it relies on real filesystem fixture files it belongs in `test/integration/config/`.

#### H9 — `compaction-cluster-bridge.integration.test.ts` is a pure unit test
`test/integration/persistence/compaction-cluster-bridge.integration.test.ts:10–82` — the entire test uses `jest.fn()` mocks for `CompactionCoordinator` and an in-memory `EventEmitter` for the cluster. Nothing real is exercised. Move to `test/unit/persistence/compaction/`.

---

### MEDIUM

#### M1 — `it.todo()` tests: 7 registered, all in chaos suite
`test/system/chaos/chaos-testing.test.ts:20–32` — 7 `it.todo()` calls covering network failures, Byzantine faults, and cluster health recovery. These are the highest-value scenarios for a distributed system and are entirely unimplemented.

#### M2 — Integration gossip propagation test sleeps 200 ms × 10
`test/integration/gossip/gossip-propagation.integration.test.ts` — similar pattern to membership-sync; all delays are real-time with no `waitForCondition` guard.

#### M3 — `unseeded Math.random()` in examples
`examples/cluster-collab/run.ts:182,186,187` and `examples/live-video/run.ts:136,139,271` use `Math.random()` for workload generation. As smoke scripts these are intentional, but they cannot be replayed deterministically for regression comparison.

#### M4 — Four tmpDir helpers reimplemented instead of shared
Identical `tmpPath()` / `tmpDir()` / `tmpFilePath()` functions appear in:
- `test/unit/persistence/checkpoint/CheckpointWriter.test.ts:8`
- `test/unit/persistence/wal/WALFile.test.ts:9`
- `test/unit/persistence/snapshot/WALSnapshotVersionStore.test.ts:8`
- `test/integration/persistence/wal-recovery.integration.test.ts:18`

Extract to `test/helpers/fsHelpers.ts` alongside the existing `mockTransport.ts` and `spyLogger.ts`.

#### M5 — Multiple inline cluster stub objects (24 across unit tests)
Rather than using `ClusterSimulator` or `create-test-cluster.ts`, 24 unit tests build ad-hoc `{ membership: {...}, transport: {...} }` objects inline. Subtle differences in stub shape cause type drift. Centralise in `test/helpers/clusterStubs.ts`.

#### M6 — `setInterval` in e2e distributed chat not cleaned up on error path
`test/e2e/cluster/distributed-chat-room-e2e.test.ts:145` — the gossip interval is started inside a helper class; `clearInterval` at line 381 only fires if `stop()` is called. If a test throws before `stop()`, the interval leaks into the next test.

#### M7 — `harness/production-chat-harness.ts` interval cleanup only in happy path
`test/harnesses/production-chat-harness.ts:585,528` — `heartbeatInterval` is set on client but `clearInterval` only fires inside `disconnect()`. Tests that fail mid-run leave heartbeat timers running.

#### M8 — Brittle exact-count assertions on internal state
`test/unit/metrics/MetricsTracker.test.ts:154`: `expect(tracker['connectionPools']).toHaveLength(3)` — the count 3 includes an "initial" pool implicit from construction. Any constructor change silently breaks this. Prefer `toBeGreaterThanOrEqual(1)` or assert the specific pools added during the test.

---

### LOW

#### L1 — `jest.setTimeout` scattered inconsistently across test files
18 files set per-file timeouts ranging from 10 000 ms to 30 000 ms. Jest best practice is a single global default in `jest.config.*`. Individual overrides should be per-test (`test('...', handler, 30_000)`), not file-level, so slow tests are self-documenting.

#### L2 — `test/unit/state-reconciler.test.ts` duplicates `test/unit/state/state-reconciler.test.ts`
These are different suites (basic vs. integration) testing the same class. The root-level file is misplaced — it should be under `test/unit/state/` or merged with the existing file.

#### L3 — No tests for `ConsistentHashRing`, `ClusterCommunication`, `LLMClient`
`src/routing/ConsistentHashRing.ts` — used in e2e tests as a black box but never directly unit-tested. Ring boundary conditions (virtual-node distribution, removal, collision) are high-value edge cases.

`src/messaging/cluster/ClusterCommunication.ts` and `src/applications/pipeline/LLMClient.ts` — zero tests of any kind.

#### L4 — Gateway layer has zero direct tests
`src/gateway/channel/ChannelManager.ts`, `src/gateway/presence/PresenceManager.ts`, `src/gateway/queue/DurableQueueManager.ts`, and `src/gateway/routing/MessageRouter.ts` — all four are untested. These are public-facing primitives.

#### L5 — `GRPCAdapter` is production source with zero tests
`src/transport/adapters/GRPCAdapter.ts` — real `@grpc/grpc-js` implementation with no unit or integration test. The adapter was removed and re-added per commit history, suggesting instability. At minimum, constructor and lifecycle (`start`/`stop`) should be covered.

---

## Recurring Patterns

1. **Sleep-based synchronisation** — 132 total `await new Promise(r => setTimeout(r, N))` calls across unit and integration tiers. The codebase has the right pattern (`jest.useFakeTimers`) in `test/unit/cluster/locks/` but it is not consistently applied.

2. **Stale/duplicate test files** — At least three pairs of near-identical files exist: `entity-registry` × 2, `state-reconciler` × 2, and the two `production-chat-harness` variants. These inflate the file count without proportionally increasing coverage.

3. **Misclassified tiers** — Real network I/O in `test/unit/`, pure mocks in `test/integration/`. The tier boundaries are enforced only by directory name, not by tooling.

4. **Shared helpers not used** — `test/e2e/helpers/clusterTestHelpers.ts` provides `waitForClusterConvergence`, `cleanupClusterNodes`, and `createTestClusterNode`. Integration tests in `test/integration/cluster/` re-implement similar waits inline.

5. **System tests as false positives** — `test/system/` contains 5 files that register no actual assertions; Jest counts them as passing.

---

## Prioritised Action List

### Priority 1 — Stop the false-green problem (1–2 days)
1. Convert all `it()` bodies in `test/system/` that are empty `// TODO:` blocks to `it.todo()`. This makes Jest report them as pending rather than passing.
2. Delete or merge `test/unit/cluster/entity-registry.unit.test.ts` (keep `entity-registry-clean.unit.test.ts`). Delete `test/unit/state-reconciler.test.ts` (keep `test/unit/state/state-reconciler.test.ts`).

### Priority 2 — Fix the port-collision unit tests (1 day)
3. Move `test/unit/transport/HTTPAdapter.test.ts`, `TCPAdapter.test.ts`, and `WebSocketAdapter.test.ts` to `test/integration/transport/` (or mock the underlying `net.createServer` / `http.createServer`). These block parallel CI runs.
4. Fix `checkpoint-recovery.test.ts:8–9` to use `os.tmpdir() + randomUUID()`. Fix `EntityRegistryFactory.test.ts:74,87` likewise.

### Priority 3 — Replace real-time sleeps with fake timers (3–5 days)
5. Apply `jest.useFakeTimers()` to `metrics-system.test.ts`, `MetricsTracker.test.ts`, `MetricsExporter.test.ts`, `seeding/seed-node-registry.unit.test.ts`, and the pipeline `EventRenameDeprecation` test. Pattern to follow: `test/unit/gateway/eviction/EvictionTimer.test.ts`.
6. Replace sleep loops in `test/integration/gossip/membership-sync.integration.test.ts` with `waitForClusterConvergence()` from `test/e2e/helpers/clusterTestHelpers.ts`.

### Priority 4 — Coverage: gateway layer + ConsistentHashRing (ongoing)
7. Add unit tests for `ChannelManager`, `PresenceManager`, `DurableQueueManager`, `MessageRouter`.
8. Add a direct unit test for `ConsistentHashRing` covering node addition, removal, and virtual-node distribution.
9. Add lifecycle tests for `GRPCAdapter`.

### Priority 5 — Structural cleanup (1 day)
10. Extract `tmpPath()`/`tmpDir()` helpers into `test/helpers/fsHelpers.ts`.
11. Move `cluster-lifecycle-e2e.test.ts` and `yaml-seed-configuration.integration.test.ts` from `test/unit/` to their correct tiers.
12. Move `compaction-cluster-bridge.integration.test.ts` from `test/integration/` to `test/unit/`.
