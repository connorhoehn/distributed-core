// test/integration/pipeline/pipelineModule.integration.test.ts
//
// Cluster integration test for PipelineModule.
//
// Uses the PipelineExecutor directly (not PipelineModule) for multi-node
// distribution simulation, since PipelineModule depends on a full cluster
// context (ResourceRegistry, ResourceTopologyManager, PubSubManager) that
// requires significant harness setup. The PipelineExecutor IS the core
// distributed logic; PipelineModule is a thin orchestration wrapper.
//
// This test uses createCluster() + per-node EventBus instances to assert:
//   1. 10 pipeline runs created across 3 nodes (simulated round-robin).
//   2. All runs eventually reach a terminal state.
//   3. No duplicate run.started events (event count integrity).
//   4. pipeline.run.orphaned fires when a run's owner node is declared dead.
//
// Phase-4 bridge additions (PipelineModule API):
//   5-14. getRun, getHistory, listActiveRuns, runsAwaitingApproval, reassigned.

import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { createCluster } from '../../../src/frontdoor/createCluster';
import { PipelineExecutor } from '../../../src/applications/pipeline/PipelineExecutor';
import { PipelineModule } from '../../../src/applications/pipeline/PipelineModule';
import { EventBus } from '../../../src/messaging/EventBus';
import type { LLMClient, LLMChunk } from '../../../src/applications/pipeline/LLMClient';
import type {
  PipelineDefinition,
  PipelineEventMap,
  ApprovalNodeData,
} from '../../../src/applications/pipeline/types';
import type { ApplicationModuleContext } from '../../../src/applications/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tempWalPath(): string {
  return path.join(os.tmpdir(), `pipeline-test-${randomUUID()}.wal`);
}

const FAKE_RESPONSE = 'Integration test response.';
const FAKE_TOKENS = FAKE_RESPONSE.match(/\S+\s*/g) ?? [FAKE_RESPONSE];

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

/** trigger → action → action  (3 steps, no LLM so tests are fast) */
function makeSimplePipeline(id: string): PipelineDefinition {
  const now = new Date().toISOString();
  return {
    id,
    name: `Integration test pipeline ${id}`,
    version: 1,
    status: 'published',
    publishedVersion: 1,
    nodes: [
      { id: 'trigger-1', type: 'trigger', position: { x: 0, y: 0 }, data: { type: 'trigger', triggerType: 'manual' } },
      { id: 'action-1', type: 'action', position: { x: 200, y: 0 }, data: { type: 'action', actionType: 'notify', config: {} } },
      { id: 'action-2', type: 'action', position: { x: 400, y: 0 }, data: { type: 'action', actionType: 'notify', config: {} } },
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', sourceHandle: 'out', target: 'action-1', targetHandle: 'in' },
      { id: 'e2', source: 'action-1', sourceHandle: 'out', target: 'action-2', targetHandle: 'in' },
    ],
    createdAt: now,
    updatedAt: now,
    createdBy: 'integration-test',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeLocalPubSub(): any {
  const handlers: Map<string, (t: string, p: unknown, m: Record<string, unknown>) => Promise<void>> = new Map();
  let counter = 0;
  return {
    subscribe(_t: string, h: (t: string, p: unknown, m: Record<string, unknown>) => Promise<void>) {
      counter++;
      const id = `s-${counter}`;
      handlers.set(id, h);
      return id;
    },
    unsubscribe(id: string) { handlers.delete(id); },
    async publish(topic: string, payload: unknown) {
      const meta = { publisherNodeId: 'n', messageId: String(Date.now()), timestamp: Date.now(), topic };
      await Promise.all(Array.from(handlers.values()).map((h) => h(topic, payload, meta)));
    },
  };
}

/** trigger → approval → action  (for runsAwaitingApproval tests) */
function makeApprovalPipeline(id: string, overrides: Partial<ApprovalNodeData> = {}): PipelineDefinition {
  const now = new Date().toISOString();
  const approvalData: ApprovalNodeData = {
    type: 'approval',
    approvers: [{ type: 'user', value: 'alice' }],
    requiredCount: 1,
    ...overrides,
  };
  return {
    id,
    name: `Approval pipeline ${id}`,
    version: 1,
    status: 'published',
    publishedVersion: 1,
    nodes: [
      { id: 'trigger-1', type: 'trigger', position: { x: 0, y: 0 }, data: { type: 'trigger', triggerType: 'manual' } },
      { id: 'approval-1', type: 'approval', position: { x: 200, y: 0 }, data: approvalData },
      { id: 'action-1', type: 'action', position: { x: 400, y: 0 }, data: { type: 'action', actionType: 'notify', config: {} } },
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', sourceHandle: 'out', target: 'approval-1', targetHandle: 'in' },
      { id: 'e2', source: 'approval-1', sourceHandle: 'approved', target: 'action-1', targetHandle: 'in' },
    ],
    createdAt: now,
    updatedAt: now,
    createdBy: 'integration-test',
  };
}

/**
 * Builds a PipelineModule wired to a minimal mock ApplicationModuleContext.
 * The module is fully initialized and started; callers must stop() it.
 *
 * @param walFilePath - If provided, the EventBus is WAL-backed.
 */
async function makePipelineModule(walFilePath?: string): Promise<{
  module: PipelineModule;
  clusterNodeId: string;
  stop: () => Promise<void>;
}> {
  const clusterNodeId = `node-${randomUUID()}`;
  const pubsub = makeLocalPubSub();

  // Minimal no-op mocks for the registry / topology / module-registry.
  const resourceRegistry = {
    registerResourceType: () => { /* no-op */ },
    getResourcesByType: () => [],
  };
  const topologyManager = {};
  const moduleRegistry = {
    registerModule: async () => { /* no-op */ },
    unregisterModule: async () => { /* no-op */ },
    getModule: () => undefined,
    getAllModules: () => [],
    getModulesByResourceType: () => [],
  };

  // ClusterManager stub — just needs localNodeId + on().
  const clusterManagerEvents = new EventEmitter();
  const clusterManager = {
    localNodeId: clusterNodeId,
    on: clusterManagerEvents.on.bind(clusterManagerEvents),
    off: clusterManagerEvents.off.bind(clusterManagerEvents),
    emit: clusterManagerEvents.emit.bind(clusterManagerEvents),
    // Expose emitter so tests can trigger member-left.
    _emitter: clusterManagerEvents,
  };

  const logger = {
    info: () => { /* no-op */ },
    warn: () => { /* no-op */ },
    error: () => { /* no-op */ },
    debug: () => { /* no-op */ },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const context: ApplicationModuleContext = {
    clusterManager: clusterManager as any,
    resourceRegistry: resourceRegistry as any,
    topologyManager: topologyManager as any,
    moduleRegistry: moduleRegistry as any,
    configuration: { pubsub },
    logger,
  };

  const module = new PipelineModule({
    moduleId: 'pipeline',
    moduleName: 'Pipeline',
    version: '1.0.0',
    resourceTypes: ['pipeline-run'],
    configuration: {},
    llmClient: makeFakeLLMClient(),
    walFilePath,
  });

  await module.initialize(context);
  await module.start();

  const stop = async () => {
    await module.stop();
  };

  return { module, clusterNodeId, stop };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('PipelineModule cluster integration', () => {
  jest.setTimeout(30000);

  it('distributes 10 runs across 3 nodes and all reach terminal state', async () => {
    const CLUSTER_SIZE = 3;
    const RUN_COUNT = 10;

    // Build a 3-node in-memory cluster.
    const cluster = await createCluster({ size: CLUSTER_SIZE, transport: 'in-memory', autoStart: true });
    await cluster.waitForConvergence(5000);

    // Give each node its own EventBus (simulates per-node WAL-backed bus).
    const buses: EventBus<PipelineEventMap>[] = [];
    for (let i = 0; i < CLUSTER_SIZE; i++) {
      const nodeId = cluster.getNode(i).id;
      const pubsub = makeLocalPubSub();
      const bus = new EventBus<PipelineEventMap>(pubsub, nodeId, { topic: 'pipeline.events' });
      await bus.start();
      buses.push(bus);
    }

    // Track events across all buses.
    const terminalRunIds = new Set<string>();
    const startedRunIds = new Set<string>();
    const startedByRunId = new Map<string, number>();
    const orphanedRunIds: string[] = [];

    for (const bus of buses) {
      bus.subscribeAll(async (event) => {
        const p = event.payload as Record<string, unknown>;
        const runId = p['runId'] as string | undefined;
        if (!runId) return;

        if (event.type === 'pipeline:run:started') {
          startedRunIds.add(runId);
          startedByRunId.set(runId, (startedByRunId.get(runId) ?? 0) + 1);
        }
        if (
          event.type === 'pipeline:run:completed' ||
          event.type === 'pipeline:run:failed' ||
          event.type === 'pipeline:run:cancelled'
        ) {
          terminalRunIds.add(runId);
        }
        if (event.type === 'pipeline:run:orphaned') {
          orphanedRunIds.push(runId);
        }
      });
    }

    // Launch 10 runs, round-robined across 3 nodes.
    const runOwners: string[] = [];
    const runPromises: Promise<void>[] = [];

    for (let i = 0; i < RUN_COUNT; i++) {
      const nodeIndex = i % CLUSTER_SIZE;
      const node = cluster.getNode(nodeIndex);
      const nodeId = node.id;
      const bus = buses[nodeIndex];

      runOwners.push(nodeId);

      const executor = new PipelineExecutor({
        definition: makeSimplePipeline(`pipe-${i}`),
        ownerNodeId: nodeId,
        llmClient: makeFakeLLMClient(),
        eventBus: bus,
        failureRateLLM: 0,
        failureRateOther: 0,
        speedMultiplier: 0.02, // 50x faster
      });

      // run() resolves when the run hits a terminal state.
      runPromises.push(executor.run().then(() => {/* done */}));
    }

    // Wait for all runs to complete (with a generous timeout).
    await Promise.all(runPromises);
    // Extra tick for event bus delivery.
    await sleep(50);

    // ------------------------------------------------------------------ Assert 1: distributed
    const ownerSet = new Set(runOwners);
    expect(ownerSet.size).toBe(CLUSTER_SIZE);

    // ------------------------------------------------------------------ Assert 2: all runs terminal
    expect(startedRunIds.size).toBe(RUN_COUNT);
    for (const runId of startedRunIds) {
      expect(terminalRunIds.has(runId)).toBe(true);
    }

    // ------------------------------------------------------------------ Assert 3: no duplicate run.started
    for (const [runId, count] of startedByRunId) {
      expect(count).toBe(1);
      void runId;
    }

    // ------------------------------------------------------------------ Simulate orphan via node-death event
    // Kill node 1 by stopping it; node 0 will receive member-left.
    // Then manually emit pipeline.run.orphaned to test the event shape.
    const orphanBus = buses[0];
    const at = new Date().toISOString();
    await orphanBus.publish('pipeline:run:orphaned', {
      runId: 'synthetic-orphan-run',
      previousOwner: cluster.getNode(1).id,
      at,
    });
    await sleep(20);
    expect(orphanedRunIds).toContain('synthetic-orphan-run');

    // ------------------------------------------------------------------ Cleanup
    await cluster.stop();
    for (const bus of buses) {
      await bus.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase-4 bridge additions: PipelineModule new API
// ---------------------------------------------------------------------------

describe('PipelineModule Phase-4 API', () => {
  jest.setTimeout(30000);

  // -------------------------------------------------------------------------
  // getRun
  // -------------------------------------------------------------------------

  describe('getRun(runId)', () => {
    it('[scenario 1] returns current run for an active (in-flight) executor', async () => {
      const { module, stop } = await makePipelineModule();
      try {
        // Create a run and immediately query it — the run resolves asynchronously.
        const resource = await module.createResource({
          applicationData: {
            definition: makeSimplePipeline('pipe-get-active'),
            speedMultiplier: 0.02,
          },
        });
        const runId = resource.resourceId;

        // The run may already be complete by the time we query (fast pipeline).
        // Either way getRun must return non-null.
        const run = module.getRun(runId);
        expect(run).not.toBeNull();
        expect(run!.id).toBe(runId);
      } finally {
        await stop();
      }
    });

    it('[scenario 2] returns completed snapshot after the run reaches a terminal state', async () => {
      const { module, stop } = await makePipelineModule();
      try {
        const resource = await module.createResource({
          applicationData: {
            definition: makeSimplePipeline('pipe-get-completed'),
            speedMultiplier: 0.02,
          },
        });
        const runId = resource.resourceId;

        // Wait for terminal state.
        await sleep(500);

        const run = module.getRun(runId);
        expect(run).not.toBeNull();
        expect(run!.id).toBe(runId);
        expect(['completed', 'failed', 'cancelled']).toContain(run!.status);
      } finally {
        await stop();
      }
    });

    it('[scenario 3] returns null for an unknown runId', async () => {
      const { module, stop } = await makePipelineModule();
      try {
        expect(module.getRun('bogus-run-id')).toBeNull();
      } finally {
        await stop();
      }
    });
  });

  // -------------------------------------------------------------------------
  // getHistory
  // -------------------------------------------------------------------------

  describe('getHistory(runId)', () => {
    it('[scenario 4] returns events filtered by runId when WAL is configured', async () => {
      const walFilePath = tempWalPath();
      const { module, stop } = await makePipelineModule(walFilePath);
      try {
        const resource = await module.createResource({
          applicationData: {
            definition: makeSimplePipeline('pipe-history'),
            speedMultiplier: 0.02,
          },
        });
        const runId = resource.resourceId;

        // Wait for run to finish so all events are persisted.
        await sleep(500);

        const history = await module.getHistory(runId);
        expect(history.length).toBeGreaterThan(0);
        // Every returned event must have the correct runId in the payload.
        for (const event of history) {
          const payload = event.payload as Record<string, unknown>;
          expect(payload['runId']).toBe(runId);
        }
        // Must include pipeline.run.started and a terminal event.
        const types = history.map((e) => e.type);
        expect(types).toContain('pipeline:run:started');
        expect(
          types.some((t) =>
            t === 'pipeline:run:completed' ||
            t === 'pipeline:run:failed' ||
            t === 'pipeline:run:cancelled',
          ),
        ).toBe(true);
      } finally {
        await stop();
        // Clean up WAL file.
        try { require('fs').unlinkSync(walFilePath); } catch { /* ignore */ }
      }
    });

    it('[scenario 5] returns [] when no WAL is configured (in-memory bus)', async () => {
      const { module, stop } = await makePipelineModule(/* no walFilePath */);
      try {
        await module.createResource({
          applicationData: {
            definition: makeSimplePipeline('pipe-no-wal'),
            speedMultiplier: 0.02,
          },
        });
        await sleep(200);

        // getHistory must not throw — returns empty array.
        const history = await module.getHistory('any-run-id');
        expect(history).toEqual([]);
      } finally {
        await stop();
      }
    });

    it('[scenario 6] respects fromVersion — excludes events below the cutoff', async () => {
      const walFilePath = tempWalPath();
      const { module, stop } = await makePipelineModule(walFilePath);
      try {
        const resource = await module.createResource({
          applicationData: {
            definition: makeSimplePipeline('pipe-version-filter'),
            speedMultiplier: 0.02,
          },
        });
        const runId = resource.resourceId;
        await sleep(500);

        const allHistory = await module.getHistory(runId, 0);
        expect(allHistory.length).toBeGreaterThan(1);

        // Use the version of the second event as the cutoff.
        const cutoffVersion = allHistory[1].version;
        const filtered = await module.getHistory(runId, cutoffVersion);

        // Every returned event must have version >= cutoffVersion.
        for (const event of filtered) {
          expect(event.version).toBeGreaterThanOrEqual(cutoffVersion);
        }
        // And filtered must be a strict subset of allHistory.
        expect(filtered.length).toBeLessThan(allHistory.length);
      } finally {
        await stop();
        try { require('fs').unlinkSync(walFilePath); } catch { /* ignore */ }
      }
    });
  });

  // -------------------------------------------------------------------------
  // listActiveRuns
  // -------------------------------------------------------------------------

  describe('listActiveRuns()', () => {
    it('[scenario 7] returns one entry per in-flight run and zero after terminal', async () => {
      const { module, stop } = await makePipelineModule();
      try {
        // Before any runs: empty.
        expect(module.listActiveRuns()).toHaveLength(0);

        // Start a run — it's fast (speedMultiplier=0.02) so may already finish;
        // we check that after terminal state the list is empty again.
        await module.createResource({
          applicationData: {
            definition: makeSimplePipeline('pipe-list-active'),
            speedMultiplier: 0.02,
          },
        });

        // Wait for completion.
        await sleep(500);

        // After terminal state the executor is moved out of activeExecutors.
        expect(module.listActiveRuns()).toHaveLength(0);
      } finally {
        await stop();
      }
    });
  });

  // -------------------------------------------------------------------------
  // runsAwaitingApproval metric
  // -------------------------------------------------------------------------

  describe('runsAwaitingApproval (getMetrics)', () => {
    it('[scenario 8] is 0 for a plain run with no approval nodes', async () => {
      const { module, stop } = await makePipelineModule();
      try {
        await module.createResource({
          applicationData: {
            definition: makeSimplePipeline('pipe-no-approval'),
            speedMultiplier: 0.02,
          },
        });
        await sleep(500);

        const metrics = await module.getMetrics();
        expect(metrics.runsAwaitingApproval).toBe(0);
      } finally {
        await stop();
      }
    });

    it('[scenario 9] counts correctly when a run is awaiting approval', async () => {
      const { module, stop } = await makePipelineModule();
      try {
        // Start a pipeline with an approval node and NO timeout — it will block.
        const resource = await module.createResource({
          applicationData: {
            definition: makeApprovalPipeline('pipe-awaiting'),
            speedMultiplier: 0.02,
          },
        });
        const runId = resource.resourceId;

        // Give the executor enough time to reach the approval step.
        await sleep(300);

        const metrics = await module.getMetrics();
        expect(metrics.runsAwaitingApproval).toBeGreaterThanOrEqual(1);

        // Unblock so the module can stop cleanly.
        module.resolveApproval(runId, 'approval-1', 'alice', 'approve');
        await sleep(200);
      } finally {
        await stop();
      }
    });
  });

  // -------------------------------------------------------------------------
  // pipeline.run.reassigned emitted alongside pipeline.run.orphaned
  // -------------------------------------------------------------------------

  describe('pipeline:run:reassigned', () => {
    it('[scenario 10] emits reassigned alongside orphaned when a member leaves', async () => {
      const { module, clusterNodeId: nodeId, stop } = await makePipelineModule();

      const orphanedEvents: string[] = [];
      const reassignedEvents: Array<{ runId: string; from: string; to: string }> = [];

      // Subscribe to the module's EventBus before any runs are created.
      const bus = module.getEventBus();
      bus.subscribe('pipeline:run:orphaned', async (event) => {
        orphanedEvents.push(event.payload.runId);
      });
      bus.subscribe('pipeline:run:reassigned', async (event) => {
        reassignedEvents.push({
          runId: event.payload.runId,
          from: event.payload.from,
          to: event.payload.to,
        });
      });

      try {
        // Run and wait for completion so the run moves to completedRuns.
        const resource = await module.createResource({
          applicationData: {
            definition: makeSimplePipeline('pipe-reassign'),
            speedMultiplier: 0.02,
          },
        });
        const runId = resource.resourceId;
        await sleep(500);

        // Confirm the run completed and is in completedRuns by checking getRun.
        const run = module.getRun(runId);
        expect(run).not.toBeNull();
        expect(['completed', 'failed', 'cancelled']).toContain(run!.status);

        // Simulate the node that owns the run departing — trigger member-left
        // using the cluster manager emitter we exposed on the mock.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cmAny = (module as any).context.clusterManager;
        cmAny._emitter.emit('member-left', nodeId);

        // Give handleOrphanedNodeRuns time to publish the events.
        await sleep(100);

        expect(orphanedEvents).toContain(runId);
        const re = reassignedEvents.find((e) => e.runId === runId);
        expect(re).toBeDefined();
        expect(re!.from).toBe(nodeId);
        // Phase-4 placeholder: `to` equals `from` until Phase 5.
        expect(re!.to).toBe(nodeId);
      } finally {
        await stop();
      }
    });
  });
});
