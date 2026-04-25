# Audit: Pipeline Application Module

Date: 2026-04-23
Scope: `src/applications/pipeline/`, `src/applications/ApplicationModule.ts`,
`src/applications/pipeline/__tests__/pipelineExecutor.contract.test.ts`,
`test/integration/pipeline/pipelineModule.integration.test.ts`

Cross-references: `docs/EVENT-NAME-AUDIT.md` (event-naming coverage),
`docs/PIPELINE-INTEGRATION.md` (gateway bridge guidance). Event-naming debt for
the deprecation bridge is fully catalogued there and is not repeated here.

---

## Executive summary

`PipelineExecutor` is a disciplined port of the browser-side `MockExecutor`. The
critical-path invariants — Fork/Join concurrency, `AbortSignal` wiring, event-
emission ordering, and context accumulation — are sound. Three findings require
attention before the next production traffic. The highest-priority is a **listener
leak** in `PipelineModule.createResource`: the `pipeline:llm:response` subscription
is created per-run but never unsubscribed, accumulating on the shared `EventBus`
for the lifetime of the module. The second is a **`completedRuns` map that grows
without bound** — `maxActiveRuns` caps `activeExecutors` capacity in the resource
type definition but applies no eviction to `completedRuns`, which receives every
finalised run. The third is a **stale `userPromptTemplate` substitution**: the
`{{context.foo}}` syntax is advertised in the type comment but the executor passes
the raw template string to `LLMClient.stream` with no interpolation, silently
sending un-substituted markup to the model.

---

## High-severity findings

### H1. `pipeline:llm:response` subscription leaks per run

- **Where:** `src/applications/pipeline/PipelineModule.ts:324–328`
- **What:** `createResource` subscribes to `pipeline:llm:response` for token
  accounting but never stores the subscription handle and never calls
  `eventBus.unsubscribe`. The three lifecycle subscriptions (`completed`, `failed`,
  `cancelled`) each unsubscribe all three peers in their handler. The
  `llm:response` subscription has no partner and outlives the run indefinitely.
  Every run that contains at least one LLM node adds one permanent handler to the
  shared bus.
- **Why it matters:** The `EventBus` accumulates one handler per LLM-containing
  run. On a long-running node processing thousands of runs, this is an unbounded
  listener list. Node's `EventEmitter` will eventually emit
  `MaxListenersExceededWarning`, and every subsequent `llm:response` publish pays
  to fan out to all accumulated dead handlers. This directly degrades the hot token
  loop — each token emit (already dual-emitting) also wakes stale handlers for
  every prior run.
- **Fix shape:** Capture the return value of `eventBus.subscribe` at line 324 into
  `const llmResponseSub`. Unsubscribe it inside each of the three terminal
  handlers alongside their existing `unsubscribe` calls.

---

### H2. `completedRuns` map grows without bound

- **Where:** `src/applications/pipeline/PipelineModule.ts:108, 612`
- **What:** `finaliseRun` moves every terminating executor into `completedRuns`
  unconditionally. There is no eviction, LRU cap, or TTL. `maxActiveRuns`
  (default 1000) is wired to the `ResourceTypeDefinition.defaultCapacity` for the
  scheduler's placement logic, but it does not gate admission to `completedRuns`.
  `deleteResource` does delete from both maps, but that is an explicit caller action
  — it is not invoked automatically on run termination.
- **Why it matters:** A busy node that runs millions of pipelines over days (or a
  pipeline-heavy integration test suite) accumulates unbounded `PipelineRun`
  snapshots in memory. Each `PipelineRun` includes the full `steps` and `context`
  dictionaries — non-trivial for runs with many LLM steps or large context payloads.
  `getMetrics()` also counts `completedRuns.size` in `resourceCounts`, so the
  dashboard shows a monotonically growing total that is misleading.
- **Fix shape:** Apply a simple ring-buffer eviction in `finaliseRun`: after
  `completedRuns.set(runId, run)`, if `completedRuns.size > maxCompletedRuns`
  (a new config knob, default 1000), delete the oldest entry.

---

### H3. `userPromptTemplate` `{{context.foo}}` substitution is silently absent

- **Where:** `src/applications/pipeline/PipelineExecutor.ts:642`,
  `src/applications/pipeline/types.ts:55`
- **What:** `LLMNodeData.userPromptTemplate` is documented as supporting
  `{{context.foo}}` substitution. In `execLLM`, the prompt is set to
  `data.userPromptTemplate` directly (line 642) and passed to `llmClient.stream`
  unchanged. No interpolation is performed. The contract test's fake LLM client
  does not exercise the template path, so the omission goes undetected.
- **Why it matters:** Callers who author pipelines expecting dynamic prompts (e.g.,
  `"Please review: {{context.body}}"`) will send the literal template string to the
  real LLM provider. The model receives markup as prose — wrong answer, wasted
  tokens, and no error.
- **Fix shape:** Before `emit('pipeline:llm:prompt')` at line 644, run a
  `interpolateTemplate(data.userPromptTemplate, context)` pass using the same
  `readPath` helper that `evaluateCondition` already uses.

---

## Medium-severity findings

### M1. `cancel()` / `run().finally()` double-calls `runPromiseResolve`

- **Where:** `src/applications/pipeline/PipelineExecutor.ts:256, 318`
- **What:** When `cancel()` is called while `run()` is in flight, `cancel()` calls
  `this.runPromiseResolve?.(this.pipelineRun)` (line 318) synchronously. Later,
  `run()`'s `.finally()` also calls `this.runPromiseResolve?.(this.pipelineRun)`
  (line 256). A `Promise` resolve is idempotent, so the `runComplete` Promise
  resolves correctly from the first call. However, `runPromiseResolve` is never
  nulled out after the first call, so the second invocation is a redundant
  function call rather than a no-op. It also means `pipelineRun` is snapshotted
  at two different moments — the `.finally()` snapshot is later and may reflect
  additional state mutations from the cancel path if execution has continued between
  the two calls.
- **Why it matters:** Low risk in practice because the run status is already
  `cancelled` and no further mutations should occur. However, the redundancy
  obscures the intended flow and adds complexity to future maintenance.
- **Fix shape:** Set `this.runPromiseResolve = undefined` after the first call
  in `cancel()` so the `?.` optional-chain short-circuits the second call.

---

### M2. `pipeline:run:reassigned` emits `to: departedNodeId` (incorrect data)

- **Where:** `src/applications/pipeline/PipelineModule.ts:393, 399`
- **What:** `handleOrphanedNodeRuns` emits `pipeline:run:reassigned` with
  `to: departedNodeId` as a Phase-5 placeholder. The `from` and `to` fields are
  therefore identical. The event shape is explicitly defined in `PipelineEventMap`
  as `{ runId, from, to }` — downstream consumers that branch on `to` will
  act on a node that has already left the cluster.
- **Why it matters:** Integration test scenario 10 explicitly validates
  `re!.to === nodeId` (i.e., `from === to`), which confirms the placeholder is
  tested and known. But gateway bridges or external consumers that subscribe to
  `pipeline:run:reassigned` and act on `to` (e.g., to redirect WebSocket traffic)
  will route to a dead node. This is a correctness hazard in multi-node deployments
  today even though the checkpoint resume path is not yet wired.
- **Fix shape:** Either omit `pipeline:run:reassigned` until Phase 5 is
  implemented, or add an explicit `// PLACEHOLDER` comment in the event payload
  and a `WARNING` log at the call site so the hazard is visible.

---

### M3. Dual-emit in hot LLM-token loop

- **Where:** `src/applications/pipeline/PipelineExecutor.ts:1111–1118`
- **What:** Every `pipeline:llm:token` event — emitted once per yielded chunk in
  the LLM streaming loop (line 673) — triggers the `emit()` helper which fully
  awaits the canonical publish then fire-and-forgets the deprecated dot-form alias.
  For a typical 500-token response, this is 500 canonical + 500 deprecated = 1000
  `EventBus.publish` calls per step. Each canonical call is fully `await`-ed in the
  loop body (line 673–678), so the stream cannot yield the next token until the
  current token's publish resolves.
- **Why it matters:** For a WAL-backed `EventBus` this means 500 WAL writes per LLM
  step, plus 500 async fire-and-forget publishes queued on the microtask heap. In
  the in-memory bus used by tests the impact is small. In production with a WAL the
  effective throughput of the token stream is bounded by WAL write latency × token
  count, which likely exceeds the model's streaming rate.
- **Note:** This is an architectural trade-off (durability vs. latency) rather than
  a defect. It is noted here because the deprecation bridge doubles the publish cost
  for every token. Once the dot-form aliases are removed (see `EVENT-NAME-AUDIT.md`),
  the cost halves. A medium-term mitigation is to batch-buffer token events and
  flush asynchronously, as recommended in `PIPELINE-INTEGRATION.md §9`.

---

## Low-severity / informational findings

### L1. `checkpointEveryN` config key is accepted but never consumed

- **Where:** `src/applications/pipeline/PipelineModule.ts:73`
- **What:** `PipelineModuleConfig` declares `checkpointEveryN?: number`. It is
  stored in `pipelineConfig` but never read. No `CheckpointWriter` is instantiated
  anywhere in the module. The comment at line 170 confirms checkpoint resume is
  deferred to a future phase.
- **Why it matters:** Callers who set `checkpointEveryN` will assume checkpoint
  behaviour is active and may not write compensating logic for run resumability.
  The config knob is a silent lie.
- **Fix shape:** Remove the field from `PipelineModuleConfig` until the
  `CheckpointWriter` integration is implemented, or add a runtime warning when the
  field is non-zero.

### L2. `orphaned` handler scans `completedRuns`, not `activeExecutors`

- **Where:** `src/applications/pipeline/PipelineModule.ts:375`
- **What:** `handleOrphanedNodeRuns` iterates only `completedRuns`. If a run is
  still in-flight in `activeExecutors` at the moment the owner node departs — which
  is the case most relevant to orphan recovery — the run is silently ignored and no
  `pipeline:run:orphaned` event is emitted for it.
- **Why it matters:** The runs most at risk (active runs) are exactly those not
  emitting the event. Integration test scenario 10 works because it waits for the
  run to complete and move to `completedRuns` before simulating the member-left
  event. A real node crash mid-run would not trigger the orphan path for those runs.
- **Fix shape:** Iterate both `activeExecutors` and `completedRuns` in
  `handleOrphanedNodeRuns`.

### L3. Model identifiers leak into contract test

- **Where:**
  `src/applications/pipeline/__tests__/pipelineExecutor.contract.test.ts:204–205`
- **What:** `llmNode()` hardcodes `provider: 'anthropic'` and
  `model: 'claude-sonnet-4-6'` into `LLMNodeData`. The executor is vendor-neutral
  (the `LLMClient` abstraction is the sole boundary) and the fake LLM client ignores
  both fields. These strings are inert data within the test harness, but they make
  the contract test read as Anthropic-specific.
- **Why it matters:** A contributor running the tests against a different provider
  fixture might interpret the hardcoded strings as a coupling requirement. No
  behavioural risk.
- **Fix shape:** Replace with `provider: 'test-provider'` and
  `model: 'test-model'` in the test factory.

### L4. `evaluateCondition` fallback is non-deterministic

- **Where:** `src/applications/pipeline/PipelineExecutor.ts:1194–1195`
- **What:** Condition expressions that do not match the supported
  `context.<path> === <literal>` regex fall back to `Math.random() < 0.6`. Existing
  contract tests do not trigger this path (they use exact-match expressions), so
  the fallback is untested. A malformed expression in a real pipeline silently
  chooses a branch at random.
- **Why it matters:** Silent randomness in a production workflow is difficult to
  debug. The spec reference `§8.4` documents this intentional demo behaviour, but
  there is no log warning that the fallback fired.
- **Fix shape:** Log a `warn` when the fallback fires, and consider returning
  `false` (deterministic rejection) rather than a random value once the expression
  evaluator is hardened.

### L5. `forkBranches` state data is not persisted across cancel

- **Where:** `src/applications/pipeline/PipelineExecutor.ts:149`
- **What:** `joinStates` accumulates arrival records during a fork/join execution.
  On `cancel()`, neither `joinStates` nor `firedJoins` are cleared. For the
  current single-executor model this is not a problem (the executor instance is
  discarded after cancel). If the executor were reused (e.g., a future
  `resumeFromStep` path), stale join state from the cancelled run would corrupt
  the resumed run's join accumulation.
- **Why it matters:** No defect today. Flagged because the `resumeFromStep` API is
  a known future work item (contract test line 915, `test.skip`).

### L6. `dispatch()` switch — exhaustiveness enforced by TypeScript, not runtime

- **Where:** `src/applications/pipeline/PipelineExecutor.ts:600–619`
- **What:** The `dispatch` switch covers all eight `NodeData.type` values. There is
  no `default` branch; if a new node type is added to `NodeData` without updating
  `dispatch`, TypeScript will fail the build (the function return type is
  `Promise<StepOutcome>` and the missing case is a type error). This is correct
  compile-time exhaustiveness checking.
- **Why it matters:** Informational only. No runtime risk given current TypeScript
  configuration. Noted because the audit scope asked for exhaustiveness assessment.

### L7. `snapshotContext` is a shallow copy

- **Where:** `src/applications/pipeline/PipelineExecutor.ts:1094–1096`
- **What:** `snapshotContext` does a single-level `{ ...context }`. Nested objects
  within `context` (e.g., `context.steps`, which is a mutable object) are shared by
  reference between the snapshot stored in `StepExecution.input` and the live
  context. Mutations to nested objects after the snapshot is taken will retroactively
  alter the stored input.
- **Why it matters:** Low risk in the current execution model because `context.steps`
  is only appended to (never mutated in place), and the snapshot is only used for
  `step.input` display. If downstream steps were to delete or overwrite nested keys,
  the historical `input` records would silently change.

---

## Verified correct / no issue found

| Topic | Verdict |
|---|---|
| Fork/Join race safety | Safe. JavaScript single-thread model guarantees the synchronous block (lines 848–852) before the first `await` at line 864 is atomic; a concurrent arrival cannot interleave in that window. |
| `AbortSignal` propagation | Correct. `abortController.signal` is passed to `llmClient.stream`; `streamCancelled` flag + `cancelHooks` set covers both the iterator loop and the post-loop guard. |
| `shouldJoinFire` mode correctness | Correct for `all`, `any`, and `n_of_m`, including the fail-fast arithmetic shortcut for `n_of_m`. |
| Event-emission ordering | Contract invariants hold. The fully-awaited canonical emit path guarantees ordering within a coroutine. The `cancel()` fire-and-forget path emits `step:cancelled` and `step:skipped` before `run:cancelled` in microtask queue order. |
| State consistency on failure | When a step fails, `step.status = 'failed'`, `step.error`, and `step.completedAt` are all set before `step:failed` is emitted (line 581–586). `pipelineRun.status` is updated in the top-level `.catch` only after `executeFromNode` has fully unwound via `BranchFailure`. |
| `pendingApprovals` lifecycle | Entries are deleted on `resolve('approve')` (line 355), `resolve('reject')` (line 349), cancel-hook (line 814), and timeout fire (line 804). No leak path found. |
| Vendor neutrality | No vendor SDK imports in `PipelineExecutor`, `PipelineModule`, `types.ts`, or `LLMClient.ts`. Vendor names in comments and in `PIPELINE-INTEGRATION.md §10` are documentation-only. The `provider: 'anthropic'` in the contract test is inert data (L3 above). |
| `as any` / `@ts-ignore` | Zero occurrences in pipeline source files. |
| Missing public API | No test or doc references a method on `PipelineModule` that is absent. `resumeFromStep` is explicitly `test.skip`-ed in the contract suite. |
| Deprecation bridge dual-emit correctness | The `CANONICAL_TO_DEPRECATED` map covers all 22 events in both directions. The dot-form publish is fire-and-forget and does not block the canonical path. |
