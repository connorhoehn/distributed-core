#!/usr/bin/env node
// examples/pipelines/trigger-and-watch.ts
//
// Runnable demo: bootstraps a 3-node cluster, triggers one pipeline run on
// node-0, streams every event to stdout, then prints the final run state.
//
// Run with:
//   npx ts-node examples/pipelines/trigger-and-watch.ts
//
// Expected output (truncated):
//   Cluster ready: 3 nodes
//   [pipeline:run:started] {"runId":"...","pipelineId":"demo-pipeline",...}
//   [pipeline:step:started] {"runId":"...","stepId":"trigger-1",...}
//   [pipeline:step:completed] ...
//   [pipeline:llm:prompt] ...
//   [pipeline:llm:token] ...
//   [pipeline:llm:response] ...
//   [pipeline:step:started] {"runId":"...","stepId":"action-1",...}
//   [pipeline:step:completed] ...
//   [pipeline:run:completed] {"runId":"...","durationMs":...}
//   Run started: <runId>
//   Done. Final state: { id: "...", status: "completed", ... }
//
// Note: the executor dual-emits events in both canonical colon form
// (pipeline:run:started) and legacy dot form (pipeline.run.started).
// The subscribeAll listener below will print BOTH — that is expected.

import { bootstrapPipelineCluster } from './cluster-bootstrap';
import type { PipelineDefinition } from '../../src/applications/pipeline/types';

// ---------------------------------------------------------------------------
// Pipeline definition: trigger → llm → action
//
// Three nodes, minimal config. The llm node uses FixtureLLMClient, so no
// real API key is needed. speedMultiplier is set very low so the demo
// finishes in under 2 seconds.
// ---------------------------------------------------------------------------

const definition: PipelineDefinition = {
  id:   'demo-pipeline',
  name: 'Demo: Trigger → LLM → Action',
  version: 1,
  status: 'published',
  publishedVersion: 1,
  createdAt:  new Date().toISOString(),
  updatedAt:  new Date().toISOString(),
  createdBy: 'demo',
  nodes: [
    {
      id: 'trigger-1',
      type: 'trigger',
      position: { x: 0, y: 0 },
      data: { type: 'trigger', triggerType: 'manual' },
    },
    {
      id: 'llm-1',
      type: 'llm',
      position: { x: 200, y: 0 },
      data: {
        type:               'llm',
        provider:           'fixture',
        model:              'fixture-model',
        systemPrompt:       'You are a helpful assistant.',
        userPromptTemplate: 'Summarize: {{context.user}}',
        streaming:          true,
      },
    },
    {
      id: 'action-1',
      type: 'action',
      position: { x: 400, y: 0 },
      data: {
        type:       'action',
        actionType: 'notify',
        config:     { channel: 'demo' },
      },
    },
  ],
  edges: [
    { id: 'e1', source: 'trigger-1', sourceHandle: 'out',  target: 'llm-1',    targetHandle: 'in' },
    { id: 'e2', source: 'llm-1',     sourceHandle: 'out',  target: 'action-1', targetHandle: 'in' },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = Date.now();
function ts(): string {
  return `+${((Date.now() - T0) / 1000).toFixed(2)}s`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Spin up a 3-node cluster with FixtureLLMClient pre-loaded.
  //
  //    speedMultiplier is injected at createResource() time (not at
  //    bootstrapPipelineCluster() time), so we set it there below.
  // -------------------------------------------------------------------------
  const { nodes, shutdown } = await bootstrapPipelineCluster({
    nodeCount:    3,
    llmResponses: ['Hello from the demo pipeline.'],
  });
  console.log(`[${ts()}] Cluster ready: ${nodes.length} nodes`);

  const owner = nodes[0];

  // -------------------------------------------------------------------------
  // 2. Subscribe to ALL pipeline events on the owner node's EventBus.
  //
  //    subscribeAll() receives every event that passes through the bus,
  //    regardless of type. The executor dual-emits each event in BOTH
  //    canonical colon form (pipeline:run:started) and legacy dot form
  //    (pipeline.run.started) — you will see both in the output.
  //    That is correct behaviour during the deprecation window.
  // -------------------------------------------------------------------------
  owner.module.getEventBus().subscribeAll(async (event) => {
    const snippet = JSON.stringify(event.payload).slice(0, 120);
    console.log(`[${ts()}] [${event.type}] ${snippet}`);
  });

  // -------------------------------------------------------------------------
  // 3. Trigger the pipeline run.
  //
  //    createResource() is fire-and-forget: it starts the executor and
  //    returns immediately. The run progresses asynchronously; events fire
  //    on the EventBus as each step completes.
  //
  //    speedMultiplier: 0.02 → ~50x faster than realistic timing. With
  //    simulated step delays this keeps the demo well under 5 seconds.
  // -------------------------------------------------------------------------
  const resource = await owner.module.createResource({
    applicationData: {
      definition,
      triggerPayload:  { user: 'demo' },
      speedMultiplier: 0.02,
    },
  });

  const runId = (resource.applicationData as Record<string, unknown>)['runId'] as string;
  console.log(`[${ts()}] Run started: ${runId}`);

  // -------------------------------------------------------------------------
  // 4. Wait for a terminal state event.
  //
  //    We race all three terminal events; whichever fires first resolves
  //    the promise. Using the canonical colon-form names.
  // -------------------------------------------------------------------------
  const eventBus = owner.module.getEventBus();

  await new Promise<void>((resolve) => {
    // Subscribe to each terminal event type individually (subscribeAll is
    // for observability only; we want reliable per-type callbacks here).
    const done = (): void => resolve();
    eventBus.subscribe('pipeline:run:completed', async (ev) => {
      if ((ev.payload as Record<string, unknown>)['runId'] === runId) done();
    });
    eventBus.subscribe('pipeline:run:failed', async (ev) => {
      if ((ev.payload as Record<string, unknown>)['runId'] === runId) done();
    });
    eventBus.subscribe('pipeline:run:cancelled', async (ev) => {
      if ((ev.payload as Record<string, unknown>)['runId'] === runId) done();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Print final state.
  //
  //    getRun() returns the completed PipelineRun snapshot from the module's
  //    in-memory store. Active runs are in activeExecutors; completed runs
  //    are moved to completedRuns when the terminal event fires.
  // -------------------------------------------------------------------------
  console.log(`\n[${ts()}] Done. Final state:`);
  console.log(JSON.stringify(owner.module.getRun(runId), null, 2));

  // -------------------------------------------------------------------------
  // 6. Graceful shutdown.
  // -------------------------------------------------------------------------
  await shutdown();
  console.log(`[${ts()}] Cluster stopped.`);

  // The in-memory cluster leaves open gossip timers that prevent the Node.js
  // event loop from draining naturally. An explicit exit is the correct
  // pattern for demos — in a real service the process lifecycle is managed
  // externally.
  process.exit(0);
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
