# Audit: Cross-cutting Code Quality

Date: 2026-04-23
Scope: src/**/*.ts (≈ 190 files, ~43 k lines)

---

## Executive Summary

628 lint problems (65 errors, 563 warnings). Three structural duplicates add dead weight without adding value. Ten-plus classes exceed 400 lines. A well-designed `EvictionTimer` abstraction already exists but is reimplemented ad-hoc nine more times. Logging discipline is split between `FrameworkLogger`/`defaultLogger` and raw `console.*` calls across ~18 non-CLI files. Config defaults follow two incompatible conventions in the same codebase.

---

## Top 5 Duplicated Patterns

| Pattern | Sites | Suggested extraction |
|---|---|---|
| Per-key `Map<K, NodeJS.Timeout>` with schedule/cancel | 9 (`DistributedLock:29`, `QuorumDistributedLock:47,49`, `ProductionScaleResourceManager:22`, `MessageBatcher:49`, `AutoReclaimPolicy:18`, `UpdateCoalescer:25`, `SharedStateManager:28`, `FailureDetector:40-41`, `DurableQueueManager:31-32`) | Already solved by `gateway/eviction/EvictionTimer`; remaining sites should adopt it |
| Idempotent `if (this._started) return` guard (+ matching stop guard) | 22 classes (representative: `ClusterManager:173`, `ConfigManager:73`, `ServiceRegistry:118`, `EventBus:114`, `ResourceRouter:105`, `BackpressureController:157`, `GossipStrategy:21`, …) | Extract `SingletonLifecycle` helper in `src/common/LifecycleAware.ts` or a base class; `LifecycleAware` interface already exists but provides no implementation |
| Self-origin loop-prevention check `if (meta.publisherNodeId === this.localNodeId) return` | 3 exact copies (`EntityRegistryBootstrapper:121`, `EntityRegistrySyncAdapter:76`, `ResourceRouterSyncAdapter:64`) | Extract one `isSelf(meta, localNodeId)` utility in `src/common/utils.ts` |
| Dual-emit compatibility shim `emitRenamed(oldName, newName, …)` | `MembershipTable` (~12 call-sites) and `ClusterManager` (4 more call-sites, `ClusterManager:144-154`) | Both classes reimplement the same two-line helper; move to a single shared `emitRenamed()` in the base `EventEmitter` subclass |
| Structural duplicate files: `src/transport/GossipMessage.ts` ≅ `src/gossip/transport/GossipMessage.ts`; `src/cluster/lifecycle/*` ≅ `src/cluster/core/lifecycle/*`; `src/messaging/cluster/ClusterCommunication.ts` ≅ `src/cluster/core/communication/ClusterCommunication.ts` | 3 pairs | See Dead Code section |

---

## Dead Code

### Orphaned / unreferenced files

- **`src/transport/GossipMessage.ts`** — complete structural duplicate of `src/gossip/transport/GossipMessage.ts` (identical exports; only differ in relative import path). Zero direct imports outside its own directory. Canonical version is `gossip/transport/GossipMessage.ts` (re-exported by `src/index.ts:65`). Safe to delete.

- **`src/cluster/core/lifecycle/ClusterLifecycle.ts` + `src/cluster/core/lifecycle/types.ts`** — these files are never imported. `ClusterManager` imports from `cluster/lifecycle/ClusterLifecycle` directly (line 23). `cluster/core/index.ts` re-exports the `cluster/lifecycle` version, not the `cluster/core/lifecycle` version. Delete both files and the `src/cluster/core/lifecycle/` directory.

- **`src/cluster/core/communication/ClusterCommunication.ts` + `src/cluster/core/communication/types.ts`** — never imported; `ClusterManager:24` and `cluster/core/index.ts:10` both point at `messaging/cluster/ClusterCommunication`. Delete both files and the `src/cluster/core/communication/` directory.

### Unused imports (representative — 137 total `no-unused-vars` warnings)

High-signal dead imports where the imported symbol appears in zero usages within the file:

| File | Symbol |
|---|---|
| `applications/types.ts:5` | `ResourceTypeDefinition` |
| `cluster/ClusterManager.ts:3` | `MessageType` |
| `cluster/ClusterManager.ts:16` | `DistributionStrategy` |
| `cluster/topology/ClusterTopologyManager.ts:4-5` | `ClusterState`, `LogicalService`, `PerformanceMetrics`, `ClusterHealth`, `ClusterTopology`, `ClusterMetadata` (6 symbols) |
| `cluster/topology/ResourceTopologyManager.ts:3-6` | `AggregatedClusterState`, `ClusterState`, `LogicalService`, `PerformanceMetrics`, `ClusterTopology`, `ClusterMetadata`, `UnifiedMetrics` (7 symbols) |
| `cluster/resources/ResourceRegistry.ts:9-11,19` | `ResourceState`, `ResourceHealth`, `DistributionStrategy`, `ResourceEntityRecord` |
| `cluster/delta-sync/DeltaSync.ts:7-8` | `ClusterState`, `PerformanceMetrics`, `ClusterHealth`, `ClusterTopology`, `ClusterMetadata` |
| `persistence/compaction/{Leveled,SizeTiered,Vacuum}CompactionStrategy.ts` | `checkpointMetrics` (parameter) — appears in 5 files |

### Commented-out `console.log` blocks

7 commented-out `console.log` calls remain in `cluster/entity/WriteAheadLogEntityRegistry.ts` (lines 76, 92, 305, 309, 321, 420) and `cluster/entity/InMemoryEntityRegistry.ts` (line 248). Delete them.

### Constant-condition unreachable branch

- `cluster/locks/DistributedLock.ts:67` — `while (true)` flagged by `no-constant-condition`; this is intentional (spin-retry loop). Suppress with `// eslint-disable-next-line no-constant-condition` on that line.

---

## Lint Warning Breakdown

Total: **628 problems** (65 errors, 563 warnings). The previously cited count of 178 is stale.

| Rule | Count | Severity | Auto-fixable | Signal-or-noise |
|---|---|---|---|---|
| `@typescript-eslint/no-explicit-any` | 317 | warning | No | **Signal** — many are legitimately untyped message payloads but ~50+ are avoidable |
| `@typescript-eslint/no-unused-vars` | 137 | warning | No | **Signal** — reveals dead imports, stub params, and copy-paste leftovers |
| `@typescript-eslint/no-non-null-assertion` | 109 | warning | No | Signal — each `!` needs manual review |
| `@typescript-eslint/no-inferrable-types` | 30 | **error** | **Yes** (`--fix`) | Noise — e.g. `private _isDelivered: boolean = false` |
| `@typescript-eslint/no-empty-function` | 18 | **error** | No (add comment) | Mixed — empty interface methods and stub implementations |
| `no-case-declarations` | 7 | **error** | No (add braces) | Signal — potential scoping bugs in switch statements |
| `prefer-const` | 6 | **error** | **Yes (`--fix`)** | Noise |
| `@typescript-eslint/no-empty-interface` | 2 | **error** | No | Signal |
| `no-constant-condition` | 1 | **error** | No | Signal (suppress intentional `while (true)`) |
| `@typescript-eslint/no-var-requires` | 1 | **error** | No | Signal (`gossip/transport/GossipMessage.ts:260`) |

**Quick win:** `npx eslint 'src/**/*.ts' --fix` eliminates 36 errors (all `no-inferrable-types` + `prefer-const`).

---

## File / Naming Inconsistencies

### Missing barrel `index.ts` files (directories with `.ts` files but no barrel)

High-traffic directories missing an `index.ts`: `src/common/` (6 files), `src/transport/` (8 files), `src/persistence/` (4 files), `src/config/` (2 files), `src/diagnostics/` (2 files), `src/cluster/resources/` (4 files), `src/cluster/topology/` (2 files), `src/cluster/aggregation/`, `src/cluster/reconciliation/`, `src/cluster/membership/`, `src/cluster/observability/`.

Gateway sub-packages all have barrels consistently; top-level infrastructure packages (`transport`, `common`) do not.

### File naming style

The codebase uses **PascalCase exclusively for class files** (`ClusterManager.ts`, `EvictionTimer.ts`) and **camelCase/kebab-case for non-class files** (`types.ts`, `index.ts`, `pipelineExecutor.contract.test.ts`). This is consistent within its own convention. The test file `pipelineExecutor.contract.test.ts` uses camelCase while everything else is PascalCase — minor inconsistency.

---

## Naming Inconsistencies

### `nodeId` vs `localNodeId`

No consistent rule. **Within the `cluster/` package**, nodes representing the current process use `localNodeId` (`ClusterManager:40`, `QuorumDistributedLock:38`, `EntityRegistrySyncAdapter:27`, `ConfigManager:44`, etc.). **Outside `cluster/`** (coordinators, gossip, entity registries) the same field is called `nodeId` (`InMemoryCoordinator:21`, `CrdtEntityRegistry:44`, `WriteAheadLogEntityRegistry:28`). Standardize: use `localNodeId` for the node's own identity everywhere.

### `start`/`stop` vs `isStarted`

Lifecycle methods are consistently `start()`/`stop()` (22+ classes). However the guard field varies: `this._started` (majority), `this.started` (`FailureDetectorBridge:24`, `AutoReclaimPolicy:38`), `this.isStarted` (a `boolean` field in `RangeCoordinator:31` that shadows the interface method name `isStarted(): boolean`). Standardize to `private _started = false`.

### `init`/`close`

Not used in production code — `start`/`stop` is the single convention. Good.

---

## Magic Numbers / Strings

All of these appear as inline literals without a named constant:

| Value | File:line | Context |
|---|---|---|
| `30000` | `ClusterManager:108,122` | drain timeout, gossip interval |
| `5000` | `ClusterManager:119` | join timeout |
| `10000` | `ClusterManager:107` | shutdown timeout |
| `30000` | `cluster/core/communication/ClusterCommunication.ts:33` | heartbeat interval (duplicated from above) |
| `60000` / `1000` | `WriteAheadLogEntityRegistry.ts:42,47` | sync and checkpoint intervals |
| `3000` | `EntityRegistryBootstrapper.ts:70` | response timeout (already named `DEFAULT_RESPONSE_TIMEOUT_MS` — just not for the others) |
| `4 * 1024 * 1024` | `GRPCAdapter.ts:62,63` | max message length (inline arithmetic, not constant) |
| `100` | `EventBus.ts:365` | `keepLastNPerType` default |
| `100` | `HTTPAdapter.ts:48`, `GRPCAdapter.ts:58` | max connections |
| `500` | `AutoReclaimPolicy.ts:27` | jitter ms |
| `300_000` | `DistributedSession.ts:30` | already named `DEFAULT_IDLE_TIMEOUT_MS` — good example to follow |

---

## Long Methods / Classes

### Classes over 400 lines

| Class | File | Lines |
|---|---|---|
| `PipelineExecutor` | `applications/pipeline/PipelineExecutor.ts:130-1144` | 1014 |
| `ClusterTopologyManager` | `cluster/topology/ClusterTopologyManager.ts:208-1015` | 807 |
| `MetricsTracker` | `monitoring/metrics/MetricsTracker.ts:113-848` | 735 |
| `StateAggregator` | `cluster/aggregation/StateAggregator.ts:54-733` | 679 |
| `ObservabilityManager` | `cluster/observability/ObservabilityManager.ts:143-790` | 647 |
| `ConnectionPool` | `connections/ConnectionPool.ts:41-643` | 602 |
| `FailureDetector` | `monitoring/FailureDetector.ts:39-624` | 585 |
| `DurableQueueManager` | `gateway/queue/DurableQueueManager.ts:21-600` | 579 |
| `MetricsExporter` | `monitoring/metrics/MetricsExporter.ts:72-641` | 569 |
| `ClusterCommunication` | `messaging/cluster/ClusterCommunication.ts:18-564` | 546 |

### Methods over 80 lines

| Method | File | Lines |
|---|---|---|
| `exportToPrometheus()` | `monitoring/metrics/MetricsExporter.ts:222-327` | 105 |
| `rebuildFromWAL()` | `gateway/queue/DurableQueueManager.ts:461-563` | 102 |
| `createResource()` | `applications/pipeline/PipelineModule.ts:242-339` | 97 |
| `compact()` | `messaging/EventBus.ts:360-456` | 96 |
| `handleRemoteMessage()` | `gateway/channel/ChannelManager.ts:263-352` | 89 |
| `executeCompaction()` | `persistence/compaction/TimeBasedCompactionStrategy.ts:142-230` | 88 |
| `buildDashboard()` | `cluster/observability/ObservabilityManager.ts:448-532` | 84 |
| `tryAcquire()` | `cluster/locks/QuorumDistributedLock.ts:94-177` | 83 |
| `_handleRequest()` | `routing/ForwardingServer.ts:100-183` | 83 |
| `verifyMessage()` | `transport/MessageAuth.ts:148-230` | 82 |

---

## Logging Discipline

`FrameworkLogger` / `defaultLogger` exists in `src/common/logger.ts` but is used by only ~51 call-sites. Raw `console.*` is used by ~100 call-sites outside CLI and tests. Worst offenders:

| File | Raw `console.*` calls | Notes |
|---|---|---|
| `gossip/GossipCoordinator.ts` | 19 | All `console.log` with emoji, no suppression in tests |
| `monitoring/FailureDetector.ts` | 13 | Mix of `console.log` and `console.warn` |
| `common/Node.ts` | 13 | `console.log` in message handlers |
| `cluster/entity/WriteAheadLogEntityRegistry.ts` | 9 | `console.error` + 7 commented-out `console.log` |
| `identity/KeyManager.ts` | 8 | `console.log` for signing events |
| `transport/adapters/ClientWebSocketAdapter.ts` | 7 | Mix; no test-mode guard |

`FrameworkLogger` suppresses output in test mode automatically. `GossipCoordinator` (the worst offender) uses none of it, causing noisy test output.

**Log level discipline:** `console.error` is used for non-fatal recoverable errors (e.g. `[EntityRegistry] Failed to apply remote update`) where `logger.warn` would be more appropriate. No structured log levels (`debug`/`info`/`warn`/`error`) are consistently enforced.

---

## Configuration Patterns

Two conflicting conventions exist side by side:

**Pattern A — spread defaults object** (used in `cluster/` and `persistence/` subsystems):
```ts
const DEFAULTS = { gossipInterval: 1000, joinTimeout: 5000, … };
this.config = { ...DEFAULTS, ...config };
```
Found in: `StateAggregator`, `ClusterLifecycle`, `StateDelta`, `StateFingerprint`, `ClusterCommunication (core)`.

**Pattern B — inline `?? literal`** (used in `transport/`, `gateway/`, `frontdoor/`):
```ts
timeout: config.timeout ?? 5000,
maxConnections: config.maxConnections ?? 100,
```
Found in: `GRPCAdapter`, `HTTPAdapter`, `TCPAdapter`, `ServiceRegistry`, `DiagnosticTool`.

Pattern A is more testable and self-documenting. Pattern B scatters magic numbers across constructors. Mixed usage means the effective defaults are spread across dozens of files. Recommend: adopt Pattern A with a named `DEFAULTS` constant for all new primitives.

---

## Action List (Prioritized)

1. **Delete three dead file pairs** — `src/transport/GossipMessage.ts`, `src/cluster/core/lifecycle/{ClusterLifecycle,types}.ts`, `src/cluster/core/communication/{ClusterCommunication,types}.ts`. Zero risk, removes ~350 lines of confusing duplication. Verify `src/cluster/core/index.ts` re-exports still resolve correctly after deletion.

2. **Run `npx eslint 'src/**/*.ts' --fix`** — eliminates 36 errors automatically (`no-inferrable-types` × 30, `prefer-const` × 6). Commit as a standalone chore with no logic changes.

3. **Migrate the 9 ad-hoc per-key timer maps to `EvictionTimer`** — `DistributedLock:29`, `QuorumDistributedLock:47,49`, `MessageBatcher:49`, `AutoReclaimPolicy:18`, `UpdateCoalescer:25`, `SharedStateManager:28`, `FailureDetector:40-41`, `DurableQueueManager:31-32`. Each site has ~8-15 lines of identical timer management; `EvictionTimer` already covers them. Saves ~120 lines and consolidates all `.unref()` discipline in one place.

4. **Replace bare `console.*` with `defaultLogger` in the top 5 files** — `GossipCoordinator`, `FailureDetector`, `Node`, `WriteAheadLogEntityRegistry`, `KeyManager`. Eliminates noisy test output and brings them under the existing test-suppression mechanism.

5. **Consolidate `nodeId` → `localNodeId` in the 5 out-of-cluster classes** (`InMemoryCoordinator`, `RangeCoordinator`, `CrdtEntityRegistry`, `InMemoryEntityRegistry`, `WriteAheadLogEntityRegistry`). One grep-replace per file; makes the "whose node am I?" field unambiguous across the codebase.
