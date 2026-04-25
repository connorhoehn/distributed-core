# Documentation Accuracy Audit

**Date:** 2026-04-23  
**Scope:** `README.md`, `CHANGELOG.md`, `docs/` (all files), `examples/*/README.md`,
JSDoc sampling of most-imported primitives  
**Cross-references:** `docs/EVENT-NAME-AUDIT.md`, `docs/API-FRICTION.md`  
**Method:** Read-only; no source or doc edits made

---

## Executive Summary

The documentation is largely accurate. The architectural narrative, event-name
status, and lifecycle contract descriptions match the source. Three areas
represent genuine new-reader risk:

1. **`docs/DEPLOYMENT.md` security section** contains two broken constructor
   call signatures — one missing a required parameter, one using a config key
   that does not exist in source. A new reader trying to wire
   `SignedPubSubManager` or `KeyManager` from those examples will get a runtime
   or TypeScript error immediately.

2. **`examples/README.md`** is four examples out of date: `cluster-collab`,
   `live-video`, `pipelines`, and `chat` all exist in `examples/` but are not
   listed. A new reader following the README to run examples will miss the two
   most sophisticated demonstrations.

3. **Six features shipped since the last docs pass are absent from `CHANGELOG.md`
   and all prose documentation** — `EntityRegistryBootstrapper`,
   `PubSubHeartbeatSource`, `HttpsForwardingTransport`, `HttpsForwardingServer`,
   `MetricsRegistry.child()`, and `RateLimiter.maxBuckets`. They exist in
   source and are exported; they are invisible to documentation readers.

Findings count by severity: **Critical 2 · High 6 · Medium 5 · Low 4**

---

## Drift Findings

### Critical

**C-1 — `DEPLOYMENT.md:540`: `SignedPubSubManager` constructor missing required argument**

Documented call:
```ts
const signedPubSub = new SignedPubSubManager(rawPubSub, keyManager, {
  strictMode: true,
});
```
Actual constructor (`src/gateway/pubsub/SignedPubSubManager.ts`):
```ts
constructor(inner: PubSubManager, keyManager: KeyManager, localNodeId: string, config?: SignedPubSubManagerConfig)
```
The third positional argument `localNodeId: string` is required. The documented
call silently passes `{ strictMode: true }` as `localNodeId`, which will either
be a TypeScript compile error or, if types are loose, pass a plain object as the
node identifier. File: `docs/DEPLOYMENT.md` line 543.

**C-2 — `DEPLOYMENT.md:537`: `KeyManager` config key `privateKeyPath` does not exist**

Documented call:
```ts
const keyManager = new KeyManager({ privateKeyPath: '/run/secrets/node-key.pem' });
```
`KeyManagerConfig` in `src/identity/KeyManager.ts` defines `privateKeyPem`
(PEM string content) and `publicKeyPem`, not a file path. The key
`privateKeyPath` is silently ignored at runtime; the `KeyManager` starts in
key-generation mode rather than loading the caller's key. File:
`docs/DEPLOYMENT.md` line 537.

---

### High

**H-1 — `DEPLOYMENT.md:586–591`: Feature gap #2 describes `/metrics` endpoint as unbuilt — it ships**

The text reads: "a pull-based `/metrics` HTTP endpoint … does not exist yet.
The metrics data model is ready; adding a `/metrics` route to `ForwardingServer`
is a small addition." `ForwardingServer` (`src/routing/ForwardingServer.ts`)
already exposes exactly this: `metricsRegistry?: MetricsRegistry` +
`metricsPath?: string` config fields; on `GET /metrics` it calls
`formatPrometheus()` and returns the snapshot. The route is opt-in (pass
`metricsRegistry` at construction) but the code ships. File:
`docs/DEPLOYMENT.md` lines 586–591.

**H-2 — `DEPLOYMENT.md:592–596`: Feature gap #3 describes heartbeat transport as unbuilt — `PubSubHeartbeatSource` ships**

The text reads: "A WebSocket-based or PubSub-based heartbeat plugin would close
this gap." `PubSubHeartbeatSource` (`src/cluster/failure/PubSubHeartbeatSource.ts`)
is exactly this: it publishes heartbeats on a configurable PubSub topic at a
configurable interval and feeds `FailureDetector` via subscription. The class is
exported from `src/cluster/failure/index.ts`. File: `docs/DEPLOYMENT.md` lines
592–596.

**H-3 — Six shipped features absent from `CHANGELOG.md` and all prose documentation**

The following primitives are exported and functional but do not appear in the
`CHANGELOG.md` Added sections, `README.md` primitives table, or any `docs/`
file:

| Feature | Source location | Exported from index? |
|---|---|---|
| `EntityRegistryBootstrapper` | `src/cluster/entity/EntityRegistryBootstrapper.ts` | Yes (via entity/index) |
| `PubSubHeartbeatSource` | `src/cluster/failure/PubSubHeartbeatSource.ts` | Yes (via failure/index) |
| `HttpsForwardingTransport` | `src/routing/HttpsForwardingTransport.ts` | Yes (routing/index) |
| `HttpsForwardingServer` | `src/routing/HttpsForwardingServer.ts` | Yes (routing/index) |
| `MetricsRegistry.child()` | `src/monitoring/metrics/MetricsRegistry.ts:243` | Yes (method on exported class) |
| `RateLimiter.maxBuckets` | `src/common/RateLimiter.ts:6` | Yes (config field) |
| `atomicWriteFile` | `src/persistence/atomicWrite.ts` | Yes (persistence index) |

These are noted in the task scope as "new features shipped this session." None
have a `CHANGELOG.md` entry; none appear in `README.md` primitive table. A
reader using `README.md` as the discovery surface would not know they exist.

**H-4 — `examples/README.md`: four examples absent from the listing**

`examples/README.md` lists four examples (`kv-database`, `queue-worker`,
`api-server`, `management-agent`). The following directories exist but are not
listed:

- `examples/cluster-collab/` — the primary multi-node demonstration
- `examples/live-video/` — the second-consumer composition test
- `examples/pipelines/` — pipeline execution example
- `examples/chat/` — chat example (no README)

File: `examples/README.md` (entire listing). The two most significant examples
for understanding the library's main primitives are invisible here.

**H-5 — `PIPELINE-INTEGRATION.md:11`: EventBus topic pattern documented incorrectly**

The doc states: "`PipelineExecutor` emits via `EventBus<PipelineEventMap>` on
topic `pipeline.events.{runId}`." The actual default topic in
`src/applications/pipeline/PipelineModule.ts:173` is `'pipeline.events'` (no
per-run suffix). A per-run topic is not the default; it would require setting
`pipelineConfig.eventBusTopic`. File: `docs/PIPELINE-INTEGRATION.md` line 11.

**H-6 — `PrometheusExporter` / `PrometheusHttpExporter` not exported from package index**

`CHANGELOG.md` line 68 lists `PrometheusExporter` and `PrometheusHttpExporter`
as shipped. Both classes exist in
`src/monitoring/metrics/PrometheusExporter.ts` and work. However, neither is
re-exported from `src/index.ts` (the package entry point) nor from
`src/monitoring/metrics/index.ts`. They are importable only by path. Any
consumer following the CHANGELOG entry and writing
`import { PrometheusHttpExporter } from 'distributed-core'` gets a compile
error. Related: `docs/DEPLOYMENT.md:401` notes "a dedicated `PrometheusExporter`
convenience class does not yet exist as a separate export" — this is now
outdated; the class exists but is not wired into the public surface.

---

### Medium

**M-1 — `README.md:101–107` and `docs/CLUSTER-READINESS-PLAN.md:3`: stale test counts**

`README.md` lines 101 and 107 claim "~2 000 cases, 158 suites." `CLUSTER-READINESS-PLAN.md` header states "107 unit suites, 1779 tests + 12 integration suites, 77 tests." Actual Jest output (run 2026-04-23): **120 total suites, 2058 total tests** (2050 passed + 1 skipped + 7 todo). `CHANGELOG.md` is closer but also stale: "111 unit suites / 1921 tests; 39 integration suites / 274 tests." All four counts are wrong; only the CHANGELOG note comes close.

**M-2 — `examples/cluster-collab/README.md:1`: "six primitives" vs nine listed**

The opening sentence reads "compose six distributed-core primitives." The table
in the same file lists nine: `EntityRegistry`, `EntityRegistrySyncAdapter`,
`ResourceRouter`, `DistributedSession`, `SharedStateManager`,
`AutoReclaimPolicy`, `ConnectionRegistry`, `EventBus`, `MetricsRegistry`. The
`CHANGELOG.md` entry (line 87) correctly says "composing 9 primitives." File:
`examples/cluster-collab/README.md` line 1.

**M-3 — `PIPELINE-INTEGRATION.md:80`: deprecated dot-form event name used without colon-form note**

Section 4 (Cancellation) reads: "in-flight LLM calls abort → final
`pipeline.run.cancelled` event on the bus." This presents the deprecated
dot-form as the primary event name in a prose flow without noting that
`pipeline:run:cancelled` is canonical. All other sections in that doc use
colon form. Per the audit scope: a doc that mentions the dot form as primary
without the colon form is a valid flag. File: `docs/PIPELINE-INTEGRATION.md`
line 80.

**M-4 — `README.md` quick-start sample: `clusterManager` undefined**

The quick-start block (lines 17–45) calls
`new ResourceRouter('node-A', registry, clusterManager)` but `clusterManager`
is never declared in the snippet. The snippet would not compile as written; a
reader copy-pasting it gets a `ReferenceError`. File: `README.md` line 37.

**M-5 — `ARCHITECTURE.md:35`: composition layer source list omits `ForwardingServer`**

The source-location annotation lists `src/routing/ForwardingRouter.ts` but
omits `src/routing/ForwardingServer.ts`, which is equally part of the
composition layer and is mentioned by name in the layer diagram. Minor but a
new reader looking for the server implementation via this annotation will not
find it. File: `docs/ARCHITECTURE.md` line 35.

---

### Low

**L-1 — `docs/CLUSTER-READINESS-PLAN.md:3`: design-doc test counts preserved in status line**

The status header cites numbers that predate the current session by two major
passes. The document is explicitly a historical design record; its stale counts
are less risky than the README's. File: `docs/CLUSTER-READINESS-PLAN.md` line 3.

**L-2 — `DEPLOYMENT.md:401`: claim that `PrometheusExporter` "does not yet exist" is outdated**

The note reads: "a dedicated `PrometheusExporter` convenience class does not
yet exist as a separate export. Use `MetricsExporter` with `type: 'prometheus'`
as shown above." The class ships; it is just not in the export surface (see
H-6). The note is technically accurate about the export but misleads readers
into thinking the class does not exist at all. File: `docs/DEPLOYMENT.md`
line 401.

**L-3 — `examples/live-video/README.md:39`: `TranscoderLock` listed as a primitive**

The primitives table includes `TranscoderLock` as if it were a distributed-core
export. It is a domain wrapper defined inside the example itself
(`examples/live-video/`). A reader expecting to import `TranscoderLock` from
`distributed-core` would get a compile error. File:
`examples/live-video/README.md` line 39.

**L-4 — `docs/API-FRICTION.md:146`: cross-file reference to `social-api` project**

The "What we're NOT doing" section references "social-api" as an active
consumer that informs API polish timing. No `social-api` directory or reference
exists anywhere in this repository. If this is an external project, the
reference is opaque to a new reader; if it was removed, the reference is
stale. File: `docs/API-FRICTION.md` line 186.

---

## Missing Documentation

Features confirmed shipped (exported, tested) with no prose entry outside
source JSDoc or CHANGELOG:

| Feature | JSDoc? | CHANGELOG entry? | Docs/README entry? |
|---|---|---|---|
| `EntityRegistryBootstrapper` | Yes (6 blocks) | No | No |
| `PubSubHeartbeatSource` | Yes (3 blocks) | No | No |
| `HttpsForwardingTransport` | Yes (5 blocks) | No | No |
| `HttpsForwardingServer` | Yes (2 blocks) | No | No |
| `MetricsRegistry.child()` | Inline only | Partial (CHANGELOG line 63) | No |
| `RateLimiter.maxBuckets` | Inline field comment | No | No |
| `atomicWriteFile` | No | No | No |
| `ForwardingServer` `/metrics` opt-in route | Inline | No | Negated by DEPLOYMENT.md |

`examples/pipelines/` and `examples/chat/` have no README files.

---

## JSDoc Coverage Table (Most-Imported Primitives)

Methodology: count `/**` block openings (class + method JSDoc) vs
method-signature lines (approximate public surface). Raw counts from `grep`;
ratios are directional, not exact.

| Primitive | Source | JSDoc blocks | Method-like lines | Coverage (approx) |
|---|---|---|---|---|
| `ResourceRouter` | `src/routing/ResourceRouter.ts` | 16 | 27 | ~60% |
| `DistributedLock` | `src/cluster/locks/DistributedLock.ts` | 1 | 22 | ~5% |
| `EventBus` | `src/messaging/EventBus.ts` | 4 | 47 | ~9% |
| `MetricsRegistry` | `src/monitoring/metrics/MetricsRegistry.ts` | 3 | 39 | ~8% |
| `ConnectionRegistry` | `src/connections/ConnectionRegistry.ts` | 3 | 30 | ~10% |
| `EntityRegistrySyncAdapter` | `src/cluster/entity/EntityRegistrySyncAdapter.ts` | 0 | 15 | 0% |
| `ForwardingRouter` | `src/routing/ForwardingRouter.ts` | 0 | 6 | 0% |
| `ClusterLeaderElection` | `src/cluster/locks/ClusterLeaderElection.ts` | 0 | 11 | 0% |
| `EntityRegistryBootstrapper` | `src/cluster/entity/EntityRegistryBootstrapper.ts` | 6 | — | Reasonable |
| `PubSubHeartbeatSource` | `src/cluster/failure/PubSubHeartbeatSource.ts` | 3 | — | Reasonable |

**Three critical primitives have zero JSDoc blocks**: `EntityRegistrySyncAdapter`
(the central cross-node sync mechanism), `ForwardingRouter` (the RPC layer), and
`ClusterLeaderElection` (the highest-level leadership primitive). A reader who
reaches these through IDE autocomplete has no inline guidance.

---

## Event Name Status

No new over-flagging is needed here. `docs/EVENT-NAME-AUDIT.md` is current and
accurate. The only documentation-level gap noted above (M-3) is
`PIPELINE-INTEGRATION.md:80` using `pipeline.run.cancelled` as primary without
noting the colon form. All other dot-form and hyphen-form names in docs are
either correctly labeled as deprecated aliases or are in the EVENT-NAME-AUDIT
itself which explicitly documents them.

---

## Action List

Listed in priority order by new-reader impact.

1. **[Critical] Fix `DEPLOYMENT.md` security code samples** — Add missing
   `localNodeId` to `SignedPubSubManager` constructor; replace
   `privateKeyPath` with `privateKeyPem` in `KeyManager` config. Two lines.
   File: `docs/DEPLOYMENT.md` ~lines 537–544.

2. **[High] Add `cluster-collab`, `live-video`, `pipelines`, `chat` to
   `examples/README.md`** — The two primary composition demos are invisible to
   readers using the index. File: `examples/README.md`.

3. **[High] Add missing primitives to `CHANGELOG.md` Added section** —
   `EntityRegistryBootstrapper`, `PubSubHeartbeatSource`,
   `HttpsForwardingTransport`, `HttpsForwardingServer`, `MetricsRegistry.child()`,
   `RateLimiter.maxBuckets`, `atomicWriteFile`. File: `CHANGELOG.md`.

4. **[High] Correct `DEPLOYMENT.md` feature-gap section** — Remove or update
   gap #2 (ForwardingServer `/metrics` ships) and gap #3 (`PubSubHeartbeatSource`
   ships). File: `docs/DEPLOYMENT.md` lines 586–596.

5. **[High] Export `PrometheusHttpExporter` and `formatPrometheus` from
   `src/index.ts`** — Or explicitly note in `CHANGELOG.md` that they are
   path-importable only. File: `src/index.ts` and/or `CHANGELOG.md`.

6. **[High] Fix `PIPELINE-INTEGRATION.md:11` topic name** — Change
   `pipeline.events.{runId}` to `pipeline.events` (the actual default). File:
   `docs/PIPELINE-INTEGRATION.md` line 11.

7. **[Medium] Update test counts in `README.md`** — Change "~2 000 cases, 158
   suites" to actual (120 suites, 2058 tests as of this audit date). File:
   `README.md` lines 101, 107.

8. **[Medium] Fix `examples/cluster-collab/README.md` primitive count** — Change
   "six" to "nine" or match the table. File:
   `examples/cluster-collab/README.md` line 1.

9. **[Medium] Fix `PIPELINE-INTEGRATION.md:80` event name** — Replace
   `pipeline.run.cancelled` with `pipeline:run:cancelled` (or add deprecation
   note). File: `docs/PIPELINE-INTEGRATION.md` line 80.

10. **[Medium] Add JSDoc to `EntityRegistrySyncAdapter`, `ForwardingRouter`,
    `ClusterLeaderElection`** — These three zero-coverage primitives are central
    to any non-trivial use of the library.

11. **[Low] Add README files to `examples/pipelines/` and `examples/chat/`**.

12. **[Low] Remove or clarify `TranscoderLock` from `examples/live-video/README.md`
    primitives table** — Mark it clearly as an in-example domain wrapper, not a
    library export. File: `examples/live-video/README.md` line 39.

---

## Top Three Priorities for New Readers

**Priority 1 — Broken security wiring examples (C-1, C-2).**
A reader following `docs/DEPLOYMENT.md` to wire `SignedPubSubManager` will
produce code that silently fails at runtime (wrong node identity) and uses a
config key that is ignored (wrong key-load path). This is the most misleading
documentation in the repository because the failure is not immediately visible.

**Priority 2 — Missing examples in `examples/README.md` (H-4).**
`cluster-collab` is the canonical multi-node demonstration referenced
throughout `README.md`, `ARCHITECTURE.md`, and `DEPLOYMENT.md`. A new reader
starting from `examples/README.md` will never find it and will instead try to
run one of the four older, less representative examples.

**Priority 3 — Six shipped primitives absent from all discovery surfaces (H-3).**
`PubSubHeartbeatSource` directly addresses a documented gap; `HttpsForwarding*`
provides TLS transport; `MetricsRegistry.child()` is the recommended pattern
for per-resource metric namespacing. A reader relying on the README primitives
table or CHANGELOG as their discovery surface will not know any of these exist.
