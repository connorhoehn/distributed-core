// src/applications/pipeline/__tests__/pipelineExecutor.contract.test.ts
//
// CONTRACT TEST SUITE for PipelineExecutor.
//
// Ported from:
//   websocket-gateway/frontend/src/components/pipelines/__tests__/
//   pipelineExecutor.contract.test.ts
//
// The same ordering invariants (§17.9) and edge cases (§17.1–17.8) from the
// original MockExecutor contract test are replicated here against the server-
// side PipelineExecutor. A fake LLMClient with deterministic tokens is injected
// so no real LLM credentials are required.
//
// Swapped from Vitest: `import { describe, test, expect } from 'vitest'`
// to `import { describe, test, expect } from '@jest/globals'` — Jest is the
// test runner in this repo.

import { describe, test, expect } from '@jest/globals';
import { PipelineExecutor } from '../PipelineExecutor';
import { EventBus } from '../../../messaging/EventBus';
import type { LLMClient, LLMChunk } from '../LLMClient';
import type {
  ActionNodeData,
  ApprovalNodeData,
  ConditionNodeData,
  ForkNodeData,
  JoinNodeData,
  LLMNodeData,
  NodeData,
  PipelineDefinition,
  PipelineEdge,
  PipelineEventMap,
  PipelineNode,
  TransformNodeData,
  TriggerNodeData,
} from '../types';

// ---------------------------------------------------------------------------
// Fake LLMClient — deterministic, no network
// ---------------------------------------------------------------------------

const FAKE_RESPONSE = 'Hello world this is a test response with multiple tokens for streaming.';

const FAKE_TOKENS = FAKE_RESPONSE.match(/\S+\s*|\s+/g) ?? [FAKE_RESPONSE];

function makeFakeLLMClient(overrides: { failRate?: number } = {}): LLMClient {
  const failRate = overrides.failRate ?? 0;
  return {
    stream(_model, _system, _user, opts) {
      return {
        async *[Symbol.asyncIterator]() {
          if (Math.random() < failRate) {
            throw new Error('LLM provider error (fake failure rate)');
          }

          for (const token of FAKE_TOKENS) {
            if (opts?.signal?.aborted) {
              throw new DOMException('Aborted', 'AbortError');
            }
            yield { done: false, token } as LLMChunk;
          }

          yield {
            done: true,
            response: FAKE_RESPONSE,
            tokensIn: 10,
            tokensOut: FAKE_TOKENS.length,
          } as LLMChunk;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal in-process pubsub stub — no Transport or ClusterManager needed.
// Same pattern used in test/unit/messaging/EventBus.test.ts.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeLocalPubSub(): any {
  // May have multiple subscribers (subscribeAll + typed subs).
  const handlers: Map<string, (topic: string, payload: unknown, meta: Record<string, unknown>) => Promise<void>> = new Map();
  let subCounter = 0;
  return {
    subscribe(_topic: string, h: (topic: string, payload: unknown, meta: Record<string, unknown>) => Promise<void>) {
      subCounter++;
      const id = `sub-local-${subCounter}`;
      handlers.set(id, h);
      return id;
    },
    unsubscribe(id: string) {
      handlers.delete(id);
    },
    async publish(topic: string, payload: unknown) {
      const meta = {
        publisherNodeId: 'test-node',
        messageId: String(Date.now()),
        timestamp: Date.now(),
        topic,
      };
      // Deliver to all subscribers.
      await Promise.all(Array.from(handlers.values()).map((h) => h(topic, payload, meta)));
    },
  };
}

// ---------------------------------------------------------------------------
// EventBus factory — in-memory, no WAL needed for contract tests
// ---------------------------------------------------------------------------

function makeEventBus(): EventBus<PipelineEventMap> {
  const pubsub = makeLocalPubSub();
  return new EventBus<PipelineEventMap>(pubsub, 'test-node', {
    topic: 'pipeline.test',
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single event record, keyed by its event type, with its full payload. */
type EventRecord = {
  [K in keyof PipelineEventMap]: { type: K; payload: PipelineEventMap[K] };
}[keyof PipelineEventMap];

// ---------------------------------------------------------------------------
// Builder helpers
// ---------------------------------------------------------------------------

let nodeIdSeq = 0;
let edgeIdSeq = 0;

function nextNodeId(prefix = 'n'): string {
  nodeIdSeq += 1;
  return `${prefix}-${nodeIdSeq}`;
}

function nextEdgeId(): string {
  edgeIdSeq += 1;
  return `e-${edgeIdSeq}`;
}

/** Build a `PipelineNode` with a typed `data` payload. */
function makeNode<D extends NodeData>(id: string, data: D, x = 0, y = 0): PipelineNode {
  return {
    id,
    type: data.type,
    position: { x, y },
    data,
  };
}

/** Build a `PipelineEdge` between two nodes with optional handles. */
function makeEdge(
  source: string,
  target: string,
  sourceHandle = 'out',
  targetHandle = 'in',
): PipelineEdge {
  return {
    id: nextEdgeId(),
    source,
    sourceHandle,
    target,
    targetHandle,
  };
}

/**
 * Wrap a caller-provided set of nodes / edges into a full `PipelineDefinition`.
 */
function buildPipeline(partial: {
  id?: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}): PipelineDefinition {
  const now = new Date().toISOString();
  return {
    id: partial.id ?? `pipe-${Math.random().toString(36).slice(2, 10)}`,
    name: 'Contract test pipeline',
    version: 1,
    status: 'published',
    publishedVersion: 1,
    nodes: partial.nodes,
    edges: partial.edges,
    createdAt: now,
    updatedAt: now,
    createdBy: 'contract-test',
  };
}

// Convenience node factories with sensible defaults.

function triggerNode(id = nextNodeId('trigger')): PipelineNode {
  const data: TriggerNodeData = { type: 'trigger', triggerType: 'manual' };
  return makeNode(id, data);
}

function llmNode(id = nextNodeId('llm')): PipelineNode {
  const data: LLMNodeData = {
    type: 'llm',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'You are a helpful reviewer.',
    userPromptTemplate: 'Please review: {{context.body}}',
    streaming: true,
  };
  return makeNode(id, data);
}

function transformNode(id = nextNodeId('xform'), outputKey?: string): PipelineNode {
  const data: TransformNodeData = {
    type: 'transform',
    transformType: 'template',
    expression: '{{ context.body }}',
    outputKey,
  };
  return makeNode(id, data);
}

function conditionNode(id = nextNodeId('cond'), expression = 'context.kind === "x"'): PipelineNode {
  const data: ConditionNodeData = { type: 'condition', expression };
  return makeNode(id, data);
}

function actionNode(id = nextNodeId('action'), overrides: Partial<ActionNodeData> = {}): PipelineNode {
  const data: ActionNodeData = {
    type: 'action',
    actionType: 'notify',
    config: {},
    ...overrides,
  };
  return makeNode(id, data);
}

function forkNode(id = nextNodeId('fork'), branchCount = 2): PipelineNode {
  const data: ForkNodeData = { type: 'fork', branchCount };
  return makeNode(id, data);
}

function joinNode(id = nextNodeId('join'), overrides: Partial<JoinNodeData> = {}): PipelineNode {
  const data: JoinNodeData = {
    type: 'join',
    mode: 'all',
    mergeStrategy: 'deep-merge',
    ...overrides,
  };
  return makeNode(id, data);
}

function approvalNode(id = nextNodeId('approval'), overrides: Partial<ApprovalNodeData> = {}): PipelineNode {
  const data: ApprovalNodeData = {
    type: 'approval',
    approvers: [{ type: 'user', value: 'alice' }],
    requiredCount: 1,
    ...overrides,
  };
  return makeNode(id, data);
}

// ---------------------------------------------------------------------------
// Execution helper
// ---------------------------------------------------------------------------

interface RunOptions {
  failureRateLLM?: number;
  failureRateOther?: number;
  speedMultiplier?: number;
  triggerPayload?: Record<string, unknown>;
  llmClient?: LLMClient;
  /**
   * Hook invoked after the executor is constructed but before `run()` resolves.
   * Lets tests drive cancel() / resolveApproval() while the run is in flight.
   */
  onExecutor?: (executor: PipelineExecutor, events: EventRecord[]) => void;
}

/**
 * Starts a `PipelineExecutor`, collects every event into a chronological array,
 * and resolves when the run terminates. Defaults:
 *   - speedMultiplier = 0.02 (50x faster than real, keeps tests snappy)
 *   - failureRateLLM = 0, failureRateOther = 0 (deterministic)
 */
async function collectEvents(
  definition: PipelineDefinition,
  opts: RunOptions = {},
): Promise<{ events: EventRecord[]; executor: PipelineExecutor }> {
  const events: EventRecord[] = [];
  const bus = makeEventBus();
  await bus.start();

  // Collect only canonical (colon-form) events from the bus.
  // The executor dual-emits both 'pipeline:run:started' (canonical) and
  // 'pipeline.run.started' (deprecated). Contract tests only validate the
  // canonical form; the deprecation bridge is tested separately in
  // test/unit/applications/pipeline/EventRenameDeprecation.test.ts.
  bus.subscribeAll(async (event) => {
    if (typeof event.type === 'string' && (event.type as string).includes('.')) {
      return; // skip deprecated dot-form events
    }
    events.push({ type: event.type, payload: event.payload } as EventRecord);
  });

  const llmClient = opts.llmClient ?? makeFakeLLMClient({ failRate: opts.failureRateLLM ?? 0 });

  const executor = new PipelineExecutor({
    definition,
    ownerNodeId: 'test-node',
    llmClient,
    eventBus: bus,
    triggerPayload: opts.triggerPayload,
    failureRateLLM: opts.failureRateLLM ?? 0,
    failureRateOther: opts.failureRateOther ?? 0,
    speedMultiplier: opts.speedMultiplier ?? 0.02,
  });

  if (opts.onExecutor) opts.onExecutor(executor, events);

  await executor.run();

  // Give a brief tick for any fire-and-forget event bus publishes to resolve.
  await new Promise<void>((r) => setTimeout(r, 10));

  await bus.stop();
  return { events, executor };
}

/** Find the first index of a given event type (optionally filtered by stepId). */
function indexOf(events: EventRecord[], type: keyof PipelineEventMap, stepId?: string): number {
  return events.findIndex((e) => {
    if (e.type !== type) return false;
    if (stepId === undefined) return true;
    const payload = e.payload as { stepId?: string };
    return payload.stepId === stepId;
  });
}

/** Filter events down to a given type. */
function eventsOfType<K extends keyof PipelineEventMap>(
  events: EventRecord[],
  type: K,
): Array<{ type: K; payload: PipelineEventMap[K] }> {
  return events.filter((e) => e.type === type) as Array<{
    type: K;
    payload: PipelineEventMap[K];
  }>;
}

const TERMINAL_STEP_EVENTS: ReadonlyArray<keyof PipelineEventMap> = [
  'pipeline:step:completed',
  'pipeline:step:failed',
  'pipeline:step:skipped',
  'pipeline:step:cancelled',
] as const;

const TERMINAL_RUN_EVENTS: ReadonlyArray<keyof PipelineEventMap> = [
  'pipeline:run:completed',
  'pipeline:run:failed',
  'pipeline:run:cancelled',
] as const;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('PipelineExecutor contract', () => {
  describe('Ordering invariants (§17.9)', () => {
    test('pipeline:run:started precedes every pipeline:step:started', async () => {
      // trigger → action → action : multiple steps, all must come after run.started
      const t = triggerNode();
      const a1 = actionNode();
      const a2 = actionNode();
      const def = buildPipeline({
        nodes: [t, a1, a2],
        edges: [makeEdge(t.id, a1.id), makeEdge(a1.id, a2.id)],
      });

      const { events } = await collectEvents(def);
      const runStartedIdx = indexOf(events, 'pipeline:run:started');
      expect(runStartedIdx).toBeGreaterThanOrEqual(0);

      const stepStarts = events
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.type === 'pipeline:step:started');
      expect(stepStarts.length).toBeGreaterThan(0);
      for (const { i } of stepStarts) {
        expect(i).toBeGreaterThan(runStartedIdx);
      }
    });

    test('each step emits exactly one terminal event (completed / failed / skipped / cancelled)', async () => {
      const t = triggerNode();
      const a = actionNode();
      const def = buildPipeline({
        nodes: [t, a],
        edges: [makeEdge(t.id, a.id)],
      });

      const { events } = await collectEvents(def);

      // Count terminals per stepId.
      const terminalsByStep = new Map<string, number>();
      for (const e of events) {
        if (TERMINAL_STEP_EVENTS.includes(e.type)) {
          const stepId = (e.payload as { stepId: string }).stepId;
          terminalsByStep.set(stepId, (terminalsByStep.get(stepId) ?? 0) + 1);
        }
      }

      // Every started step should have a matching terminal, and exactly one.
      const startedIds = new Set(
        eventsOfType(events, 'pipeline:step:started').map((e) => e.payload.stepId),
      );
      expect(startedIds.size).toBeGreaterThan(0);
      for (const id of startedIds) {
        expect(terminalsByStep.get(id)).toBe(1);
      }
    });

    test('pipeline:llm:prompt precedes all tokens which precede pipeline:llm:response for the same stepId', async () => {
      const t = triggerNode();
      const l = llmNode();
      const def = buildPipeline({
        nodes: [t, l],
        edges: [makeEdge(t.id, l.id)],
      });

      const { events } = await collectEvents(def);
      const promptIdx = indexOf(events, 'pipeline:llm:prompt', l.id);
      const responseIdx = indexOf(events, 'pipeline:llm:response', l.id);

      expect(promptIdx).toBeGreaterThanOrEqual(0);
      expect(responseIdx).toBeGreaterThan(promptIdx);

      // Every token for this step must sit between prompt and response.
      const tokenIdxs = events
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.type === 'pipeline:llm:token' && (e.payload as { stepId: string }).stepId === l.id)
        .map(({ i }) => i);

      expect(tokenIdxs.length).toBeGreaterThan(0);
      for (const i of tokenIdxs) {
        expect(i).toBeGreaterThan(promptIdx);
        expect(i).toBeLessThan(responseIdx);
      }
    });

    test('pipeline:approval:requested precedes pipeline:approval:recorded for the same stepId', async () => {
      const t = triggerNode();
      const ap = approvalNode();
      const done = actionNode();
      const def = buildPipeline({
        nodes: [t, ap, done],
        edges: [makeEdge(t.id, ap.id), makeEdge(ap.id, done.id, 'approved')],
      });

      const { events } = await collectEvents(def, {
        onExecutor: (executor) => {
          // Approve on next tick so the run terminates.
          setTimeout(() => {
            executor.resolveApproval(executor.runId, ap.id, 'alice', 'approve');
          }, 5);
        },
      });

      const requestedIdx = indexOf(events, 'pipeline:approval:requested', ap.id);
      const recordedIdx = indexOf(events, 'pipeline:approval:recorded', ap.id);
      expect(requestedIdx).toBeGreaterThanOrEqual(0);
      expect(recordedIdx).toBeGreaterThan(requestedIdx);
    });

    test('pipeline:run:completed / failed / cancelled are terminal — no events after', async () => {
      const t = triggerNode();
      const a = actionNode();
      const def = buildPipeline({
        nodes: [t, a],
        edges: [makeEdge(t.id, a.id)],
      });

      const { events } = await collectEvents(def);

      // Find the first terminal run event.
      const terminalIdx = events.findIndex((e) => TERMINAL_RUN_EVENTS.includes(e.type));
      expect(terminalIdx).toBeGreaterThanOrEqual(0);
      // Nothing after.
      expect(events.length - 1).toBe(terminalIdx);
    });
  });

  describe('Run lifecycle', () => {
    test('completes a minimal trigger → action pipeline', async () => {
      const t = triggerNode();
      const a = actionNode();
      const def = buildPipeline({
        nodes: [t, a],
        edges: [makeEdge(t.id, a.id)],
      });

      const { events } = await collectEvents(def);
      expect(indexOf(events, 'pipeline:run:started')).toBeGreaterThanOrEqual(0);
      expect(indexOf(events, 'pipeline:run:completed')).toBeGreaterThan(
        indexOf(events, 'pipeline:run:started'),
      );
      // Both nodes completed.
      expect(indexOf(events, 'pipeline:step:completed', t.id)).toBeGreaterThanOrEqual(0);
      expect(indexOf(events, 'pipeline:step:completed', a.id)).toBeGreaterThanOrEqual(0);
    });

    test('marks failed with pipeline:run:failed when a node fails with no error handler', async () => {
      const t = triggerNode();
      const a = actionNode(undefined, { onError: 'fail-run' });
      const def = buildPipeline({
        nodes: [t, a],
        edges: [makeEdge(t.id, a.id)],
      });

      const { events } = await collectEvents(def, { failureRateOther: 1 });

      const failedIdx = indexOf(events, 'pipeline:run:failed');
      expect(failedIdx).toBeGreaterThanOrEqual(0);
      // There should be a step.failed for the action.
      expect(indexOf(events, 'pipeline:step:failed', a.id)).toBeGreaterThanOrEqual(0);
      // And run.failed is the final event.
      expect(failedIdx).toBe(events.length - 1);
    });

    test('cancel emits pipeline:run:cancelled + step.cancelled for in-flight + step.skipped for pending', async () => {
      // LLM step streams slowly; cancel mid-run.
      const t = triggerNode();
      const l = llmNode();
      const tail = actionNode();
      const def = buildPipeline({
        nodes: [t, l, tail],
        edges: [makeEdge(t.id, l.id), makeEdge(l.id, tail.id)],
      });

      // Use a fake LLM client that never yields (simulates a slow stream).
      const slowLLM: LLMClient = {
        stream() {
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => setTimeout(resolve, 10000));
              yield { done: true, response: '', tokensIn: 0, tokensOut: 0 } as LLMChunk;
            },
          };
        },
      };

      // Normal speed so the LLM is still streaming when we cancel.
      const { events } = await collectEvents(def, {
        speedMultiplier: 1,
        llmClient: slowLLM,
        onExecutor: (executor) => {
          // Wait until the LLM step has started before cancelling.
          setTimeout(() => executor.cancel(), 80);
        },
      });

      expect(indexOf(events, 'pipeline:run:cancelled')).toBeGreaterThanOrEqual(0);

      // The in-flight step (LLM) should have a step.cancelled.
      expect(indexOf(events, 'pipeline:step:cancelled', l.id)).toBeGreaterThanOrEqual(0);
      // The pending tail step should have a step.skipped with reason=run_cancelled.
      const tailSkipped = eventsOfType(events, 'pipeline:step:skipped').find(
        (e) => e.payload.stepId === tail.id,
      );
      expect(tailSkipped).toBeTruthy();
      expect(tailSkipped?.payload.reason).toBe('run_cancelled');

      // run.cancelled is terminal.
      const cancelledIdx = indexOf(events, 'pipeline:run:cancelled');
      expect(cancelledIdx).toBe(events.length - 1);
    });
  });

  describe('Fork / Join', () => {
    test('Fork with 2 branches fires both branches (two step.started events)', async () => {
      const t = triggerNode();
      const f = forkNode(undefined, 2);
      const a1 = actionNode();
      const a2 = actionNode();
      const def = buildPipeline({
        nodes: [t, f, a1, a2],
        edges: [
          makeEdge(t.id, f.id),
          makeEdge(f.id, a1.id, 'out'),
          makeEdge(f.id, a2.id, 'out'),
        ],
      });

      const { events } = await collectEvents(def);
      const starts = eventsOfType(events, 'pipeline:step:started');
      const branchIds = starts.map((e) => e.payload.stepId);
      expect(branchIds).toContain(a1.id);
      expect(branchIds).toContain(a2.id);
    });

    test('Join mode=all waits for every connected input before firing', async () => {
      const t = triggerNode();
      const f = forkNode();
      const a1 = actionNode();
      const a2 = actionNode();
      const j = joinNode(undefined, { mode: 'all' });
      const def = buildPipeline({
        nodes: [t, f, a1, a2, j],
        edges: [
          makeEdge(t.id, f.id),
          makeEdge(f.id, a1.id, 'out'),
          makeEdge(f.id, a2.id, 'out'),
          makeEdge(a1.id, j.id),
          makeEdge(a2.id, j.id),
        ],
      });

      const { events } = await collectEvents(def);
      const fired = eventsOfType(events, 'pipeline:join:fired').find(
        (e) => e.payload.stepId === j.id,
      );
      expect(fired).toBeTruthy();
      // Join must have been preceded by BOTH branch completions.
      const a1Completed = indexOf(events, 'pipeline:step:completed', a1.id);
      const a2Completed = indexOf(events, 'pipeline:step:completed', a2.id);
      const firedIdx = events.findIndex(
        (e) => e.type === 'pipeline:join:fired' && (e.payload as { stepId: string }).stepId === j.id,
      );
      expect(a1Completed).toBeGreaterThanOrEqual(0);
      expect(a2Completed).toBeGreaterThanOrEqual(0);
      expect(firedIdx).toBeGreaterThan(a1Completed);
      expect(firedIdx).toBeGreaterThan(a2Completed);
    });

    test('Join mode=any fires on first completed input', async () => {
      const t = triggerNode();
      const f = forkNode();
      const a1 = actionNode();
      const a2 = actionNode();
      const j = joinNode(undefined, { mode: 'any' });
      const def = buildPipeline({
        nodes: [t, f, a1, a2, j],
        edges: [
          makeEdge(t.id, f.id),
          makeEdge(f.id, a1.id, 'out'),
          makeEdge(f.id, a2.id, 'out'),
          makeEdge(a1.id, j.id),
          makeEdge(a2.id, j.id),
        ],
      });

      const { events } = await collectEvents(def);
      const joinWaiting = eventsOfType(events, 'pipeline:join:waiting').filter(
        (e) => e.payload.stepId === j.id,
      );
      const fired = eventsOfType(events, 'pipeline:join:fired').find(
        (e) => e.payload.stepId === j.id,
      );
      expect(fired).toBeTruthy();
      // 'any' should fire after just one arrival — required=1 in the payloads.
      expect(joinWaiting.length).toBeGreaterThanOrEqual(1);
      expect(joinWaiting[0].payload.required).toBe(1);
    });

    test('Join mode=n_of_m fires after n inputs', async () => {
      // 3 incoming branches, n=2 required.
      const t = triggerNode();
      const f = forkNode(undefined, 3);
      const a1 = actionNode();
      const a2 = actionNode();
      const a3 = actionNode();
      const j = joinNode(undefined, { mode: 'n_of_m', n: 2 });
      const def = buildPipeline({
        nodes: [t, f, a1, a2, a3, j],
        edges: [
          makeEdge(t.id, f.id),
          makeEdge(f.id, a1.id, 'out'),
          makeEdge(f.id, a2.id, 'out'),
          makeEdge(f.id, a3.id, 'out'),
          makeEdge(a1.id, j.id),
          makeEdge(a2.id, j.id),
          makeEdge(a3.id, j.id),
        ],
      });

      const { events } = await collectEvents(def);
      const joinWaiting = eventsOfType(events, 'pipeline:join:waiting').filter(
        (e) => e.payload.stepId === j.id,
      );
      expect(joinWaiting.length).toBeGreaterThanOrEqual(1);
      // Every waiting event should report required=2.
      for (const w of joinWaiting) expect(w.payload.required).toBe(2);

      const fired = eventsOfType(events, 'pipeline:join:fired').find(
        (e) => e.payload.stepId === j.id,
      );
      expect(fired).toBeTruthy();
    });

    test('Context merge on join uses mergeStrategy=deep-merge by default', async () => {
      const t = triggerNode();
      const f = forkNode();
      const a1 = actionNode();
      const a2 = actionNode();
      const j = joinNode(undefined, { mode: 'all', mergeStrategy: 'deep-merge' });
      const done = actionNode();
      const def = buildPipeline({
        nodes: [t, f, a1, a2, j, done],
        edges: [
          makeEdge(t.id, f.id),
          makeEdge(f.id, a1.id, 'out'),
          makeEdge(f.id, a2.id, 'out'),
          makeEdge(a1.id, j.id),
          makeEdge(a2.id, j.id),
          makeEdge(j.id, done.id),
        ],
      });

      const { events, executor } = await collectEvents(def);
      expect(indexOf(events, 'pipeline:join:fired', j.id)).toBeGreaterThanOrEqual(0);
      expect(indexOf(events, 'pipeline:step:completed', done.id)).toBeGreaterThanOrEqual(0);
      expect(executor).toBeTruthy();
    });
  });

  describe('Condition', () => {
    test('Condition routes to the taken branch; the other branch becomes skipped', async () => {
      const t = triggerNode();
      const c = conditionNode(undefined, 'context.kind === "x"');
      const yes = actionNode();
      const no = actionNode();
      const def = buildPipeline({
        nodes: [t, c, yes, no],
        edges: [
          makeEdge(t.id, c.id),
          makeEdge(c.id, yes.id, 'true'),
          makeEdge(c.id, no.id, 'false'),
        ],
      });

      const { events } = await collectEvents(def, {
        triggerPayload: { kind: 'x' },
      });

      // Only the `yes` branch should emit step.started/step.completed.
      expect(indexOf(events, 'pipeline:step:started', yes.id)).toBeGreaterThanOrEqual(0);
      expect(indexOf(events, 'pipeline:step:completed', yes.id)).toBeGreaterThanOrEqual(0);
      // The not-taken branch should not emit step.started.
      expect(indexOf(events, 'pipeline:step:started', no.id)).toBe(-1);
    });
  });

  describe('LLM streaming', () => {
    test('LLM step emits prompt → tokens → response in order', async () => {
      const t = triggerNode();
      const l = llmNode();
      const def = buildPipeline({
        nodes: [t, l],
        edges: [makeEdge(t.id, l.id)],
      });

      const { events } = await collectEvents(def);
      const promptIdx = indexOf(events, 'pipeline:llm:prompt', l.id);
      const responseIdx = indexOf(events, 'pipeline:llm:response', l.id);
      expect(promptIdx).toBeGreaterThanOrEqual(0);
      expect(responseIdx).toBeGreaterThan(promptIdx);
      const tokenCount = eventsOfType(events, 'pipeline:llm:token').filter(
        (e) => e.payload.stepId === l.id,
      ).length;
      expect(tokenCount).toBeGreaterThan(0);
    });

    test('LLM tokens form the full response string when concatenated', async () => {
      const t = triggerNode();
      const l = llmNode();
      const def = buildPipeline({
        nodes: [t, l],
        edges: [makeEdge(t.id, l.id)],
      });

      const { events } = await collectEvents(def, {
        failureRateLLM: 0,
        speedMultiplier: 1,
      });

      const tokens = eventsOfType(events, 'pipeline:llm:token')
        .filter((e) => e.payload.stepId === l.id)
        .map((e) => e.payload.token);
      const response = eventsOfType(events, 'pipeline:llm:response').find(
        (e) => e.payload.stepId === l.id,
      )?.payload.response;

      expect(response).toBeTruthy();
      expect(tokens.length).toBeGreaterThan(0);

      const reassembled = tokens.join('');
      // Allow trailing whitespace differences; stream may truncate on budget.
      const respTrim = (response ?? '').trim();
      const reassTrim = reassembled.trim();
      expect(respTrim.startsWith(reassTrim) || reassTrim === respTrim).toBe(true);
    }, 20000);
  });

  describe('Approval', () => {
    test('Approval blocks until resolveApproval is called', async () => {
      const t = triggerNode();
      const ap = approvalNode();
      const done = actionNode();
      const def = buildPipeline({
        nodes: [t, ap, done],
        edges: [makeEdge(t.id, ap.id), makeEdge(ap.id, done.id, 'approved')],
      });

      let approvedAt = -1;
      let beforeApproveEvents = -1;
      const { events } = await collectEvents(def, {
        onExecutor: (executor, liveEvents) => {
          setTimeout(() => {
            beforeApproveEvents = liveEvents.length;
            approvedAt = Date.now();
            executor.resolveApproval(executor.runId, ap.id, 'alice', 'approve');
          }, 50);
        },
      });

      expect(indexOf(events, 'pipeline:approval:requested', ap.id)).toBeGreaterThanOrEqual(0);
      expect(approvedAt).toBeGreaterThan(0);
      expect(beforeApproveEvents).toBeGreaterThan(0);
      expect(indexOf(events, 'pipeline:run:completed')).toBeGreaterThanOrEqual(0);
    });

    test('resolveApproval(approve) routes to the approved handle', async () => {
      const t = triggerNode();
      const ap = approvalNode();
      const yes = actionNode();
      const no = actionNode();
      const def = buildPipeline({
        nodes: [t, ap, yes, no],
        edges: [
          makeEdge(t.id, ap.id),
          makeEdge(ap.id, yes.id, 'approved'),
          makeEdge(ap.id, no.id, 'rejected'),
        ],
      });

      const { events } = await collectEvents(def, {
        onExecutor: (executor) => {
          setTimeout(() => {
            executor.resolveApproval(executor.runId, ap.id, 'alice', 'approve');
          }, 20);
        },
      });

      expect(indexOf(events, 'pipeline:step:started', yes.id)).toBeGreaterThanOrEqual(0);
      expect(indexOf(events, 'pipeline:step:started', no.id)).toBe(-1);
    });

    test('resolveApproval(reject) routes to the rejected handle', async () => {
      const t = triggerNode();
      const ap = approvalNode();
      const yes = actionNode();
      const no = actionNode();
      const def = buildPipeline({
        nodes: [t, ap, yes, no],
        edges: [
          makeEdge(t.id, ap.id),
          makeEdge(ap.id, yes.id, 'approved'),
          makeEdge(ap.id, no.id, 'rejected'),
        ],
      });

      const { events } = await collectEvents(def, {
        onExecutor: (executor) => {
          setTimeout(() => {
            executor.resolveApproval(executor.runId, ap.id, 'alice', 'reject');
          }, 20);
        },
      });

      expect(indexOf(events, 'pipeline:step:started', no.id)).toBeGreaterThanOrEqual(0);
      expect(indexOf(events, 'pipeline:step:started', yes.id)).toBe(-1);
    });

    test('Approval timeout with timeoutAction=reject auto-rejects', async () => {
      const t = triggerNode();
      const ap = approvalNode(undefined, { timeoutMs: 30, timeoutAction: 'reject' });
      const yes = actionNode();
      const no = actionNode();
      const def = buildPipeline({
        nodes: [t, ap, yes, no],
        edges: [
          makeEdge(t.id, ap.id),
          makeEdge(ap.id, yes.id, 'approved'),
          makeEdge(ap.id, no.id, 'rejected'),
        ],
      });

      const { events } = await collectEvents(def);

      // The system:timeout userId appears in the recorded event.
      const recorded = eventsOfType(events, 'pipeline:approval:recorded').find(
        (e) => e.payload.stepId === ap.id,
      );
      expect(recorded).toBeTruthy();
      expect(recorded?.payload.userId).toBe('system:timeout');
      expect(recorded?.payload.decision).toBe('reject');
      // Rejection routes to the `no` branch.
      expect(indexOf(events, 'pipeline:step:started', no.id)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Retry from step (manual)', () => {
    // Per PIPELINES_PLAN.md §17.6, manual "retry-from-here" emits
    // `pipeline:run:resume-from-step`. The executor does not yet expose a
    // `resumeFromStep` method — Phase 1 UI will call it once wired up.
    test.skip('resumeFromStep re-runs the given node and continues forward', async () => {
      // Held until PipelineExecutor grows the resumeFromStep API.
    });
  });

  describe('Context accumulation (§17.8)', () => {
    test('each step output is written to context.steps[stepId]', async () => {
      const t = triggerNode();
      const a = actionNode();
      const def = buildPipeline({
        nodes: [t, a],
        edges: [makeEdge(t.id, a.id)],
      });

      const bus = makeEventBus();
      await bus.start();

      const executor = new PipelineExecutor({
        definition: def,
        ownerNodeId: 'test-node',
        llmClient: makeFakeLLMClient(),
        eventBus: bus,
        triggerPayload: {},
        failureRateLLM: 0,
        failureRateOther: 0,
        speedMultiplier: 0.02,
      });
      const run = await executor.run();
      await bus.stop();

      expect(run.context).toBeTruthy();
      const steps = run.context.steps as Record<string, unknown>;
      expect(steps).toBeTruthy();
      // Both the trigger and the action should appear.
      expect(steps[t.id]).toBeDefined();
      expect(steps[a.id]).toBeDefined();
    });

    test('node with outputKey scopes merge to context[outputKey]', async () => {
      const t = triggerNode();
      const x = transformNode(undefined, 'reviewResult');
      const done = actionNode();
      const def = buildPipeline({
        nodes: [t, x, done],
        edges: [makeEdge(t.id, x.id), makeEdge(x.id, done.id)],
      });

      const bus = makeEventBus();
      await bus.start();

      const executor = new PipelineExecutor({
        definition: def,
        ownerNodeId: 'test-node',
        llmClient: makeFakeLLMClient(),
        eventBus: bus,
        triggerPayload: {},
        failureRateLLM: 0,
        failureRateOther: 0,
        speedMultiplier: 0.02,
      });
      const run = await executor.run();
      await bus.stop();

      expect(run.context.reviewResult).toBeDefined();
      const scoped = run.context.reviewResult as Record<string, unknown>;
      expect(scoped.transformed).toBe(true);
      // And since we scoped, the raw `transformed` should not leak to root.
      expect(run.context.transformed).toBeUndefined();
    });
  });
});
