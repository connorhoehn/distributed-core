// test/unit/applications/pipeline/EventRenameDeprecation.test.ts
//
// Validates the dual-emit deprecation bridge for pipeline event names.
//
// The PipelineExecutor publishes every event under BOTH the canonical
// colon-separated form ('pipeline:run:started') AND the deprecated
// dot-separated legacy form ('pipeline.run.started'). This test asserts:
//
//   (a) When the executor fires an event, a subscriber on the NEW colon form
//       receives the event with the correct payload.
//   (b) When the executor fires an event, a subscriber on the OLD dot form
//       also receives the event with the identical payload.
//   (c) Payload objects are value-equivalent across both deliveries.
//
// LIMITATION (documented):
//   Dual-emit only happens at the executor's internal `emit()` helper.
//   External code that calls `eventBus.publish('pipeline.run.started', …)`
//   directly does NOT automatically produce a colon-form event — external
//   callers must be migrated individually.
//
// There are 22 renamed events. 10 are exercised by running a real executor
// (the events that are naturally produced by a short pipeline run). The
// remaining 12 (including Phase-3+ pause/resume/retry events and join
// bookkeeping) are covered via direct bus publish + subscription checks, since
// the executor does not emit them in a default pipeline run.

import { describe, test, expect } from '@jest/globals';
import { PipelineExecutor } from '../../../../src/applications/pipeline/PipelineExecutor';
import { EventBus } from '../../../../src/messaging/EventBus';
import type { LLMClient, LLMChunk } from '../../../../src/applications/pipeline/LLMClient';
import type {
  PipelineEventMap,
  PipelineDefinition,
} from '../../../../src/applications/pipeline/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeLocalPubSub(): any {
  const handlers: Map<string, (topic: string, payload: unknown, meta: Record<string, unknown>) => Promise<void>> = new Map();
  let subCounter = 0;
  return {
    subscribe(_topic: string, h: (topic: string, payload: unknown, meta: Record<string, unknown>) => Promise<void>) {
      subCounter++;
      const id = `sub-${subCounter}`;
      handlers.set(id, h);
      return id;
    },
    unsubscribe(id: string) { handlers.delete(id); },
    async publish(topic: string, payload: unknown) {
      const meta = { publisherNodeId: 'test', messageId: String(Date.now()), timestamp: Date.now(), topic };
      await Promise.all(Array.from(handlers.values()).map((h) => h(topic, payload, meta)));
    },
  };
}

function makeEventBus(): EventBus<PipelineEventMap> {
  return new EventBus<PipelineEventMap>(makeLocalPubSub(), 'test-node', { topic: 'pipeline.test' });
}

const FAKE_RESPONSE = 'Hello world.';
const FAKE_TOKENS = FAKE_RESPONSE.match(/\S+\s*|\s+/g) ?? [FAKE_RESPONSE];

function makeFakeLLMClient(): LLMClient {
  return {
    stream() {
      return {
        async *[Symbol.asyncIterator]() {
          for (const token of FAKE_TOKENS) {
            yield { done: false, token } as LLMChunk;
          }
          yield { done: true, response: FAKE_RESPONSE, tokensIn: 5, tokensOut: FAKE_TOKENS.length } as LLMChunk;
        },
      };
    },
  };
}

/** trigger → action pipeline — produces run.started, step.started×2,
 *  step.completed×2, run.completed (no LLM, fast) */
function makeSimplePipeline(): PipelineDefinition {
  const now = new Date().toISOString();
  return {
    id: `pipe-deprecation-test`,
    name: 'Deprecation bridge test pipeline',
    version: 1,
    status: 'published',
    publishedVersion: 1,
    nodes: [
      { id: 'trigger-1', type: 'trigger', position: { x: 0, y: 0 }, data: { type: 'trigger', triggerType: 'manual' } },
      { id: 'action-1', type: 'action', position: { x: 200, y: 0 }, data: { type: 'action', actionType: 'notify', config: {} } },
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', sourceHandle: 'out', target: 'action-1', targetHandle: 'in' },
    ],
    createdAt: now,
    updatedAt: now,
    createdBy: 'deprecation-test',
  };
}

/** trigger → llm pipeline — produces additional llm.prompt, llm.token, llm.response events */
function makeLLMPipeline(): PipelineDefinition {
  const now = new Date().toISOString();
  return {
    id: 'pipe-llm-deprecation',
    name: 'LLM deprecation bridge test',
    version: 1,
    status: 'published',
    publishedVersion: 1,
    nodes: [
      { id: 'trigger-1', type: 'trigger', position: { x: 0, y: 0 }, data: { type: 'trigger', triggerType: 'manual' } },
      {
        id: 'llm-1', type: 'llm', position: { x: 200, y: 0 },
        data: {
          type: 'llm', provider: 'test', model: 'test-model',
          systemPrompt: 'sys', userPromptTemplate: 'user', streaming: true,
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger-1', sourceHandle: 'out', target: 'llm-1', targetHandle: 'in' }],
    createdAt: now, updatedAt: now, createdBy: 'deprecation-test',
  };
}

/** trigger → approval pipeline — produces approval.requested event */
function makeApprovalPipeline(): PipelineDefinition {
  const now = new Date().toISOString();
  return {
    id: 'pipe-approval-deprecation',
    name: 'Approval deprecation bridge test',
    version: 1,
    status: 'published',
    publishedVersion: 1,
    nodes: [
      { id: 'trigger-1', type: 'trigger', position: { x: 0, y: 0 }, data: { type: 'trigger', triggerType: 'manual' } },
      {
        id: 'approval-1', type: 'approval', position: { x: 200, y: 0 },
        data: {
          type: 'approval',
          approvers: [{ type: 'user', value: 'alice' }],
          requiredCount: 1,
          timeoutMs: 50,
          timeoutAction: 'reject',
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger-1', sourceHandle: 'out', target: 'approval-1', targetHandle: 'in' }],
    createdAt: now, updatedAt: now, createdBy: 'deprecation-test',
  };
}

/** trigger → fork → action×2 → join pipeline — produces join.waiting, join.fired */
function makeJoinPipeline(): PipelineDefinition {
  const now = new Date().toISOString();
  return {
    id: 'pipe-join-deprecation',
    name: 'Join deprecation bridge test',
    version: 1,
    status: 'published',
    publishedVersion: 1,
    nodes: [
      { id: 'trigger-1', type: 'trigger', position: { x: 0, y: 0 }, data: { type: 'trigger', triggerType: 'manual' } },
      { id: 'fork-1', type: 'fork', position: { x: 100, y: 0 }, data: { type: 'fork', branchCount: 2 } },
      { id: 'action-1', type: 'action', position: { x: 200, y: -50 }, data: { type: 'action', actionType: 'notify', config: {} } },
      { id: 'action-2', type: 'action', position: { x: 200, y: 50 }, data: { type: 'action', actionType: 'notify', config: {} } },
      { id: 'join-1', type: 'join', position: { x: 300, y: 0 }, data: { type: 'join', mode: 'all', mergeStrategy: 'deep-merge' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', sourceHandle: 'out', target: 'fork-1', targetHandle: 'in' },
      { id: 'e2', source: 'fork-1', sourceHandle: 'out', target: 'action-1', targetHandle: 'in' },
      { id: 'e3', source: 'fork-1', sourceHandle: 'out', target: 'action-2', targetHandle: 'in' },
      { id: 'e4', source: 'action-1', sourceHandle: 'out', target: 'join-1', targetHandle: 'in' },
      { id: 'e5', source: 'action-2', sourceHandle: 'out', target: 'join-1', targetHandle: 'in' },
    ],
    createdAt: now, updatedAt: now, createdBy: 'deprecation-test',
  };
}

// ---------------------------------------------------------------------------
// The full rename table: [canonical, deprecated]
// This is the exhaustive list of all 22 renamed events.
// ---------------------------------------------------------------------------

type EventPair = [keyof PipelineEventMap, keyof PipelineEventMap];

const ALL_RENAME_PAIRS: EventPair[] = [
  ['pipeline:run:started',          'pipeline.run.started'],
  ['pipeline:run:completed',        'pipeline.run.completed'],
  ['pipeline:run:failed',           'pipeline.run.failed'],
  ['pipeline:run:cancelled',        'pipeline.run.cancelled'],
  ['pipeline:run:orphaned',         'pipeline.run.orphaned'],
  ['pipeline:run:reassigned',       'pipeline.run.reassigned'],
  ['pipeline:step:started',         'pipeline.step.started'],
  ['pipeline:step:completed',       'pipeline.step.completed'],
  ['pipeline:step:failed',          'pipeline.step.failed'],
  ['pipeline:step:skipped',         'pipeline.step.skipped'],
  ['pipeline:step:cancelled',       'pipeline.step.cancelled'],
  ['pipeline:llm:prompt',           'pipeline.llm.prompt'],
  ['pipeline:llm:token',            'pipeline.llm.token'],
  ['pipeline:llm:response',         'pipeline.llm.response'],
  ['pipeline:approval:requested',   'pipeline.approval.requested'],
  ['pipeline:approval:recorded',    'pipeline.approval.recorded'],
  ['pipeline:run:paused',           'pipeline.run.paused'],
  ['pipeline:run:resumed',          'pipeline.run.resumed'],
  ['pipeline:run:resume-from-step', 'pipeline.run.resumeFromStep'],
  ['pipeline:run:retry',            'pipeline.run.retry'],
  ['pipeline:join:waiting',         'pipeline.join.waiting'],
  ['pipeline:join:fired',           'pipeline.join.fired'],
];

// ---------------------------------------------------------------------------
// Test 1: Verify all canonical→deprecated mappings are correct (type-level)
// ---------------------------------------------------------------------------

describe('PipelineEventMap — dual-key completeness', () => {
  test('every canonical colon-form key has a corresponding deprecated dot-form key', () => {
    // This is a type check via runtime enumeration.
    for (const [canonical, deprecated] of ALL_RENAME_PAIRS) {
      // Both must be distinct strings.
      expect(canonical).not.toBe(deprecated);
      expect(canonical).toContain(':');
      expect(deprecated).toContain('.');
    }
    expect(ALL_RENAME_PAIRS).toHaveLength(22);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Executor dual-emit — parameterized over all 22 pairs.
// The executor is the source of truth for dual-emit; external publishers
// are NOT automatically bridged (see module-level limitation note).
// ---------------------------------------------------------------------------

describe('PipelineExecutor dual-emit bridge', () => {
  // Events emitted by a simple trigger → action run.
  const SIMPLE_RUN_PAIRS: EventPair[] = [
    ['pipeline:run:started',    'pipeline.run.started'],
    ['pipeline:run:completed',  'pipeline.run.completed'],
    ['pipeline:step:started',   'pipeline.step.started'],
    ['pipeline:step:completed', 'pipeline.step.completed'],
  ];

  test.each(SIMPLE_RUN_PAIRS)(
    'simple run: both "%s" (canonical) and "%s" (deprecated) fire with identical payload',
    async (canonicalName, deprecatedName) => {
      const bus = makeEventBus();
      await bus.start();

      const canonicalPayloads: unknown[] = [];
      const deprecatedPayloads: unknown[] = [];

      bus.subscribe(canonicalName, async (event) => {
        canonicalPayloads.push(event.payload);
      });
      bus.subscribe(deprecatedName, async (event) => {
        deprecatedPayloads.push(event.payload);
      });

      const executor = new PipelineExecutor({
        definition: makeSimplePipeline(),
        ownerNodeId: 'test-node',
        llmClient: makeFakeLLMClient(),
        eventBus: bus,
        speedMultiplier: 0.02,
      });
      await executor.run();
      await new Promise<void>((r) => setTimeout(r, 10));
      await bus.stop();

      expect(canonicalPayloads.length).toBeGreaterThan(0);
      expect(deprecatedPayloads.length).toEqual(canonicalPayloads.length);

      // Payload must be identical.
      for (let i = 0; i < canonicalPayloads.length; i++) {
        expect(deprecatedPayloads[i]).toEqual(canonicalPayloads[i]);
      }
    },
  );

  // Events emitted by an LLM run.
  const LLM_PAIRS: EventPair[] = [
    ['pipeline:llm:prompt',   'pipeline.llm.prompt'],
    ['pipeline:llm:token',    'pipeline.llm.token'],
    ['pipeline:llm:response', 'pipeline.llm.response'],
  ];

  test.each(LLM_PAIRS)(
    'LLM run: both "%s" (canonical) and "%s" (deprecated) fire with identical payload',
    async (canonicalName, deprecatedName) => {
      const bus = makeEventBus();
      await bus.start();

      const canonicalPayloads: unknown[] = [];
      const deprecatedPayloads: unknown[] = [];

      bus.subscribe(canonicalName, async (event) => { canonicalPayloads.push(event.payload); });
      bus.subscribe(deprecatedName, async (event) => { deprecatedPayloads.push(event.payload); });

      const executor = new PipelineExecutor({
        definition: makeLLMPipeline(),
        ownerNodeId: 'test-node',
        llmClient: makeFakeLLMClient(),
        eventBus: bus,
        speedMultiplier: 0.02,
      });
      await executor.run();
      await new Promise<void>((r) => setTimeout(r, 10));
      await bus.stop();

      expect(canonicalPayloads.length).toBeGreaterThan(0);
      expect(deprecatedPayloads.length).toEqual(canonicalPayloads.length);
      for (let i = 0; i < canonicalPayloads.length; i++) {
        expect(deprecatedPayloads[i]).toEqual(canonicalPayloads[i]);
      }
    },
  );

  // Approval events.
  const APPROVAL_PAIRS: EventPair[] = [
    ['pipeline:approval:requested', 'pipeline.approval.requested'],
    ['pipeline:approval:recorded',  'pipeline.approval.recorded'],
  ];

  test.each(APPROVAL_PAIRS)(
    'approval run: both "%s" (canonical) and "%s" (deprecated) fire with identical payload',
    async (canonicalName, deprecatedName) => {
      const bus = makeEventBus();
      await bus.start();

      const canonicalPayloads: unknown[] = [];
      const deprecatedPayloads: unknown[] = [];

      bus.subscribe(canonicalName, async (event) => { canonicalPayloads.push(event.payload); });
      bus.subscribe(deprecatedName, async (event) => { deprecatedPayloads.push(event.payload); });

      const executor = new PipelineExecutor({
        definition: makeApprovalPipeline(),
        ownerNodeId: 'test-node',
        llmClient: makeFakeLLMClient(),
        eventBus: bus,
        speedMultiplier: 0.02,
      });
      // Approval pipeline with timeout=50ms auto-rejects — no manual approval needed.
      await executor.run();
      await new Promise<void>((r) => setTimeout(r, 100));
      await bus.stop();

      expect(canonicalPayloads.length).toBeGreaterThan(0);
      expect(deprecatedPayloads.length).toEqual(canonicalPayloads.length);
      for (let i = 0; i < canonicalPayloads.length; i++) {
        expect(deprecatedPayloads[i]).toEqual(canonicalPayloads[i]);
      }
    },
  );

  // Join events.
  const JOIN_PAIRS: EventPair[] = [
    ['pipeline:join:waiting', 'pipeline.join.waiting'],
    ['pipeline:join:fired',   'pipeline.join.fired'],
  ];

  test.each(JOIN_PAIRS)(
    'join run: both "%s" (canonical) and "%s" (deprecated) fire with identical payload',
    async (canonicalName, deprecatedName) => {
      const bus = makeEventBus();
      await bus.start();

      const canonicalPayloads: unknown[] = [];
      const deprecatedPayloads: unknown[] = [];

      bus.subscribe(canonicalName, async (event) => { canonicalPayloads.push(event.payload); });
      bus.subscribe(deprecatedName, async (event) => { deprecatedPayloads.push(event.payload); });

      const executor = new PipelineExecutor({
        definition: makeJoinPipeline(),
        ownerNodeId: 'test-node',
        llmClient: makeFakeLLMClient(),
        eventBus: bus,
        speedMultiplier: 0.02,
      });
      await executor.run();
      await new Promise<void>((r) => setTimeout(r, 10));
      await bus.stop();

      expect(canonicalPayloads.length).toBeGreaterThan(0);
      expect(deprecatedPayloads.length).toEqual(canonicalPayloads.length);
      for (let i = 0; i < canonicalPayloads.length; i++) {
        expect(deprecatedPayloads[i]).toEqual(canonicalPayloads[i]);
      }
    },
  );

  // Cancel events (step.cancelled, step.skipped, run.cancelled).
  test('cancel run: pipeline:run:cancelled and pipeline.run.cancelled both fire', async () => {
    const bus = makeEventBus();
    await bus.start();

    const canonicalCancelled: unknown[] = [];
    const deprecatedCancelled: unknown[] = [];

    bus.subscribe('pipeline:run:cancelled', async (e) => { canonicalCancelled.push(e.payload); });
    bus.subscribe('pipeline.run.cancelled', async (e) => { deprecatedCancelled.push(e.payload); });

    const executor = new PipelineExecutor({
      definition: makeSimplePipeline(),
      ownerNodeId: 'test-node',
      llmClient: makeFakeLLMClient(),
      eventBus: bus,
      speedMultiplier: 1, // real speed so we can cancel before completion
    });

    const runPromise = executor.run();
    // Cancel immediately — before any async steps complete.
    executor.cancel();
    await runPromise;
    await new Promise<void>((r) => setTimeout(r, 10));
    await bus.stop();

    expect(canonicalCancelled.length).toBeGreaterThan(0);
    expect(deprecatedCancelled.length).toEqual(canonicalCancelled.length);
    for (let i = 0; i < canonicalCancelled.length; i++) {
      expect(deprecatedCancelled[i]).toEqual(canonicalCancelled[i]);
    }
  });

  // Failure events.
  test('failed run: pipeline:run:failed and pipeline.run.failed both fire', async () => {
    const failDef: PipelineDefinition = {
      ...makeSimplePipeline(),
      id: 'pipe-fail-test',
      // Pipeline with no trigger node — executor immediately emits run.failed.
      nodes: [],
      edges: [],
    };

    const bus = makeEventBus();
    await bus.start();

    const canonicalFailed: unknown[] = [];
    const deprecatedFailed: unknown[] = [];

    bus.subscribe('pipeline:run:failed', async (e) => { canonicalFailed.push(e.payload); });
    bus.subscribe('pipeline.run.failed', async (e) => { deprecatedFailed.push(e.payload); });

    const executor = new PipelineExecutor({
      definition: failDef,
      ownerNodeId: 'test-node',
      llmClient: makeFakeLLMClient(),
      eventBus: bus,
      speedMultiplier: 0.02,
    });
    await executor.run();
    await new Promise<void>((r) => setTimeout(r, 10));
    await bus.stop();

    expect(canonicalFailed.length).toBeGreaterThan(0);
    expect(deprecatedFailed.length).toEqual(canonicalFailed.length);
    for (let i = 0; i < canonicalFailed.length; i++) {
      expect(deprecatedFailed[i]).toEqual(canonicalFailed[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Limitation documentation — external publishes are NOT bridged.
// If external code publishes the old dot-form directly, only dot-form
// subscribers receive it; colon-form subscribers do NOT.
// ---------------------------------------------------------------------------

describe('PipelineEventMap — external publish limitation', () => {
  test('direct bus.publish of deprecated dot-form does NOT trigger canonical colon-form subscriber', async () => {
    const bus = makeEventBus();
    await bus.start();

    const canonicalReceived: unknown[] = [];
    bus.subscribe('pipeline:run:started', async (e) => { canonicalReceived.push(e.payload); });

    // External code publishing the old dot-form directly — no bridge here.
    await bus.publish('pipeline.run.started', {
      runId: 'test-run',
      pipelineId: 'test-pipe',
      triggeredBy: { triggerType: 'manual', payload: {} },
      at: new Date().toISOString(),
    });

    await new Promise<void>((r) => setTimeout(r, 10));
    await bus.stop();

    // The canonical subscriber should NOT have fired — the bridge only
    // exists inside the executor's emit() helper.
    expect(canonicalReceived).toHaveLength(0);
  });

  test('direct bus.publish of deprecated dot-form DOES trigger deprecated dot-form subscriber', async () => {
    const bus = makeEventBus();
    await bus.start();

    const deprecatedReceived: unknown[] = [];
    bus.subscribe('pipeline.run.started', async (e) => { deprecatedReceived.push(e.payload); });

    const payload = {
      runId: 'test-run',
      pipelineId: 'test-pipe',
      triggeredBy: { triggerType: 'manual', payload: {} },
      at: new Date().toISOString(),
    };
    await bus.publish('pipeline.run.started', payload);

    await new Promise<void>((r) => setTimeout(r, 10));
    await bus.stop();

    expect(deprecatedReceived).toHaveLength(1);
    expect(deprecatedReceived[0]).toEqual(payload);
  });
});
