# Audit: Type Safety

Date: 2026-04-23
Scope: `src/**/*.ts`

---

## Executive Summary

| Category | Count |
|---|---|
| `any` usage (all forms) | ~344 (grep occurrences across all files) |
| — explicit `: any` annotations | 186 |
| — `as any` casts | 25 |
| — `as unknown as X` escape hatches | 5 |
| — `null as any` sentinel assignments | 2 |
| `// @ts-ignore` | 0 |
| `// @ts-expect-error` | 0 |
| `// eslint-disable` touching type rules | 9 |
| `catch (e)` without `: unknown` annotation | 167 (all catch blocks; 0 use `: unknown`, 1 uses `: any`) |
| Non-null assertions on `.get()` / `.find()` | 31 |
| `throw new Error()` outside `src/common/errors.ts` | 193 |
| `switch` statements without `default: never` exhaustiveness | 44 (0 use `never`; all 44 checked switches have no exhaustiveness guard) |

`noUncheckedIndexedAccess` is **not** enabled in `tsconfig.json` — the only strict flag is `"strict": true`.

---

## High-Severity Findings

### H1 — `null as any` bypasses null-safety on two always-present subsystems
**Files:** `src/common/Node.ts:159-160`

```ts
this.metrics = config.enableMetrics !== false ? new MetricsTracker() : null as any;
this.chaos   = config.enableChaos   !== false ? new ChaosInjector()  : null as any;
```

`this.metrics` and `this.chaos` are typed as `MetricsTracker` and `ChaosInjector` respectively, so `null` would be a type error. The cast silences the compiler and causes every downstream call-site (e.g., `this.metrics.collect()`) to crash at runtime when the feature is disabled. Fix: type the fields as `MetricsTracker | null` and guard call-sites with `?.`.

---

### H2 — `as any` cast discards cluster message type on hot path
**File:** `src/messaging/cluster/ClusterCommunication.ts:167`

```ts
const clusterMessage = message.data as any;
```

`message.data` is typed `any` from `src/types.ts:Message.data: any` (see M1 below). Casting it again to `any` in the receive handler means the subsequent `switch (clusterMessage.type)` on `'JOIN' | 'GOSSIP'` is completely unguarded. A malformed inbound payload silently routes to the wrong branch. This is the network boundary — the highest-risk location for unvalidated `any`.

---

### H3 — `switch (clusterMessage.type)` has no `default` case
**File:** `src/messaging/cluster/ClusterCommunication.ts:195-202`

```ts
switch (clusterMessage.type) {
  case 'JOIN':   ...
  case 'GOSSIP': ...
  // no default
}
```

New message types added to the enum silently pass without being handled. None of the 44 `switch` statements in the codebase use a `default: exhaustiveCheck(x)` or `default: never` pattern.

---

### H4 — Untyped catch parameter then property access without guard
**Files:** `src/transport/RetryManager.ts:289-290`, `src/transport/adapters/WebSocketAdapter.ts:357`, `src/transport/adapters/UDPAdapter.ts:401,406,411`, `src/transport/adapters/TCPAdapter.ts:333`

```ts
// RetryManager.ts — catch (error) without : unknown
if (error.message.includes('400') || error.message.includes('401') …)
```

In strict mode, `catch (e)` binds `e` as `unknown`. TypeScript should reject `.message` access on `unknown` but the project does not annotate the parameter, relying on inference. In `RetryManager` the `error` variable is used as though it were `Error` without an `instanceof` guard. Any non-`Error` rejection (`string`, plain object) throws a second runtime TypeError here — on the retry hot path.

---

### H5 — `MetricsTracker` registers all dependency types as `any`
**File:** `src/monitoring/metrics/MetricsTracker.ts:121-166`

```ts
private diagnosticTool?: any;
private clusterIntrospection?: any;
private failureDetector?: any;
private connectionManager?: any;
private connectionPools: any[] = [];
```

Five fields and their corresponding `register*()` methods accept and store `any`. All metric collection pipelines (`collectClusterMetrics`, `collectConnectionMetrics`, etc.) then call arbitrary methods on these fields with no type safety. This is the highest `any` density in the codebase (21 `any` occurrences).

---

### H6 — `PipelineExecutor.dispatchNode` switch has no `default` and can return `undefined`
**File:** `src/applications/pipeline/PipelineExecutor.ts:600-618`

```ts
switch (node.data.type) {
  case 'trigger': …
  case 'llm':     …
  …
  case 'approval': …
  // no default — implicit return of undefined when type is unrecognised
}
```

The function return type is `Promise<StepOutcome>` but with an unrecognised `type` value, no `return` is reached and the function resolves to `undefined`. Callers destructure `{ status }` from the result, so this causes a runtime crash with an unintelligible message. A `default: throw new UnroutableResourceError(node.id)` (or equivalent `CoreError`) would surface this immediately.

---

## Medium-Severity Findings

### M1 — Root `Message.data: any` and `GossipMessageData.payload: any` in public types
**File:** `src/types.ts:35,89`

These are the two highest-traffic types in the entire network layer. Marking the payload `any` propagates the erasure to every consumer. A generic `Message<T = unknown>` with `data: T` would let callers narrow safely at the boundary.

### M2 — `IWriteAheadLog` and `IBroadcastBuffer` public interfaces use `any`
**File:** `src/types.ts:119-128`

```ts
interface IWriteAheadLog   { append(entry: any): void; readAll(): any[]; }
interface IBroadcastBuffer { add(message: any): void;  drain(): any[];   }
```

These are extended by in-memory and on-disk implementations and used broadly in persistence. Generics (`IWriteAheadLog<T>`) would cost little and would prevent silent mismatches between WAL write and read sites.

### M3 — `StateReconciler` resolution pipeline is entirely `any`-typed
**File:** `src/cluster/reconciliation/StateReconciler.ts:38,53,57,66,67,180,288,324,381,433`

`ResolutionConfig.customResolvers`, `ResolutionResult.resolvedValue`, `ResolutionPreview.currentValue/proposedValue`, and the resolver function signature `(values: Map<string, any>, metadata?: any) => any` all use `any`. The reconciler sits at the conflict-resolution hot path. Introducing `unknown` here would expose real unsafe accesses with no runtime cost.

### M4 — `ObservabilityManager` internal analytics methods return `any`
**File:** `src/cluster/observability/ObservabilityManager.ts:569,703,737,765`

```ts
private calculateAggregatedMetrics(topology: ResourceClusterTopology): any
private calculateTrends(historical: ResourceClusterTopology[]): any
private generatePredictions(trends: any, …): any
private detectTrendAlerts(trends: any, …): any[]
```

The four private methods form a chain: `any` from `calculateTrends` flows into `generatePredictions` which returns `any` into the public forecast API. Three `as any` casts also appear at call-sites (`ObservabilityManager.ts:605,618,636`) for `timeHorizon` — suggesting the enum was extended without updating the helper types.

### M5 — `GossipMessage.data: any` duplicated in two separate files
**Files:** `src/transport/GossipMessage.ts:38`, `src/gossip/transport/GossipMessage.ts:38`

Both files are near-identical and both carry `data: any`. The duplication means a future tightening of one will silently leave the other broken. This also affects the `toJSON(): any`, `fromJSON(json: any)`, and all factory methods (`heartbeat`, `join`, `data`, `broadcast`) in both files.

### M6 — `GRPCAdapter` gRPC handler signatures are fully `any`
**File:** `src/transport/adapters/GRPCAdapter.ts:265,298,301,329,335`

```ts
private handleSendMessage(call: any, callback: any): void
private handleStreamMessages(call: any): void
private handleHealthCheck(call: any, callback: any): void
```

The gRPC library ships `@grpc/grpc-js` with full TypeScript definitions. These should use `grpc.ServerUnaryCall`, `grpc.ServerReadableStream`, and `grpc.sendUnaryData` types.

### M7 — `as unknown as Record<string, unknown>` in WAL snapshot store
**File:** `src/persistence/snapshot/WALSnapshotVersionStore.ts:119,196,282`

The triple cast `meta as unknown as Record<string, unknown>` appears three times. This is structural lying — `meta` is likely already `Record<string, unknown>` or a narrower type. The intermediate `unknown` step is the correct escape-hatch pattern, but the source type should be verified so the cast can be replaced with a proper narrowing function.

### M8 — `Session.get(key): any` and `Session.set(key, value: any)` erase session state types
**File:** `src/connections/Session.ts:29,33`

The session store API accepts and returns `any`. Any typo in a key name or shape mismatch between write and read sites is invisible to TypeScript. A `Session<T extends Record<string, unknown>>` generic would fix this with no breaking change to existing callers that don't provide a type argument.

### M9 — `ResourceRegistry` config escape hatch
**File:** `src/cluster/resources/ResourceRegistry.ts:30`

```ts
entityRegistryConfig?: any;
```

This optional config field is passed through to the entity registry constructor. Typing it as `EntityRegistryConfig | undefined` (or a union of the known config shapes) would prevent misconfigured registry instantiation.

### M10 — `cli/config.ts` uses `as any` to write unknown keys
**File:** `src/cli/config.ts:181`

```ts
(result as any)[key] = value;
```

`result` has a concrete type but an unrecognised config key is being written through `any`. The correct fix is an `if (key in result)` guard or a `Partial<CliConfig>` intermediate.

---

## Low-Severity Findings

### L1 — 167 untyped catch parameters (aggregate)

All `catch (error)`, `catch (err)`, `catch (e)` throughout `src/**/*.ts` omit the `: unknown` annotation required by `useUnknownInCatchVariables` (which is implied by `"strict": true` in TypeScript ≥ 4.4). In the majority of cases the body already guards with `instanceof Error` or `String(error)`, so fixing them is mechanical: add `: unknown` to the catch variable. The one outlier (`start.ts:27` uses `: any`) is worse and should be addressed first.

### L2 — `throw new Error()` at 193 sites outside `src/common/errors.ts`

`CoreError` and its subclasses (`NotStartedError`, `AlreadyStartedError`, `ConflictError`, `TimeoutError`, etc.) exist but are only used at a small fraction of throw sites. High-value candidates for migration:
- `src/cluster/entity/InMemoryEntityRegistry.ts` — ownership and existence errors map directly to `CoreError` subclasses.
- `src/cluster/core/communication/ClusterCommunication.ts` — six `throw new Error('requires context')` sites map to `NotStartedError`.
- `src/cluster/resources/ResourceRegistry.ts` — eight `throw new Error('not running')` / `'not found'` sites.
- `src/cluster/core/lifecycle/ClusterLifecycle.ts` and `src/cluster/lifecycle/ClusterLifecycle.ts` — near-identical duplication of five throws each.

### L3 — `MetricsExporter.getStats(): any` (aggregate)
**File:** `src/monitoring/metrics/MetricsExporter.ts:598`

All other `getStats()` methods in the codebase return explicit structural types. This one returns `any`, breaking consistency and making consumer type narrowing impossible.

### L4 — `eslint-disable` on type rules without explanation (aggregate)

Nine `eslint-disable` directives suppress type-related rules across the codebase. The two in `src/gateway/pubsub/SignedPubSubManager.ts:162,168` disable `@typescript-eslint/no-explicit-any` on the `on`/`off` event emitter overloads — these should use `(...args: unknown[])` instead.

### L5 — `ConnectionPool.getPoolConnectionId` uses `as any` to read `.id`
**File:** `src/connections/ConnectionPool.ts:507`

```ts
return (connection as any).id || `conn-${Date.now()}-…`;
```

`Connection` has an `.id` property — this cast exists because the method receives a `Connection` but the property isn't visible at the type level. The fix is a trivial interface update or direct access through the correct typed property.

### L6 — `noUncheckedIndexedAccess` not enabled

Dynamic index expressions like `obj[key]` and `sorted[key]` (e.g., `StateFingerprint.ts:280`) return the element type without `| undefined`. Enabling `noUncheckedIndexedAccess` in `tsconfig.json` would surface all such accesses with no code changes needed elsewhere.

---

## Recurring Patterns

**Lazy `any` as a type placeholder.** The dominant pattern is `any` used as a structural placeholder for "shape not yet defined" — especially in `Record<string, any>`, resolver function signatures, and analytics return types. Most of these were never intended to be permanent but accumulated over time. The reconciler, observability manager, and metrics tracker are the three worst offenders. Almost none of these require an untyped library boundary — they could all be `unknown` or a concrete interface with modest effort.

**Boundary types not migrated to generics.** `Message`, `GossipMessageData`, `IWriteAheadLog`, and `IBroadcastBuffer` form the architectural data-flow spine. All carry `any` in their payload positions. Because every subsystem imports from this spine, fixing the root interfaces with a generic parameter would allow a whole class of downstream `any` annotations to be removed mechanically. This is the single highest-leverage change in the codebase.

**Error handling discipline is inconsistent.** Two thirds of catch blocks guard with `instanceof Error` or `String(error)` (good practice), but none annotate the catch variable `: unknown` (required by strict mode semantics since TS 4.4). The `CoreError` hierarchy is well-designed but adoption is sparse — only 3 files use it, while 193 throw sites still use the base `Error` class.

**No exhaustiveness enforcement anywhere.** The codebase has 44 switches on string discriminants (`type`, `strategy`, `action`, `operation`). None use a `never` exhaustiveness helper. This is particularly risky in `ClusterCommunication.ts` where new message types would silently fall through, and in `PipelineExecutor.ts` where falling through returns `undefined` as `Promise<StepOutcome>`.

---

## Files with the Densest Violations

| Rank | File | `any`/`as any`/`as unknown as` count |
|---|---|---|
| 1 | `src/monitoring/metrics/MetricsTracker.ts` | 21 |
| 2 | `src/cluster/observability/ObservabilityManager.ts` | 14 |
| 3 | `src/cluster/reconciliation/StateReconciler.ts` | 10 |
| 4 | `src/transport/adapters/GRPCAdapter.ts` | 9 |
| 5 | `src/transport/GossipMessage.ts` (and its duplicate `src/gossip/transport/GossipMessage.ts`) | 9 each |

`src/types.ts` (7 violations) and `src/connections/Connection.ts` (8 violations) are honorary mentions: they are imported by nearly every other file, so their `any` pollution multiplies across the entire codebase.

---

## Action List (Prioritized)

1. **[Critical] Generic-ize `Message<T>`, `GossipMessageData<T>`, `IWriteAheadLog<T>`, `IBroadcastBuffer<T>` in `src/types.ts`.** This single change removes the root source of `any` propagation and makes downstream narrowing mechanically possible. Pair with a runtime schema validation (e.g., `zod`) at the network ingress point in `ClusterCommunication.ts`.

2. **[Critical] Fix `null as any` in `Node.ts:159-160`.** Add `| null` to the `metrics` and `chaos` field types and add optional-chaining at call-sites. This is a real crash waiting to happen when either feature is disabled.

3. **[High] Add `: unknown` to all 167 catch parameters.** Pure mechanical change; no logic modification needed. Run `sed` or a codemod across the repo. Surfaces the handful of sites (like `RetryManager.ts:289`) that actually rely on implicit `any` for property access — those then become targeted M-severity fixes.

4. **[High] Add `default: exhaustiveCheck(x)` to switches on `ClusterCommunication.ts`, `PipelineExecutor.ts`, and `WriteAheadLogEntityRegistry.ts`.** Introduce a one-liner `function exhaustiveCheck(x: never): never { throw new Error(\`Unhandled case: \${x}\`) }` in `src/common/errors.ts` and wire the highest-risk switches first.

5. **[Medium] Replace `any` in `MetricsTracker` dependency fields with concrete interfaces.** Extract the subset of methods each field calls and create `IDiagnosticTool`, `IClusterIntrospection`, etc. interfaces. This is already structurally possible — the concrete classes exist — and removes the highest-density `any` file.

6. **[Medium] Migrate `NotStartedError` / `AlreadyStartedError` throws** to the existing `CoreError` subclasses in `ClusterCommunication`, `ClusterLifecycle` (both copies), `ResourceRegistry`, and `EntityRegistry`. These are the easiest wins in the unmigrated-throw bucket (L2) and would eliminate ~40 raw `Error` throws.

7. **[Medium] Replace GRPCAdapter `any` handler parameters** with `@grpc/grpc-js` typed call objects. Library types are already installed as a dependency.

8. **[Low] Enable `noUncheckedIndexedAccess` in `tsconfig.json`** and fix the resulting errors (expected to be small). This closes the class of dynamic-index bugs globally.
