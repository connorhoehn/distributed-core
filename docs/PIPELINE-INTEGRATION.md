# Pipeline Integration Contract

Notes for anyone (human or agent) wiring distributed-core's `PipelineModule` to an external system — for example the Phase-4 gateway bridge in websocket-gateway that proxies pipeline events to a React Flow frontend.

This doc captures the surfaces that cross the module boundary. If something in here turns out to be wrong, update this file, don't rely on memory.

---

## 1. Event emission

`PipelineExecutor` emits via `EventBus<PipelineEventMap>` on topic `pipeline.events.{runId}`.

The `EventBus` is WAL-backed (see `src/messaging/EventBus.ts`). Replay from checkpoint is a first-class operation — subscribers can catch up from a specific `version` rather than just receiving live events.

Typical consumer shape:
```ts
const bus = pipelineModule.getEventBus(runId);  // or shared bus + topic filter
bus.subscribe<'pipeline.step.started'>('pipeline.step.started', async (event) => {
  // event.payload: { runId, stepId, seq, ... }
});
```

## 2. Ownership lookup

Pipeline runs are `ResourceRouter`-claimed resources with id `pipeline-run:{runId}`.

```ts
const target = await resourceRouter.route(`pipeline-run:${runId}`);
// target: RouteTarget { nodeId, address, port, isLocal } | null
```

If you're not on the owning node, either:
- Use `ForwardingRouter.call(resourceId, path, payload)` with `HttpForwardingTransport` — ships in `src/routing/`
- Subscribe to the owning node's `EventBus` directly if your pubsub layer is shared

## 3. Orphan and reassignment — important for frontends

When the owning node dies:

1. `resource:orphaned` fires on surviving nodes
2. `AutoReclaimPolicy` picks a new owner via the configured `PlacementStrategy`
3. The new owner resumes from the latest `CheckpointWriter` snapshot
4. Events from checkpoint-forward are replayed on the bus

**What the frontend sees:**
- A gap during the failover window (~lease duration + reclaim jitter)
- Replayed events covering the window between the last checkpoint and the crash

**What the frontend must do:**
- Dedupe on `(runId, stepId, seq)` — not on timestamps (those are re-stamped on replay)
- Treat "event with the same seq I already have" as a no-op

## 4. Cancellation

Don't drop the websocket. Cancellation must hit the module API.

Flow: frontend → bridge → `pipelineModule.deleteResource(runId)` → executor's `AbortSignal` fires → in-flight LLM calls abort → final `pipeline.run.cancelled` event on the bus.

## 5. LLMClient injection

`LLMClient` is a pluggable interface. For development or deterministic tests, register:

- `FixtureLLMClient` — emits scripted tokens from a fixture file
- `RecordReplayLLMClient` — captures real calls, replays them on subsequent runs
- Anthropic / Bedrock implementations — real API calls, picked via `PIPELINE_LLM_PROVIDER` env var

## 6. Metrics

`pipelineModule.getMetrics()` returns aggregate counters:
```ts
{
  runsStarted, runsCompleted, runsFailed, runsActive,
  avgDurationMs, llmTokensIn, llmTokensOut
}
```

Poll at 1Hz for dashboards. Don't subscribe to individual token events for dashboard purposes — the cost scales with token rate.

## 7. Type drift warning

`src/applications/pipeline/types.ts` is a **standalone mirror** of `websocket-gateway/frontend/src/types/pipeline.ts` — no cross-import.

Type evolution options, in order of effort:

1. **Ad-hoc sync** (current): manual diff + patch in both repos when the type changes. Low friction, high drift risk.
2. **PR discipline**: require same-PR changes on both sides. Medium friction.
3. **Shared types package** (`@distributed-core/pipeline-types` or similar): highest friction initially, zero drift after.

(1) is fine for now. Revisit if the types evolve fast.

## 8. Back-pressure

If the frontend can't keep up with a high-token-rate pipeline, wrap event forwarding in `BackpressureController` (`src/gateway/backpressure/`).

Strategy choices:
- `drop-oldest` — keeps the stream smooth, loses middle tokens
- `drop-newest` — preserves history, drops live tokens
- `reject` — preserves ordering, causes backpressure upstream (pauses the frontend)

Pick based on UX. For token streams, `drop-oldest` with a small queue (~100) is usually right — the user sees smooth trailing output even under load.

## 9. Contract test as shared source of truth

`src/applications/pipeline/__tests__/pipelineExecutor.contract.test.ts` is a port of the websocket-gateway `pipelineExecutor.contract.test.ts`. Both implementations (`MockExecutor` in frontend, `PipelineExecutor` in distributed-core) must pass.

**Rule:** if either side changes executor semantics, update the contract test first. Both sides must still pass before merging.

This keeps the in-browser preview and the server-side executor behaviorally identical — which is the whole point of having both.

## 10. Dependencies

distributed-core adds:
- `@anthropic-ai/sdk`
- `@aws-sdk/client-bedrock-runtime`

These are runtime deps. If you run distributed-core in the same Node process as websocket-gateway (unlikely but possible), they become transitive — harmless but worth knowing.

---

## Open questions / likely follow-ups

- Per-run event bus vs shared bus with topic filter — decide based on observed cardinality once real workloads land.
- Checkpoint interval defaults — tune against real LLM call durations; current default is "every N events or M seconds" with TBD values.
- Multi-tenant isolation at the metric level — add `tenantId` labels to `MetricsRegistry` emissions if needed. Not shipped in Phase 3.
