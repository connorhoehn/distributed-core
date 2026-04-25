// examples/pipelines/cluster-bootstrap.ts
//
// Reusable helper that bootstraps an N-node in-process cluster with a
// PipelineModule registered on every node.
//
// DESIGN NOTE — why not just call `createCluster()` and use the returned
// NodeHandles directly?
//
// `createCluster()` gives us real ClusterManagers and real PubSubManagers
// (from each NodeHandle.getCluster() / NodeHandle.getPubSub()). That is
// genuinely useful — we use it here for the cluster layer.
//
// The friction is that `ApplicationModuleContext` (the 6-field object that
// PipelineModule.initialize() receives) is NOT auto-constructed by
// createCluster(). The caller must build it by hand. That wiring is:
//
//   1. clusterManager  → nodeHandle.getCluster()           (real ClusterManager)
//   2. resourceRegistry→ minimal stub { registerResourceType, getResourcesByType }
//   3. topologyManager → empty stub {}
//   4. moduleRegistry  → minimal stub that satisfies ApplicationRegistry interface
//   5. configuration   → { pubsub: nodeHandle.getPubSub() }   ← CRITICAL
//   6. logger          → console-backed object
//
// Field 5 is the non-obvious one: PipelineModule reads
// `context.configuration['pubsub']` in onInitialize() to create its
// internal EventBus. It is NOT passed as a top-level context field.
//
// If a future `node.applications.register(module)` helper is ever added,
// it should auto-construct this context so callers don't have to.
//
// See also: test/integration/pipeline/pipelineModule.integration.test.ts
//            — makePipelineModule() is the canonical reference for this wiring.

import { EventEmitter } from 'events';
import { createCluster } from '../../src/frontdoor/createCluster';
import { NodeHandle } from '../../src/frontdoor/NodeHandle';
import { ClusterManager } from '../../src/cluster/ClusterManager';
import { PubSubManager } from '../../src/gateway/pubsub/PubSubManager';
import { PipelineModule } from '../../src/applications/pipeline/PipelineModule';
import { FixtureLLMClient } from '../../src/applications/pipeline/LLMClient';
import type { ApplicationModuleContext } from '../../src/applications/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One node's slice of the bootstrapped cluster.
 *
 * - `nodeId`  — stable identifier that matches the cluster membership table
 * - `module`  — started PipelineModule; use module.createResource() to kick off runs
 * - `pubsub`  — the node's PubSubManager (backing the module's EventBus)
 * - `cluster` — the node's ClusterManager (provides localNodeId, membership, events)
 * - `handle`  — raw NodeHandle for advanced cluster operations
 */
export interface PipelineClusterNode {
  nodeId: string;
  module: PipelineModule;
  pubsub: PubSubManager;
  cluster: ClusterManager;
  handle: NodeHandle;
}

// ---------------------------------------------------------------------------
// Bootstrap options
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  /** Number of cluster nodes to spin up. Default: 3. */
  nodeCount?: number;
  /**
   * Scripted LLM responses for the FixtureLLMClient.
   * The Nth `llm` step call returns responses[N % length]. Default: ['Demo response.']
   */
  llmResponses?: string[];
  /**
   * WAL file path for the pipeline EventBus on each node.
   * Pass a per-node path if you want durability; omit for in-memory only.
   * Default: undefined (in-memory).
   */
  walFilePath?: string;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Spin up an in-process N-node cluster with PipelineModule registered on
 * each node. Returns the per-node handles and a shutdown() function.
 *
 * Usage:
 *
 *   const { nodes, shutdown } = await bootstrapPipelineCluster({
 *     llmResponses: ['Hello from the demo pipeline.'],
 *   });
 *   const owner = nodes[0];
 *   // ...do work on owner.module...
 *   await shutdown();
 */
export async function bootstrapPipelineCluster(opts: BootstrapOptions = {}): Promise<{
  nodes: PipelineClusterNode[];
  shutdown: () => Promise<void>;
}> {
  const nodeCount = opts.nodeCount ?? 3;
  const llmResponses = opts.llmResponses ?? ['Demo response.'];

  // Hold the Node event loop open BEFORE awaiting cluster setup.
  //
  // Every internal cluster timer (gossip, heartbeat, transport polling) is
  // `.unref()`'d so that an embedding service's HTTP/socket lifetime drives
  // the process — not the cluster. That is correct for embedded use, but a
  // bare `await` in a script (no HTTP server, no readline) will see Node
  // drain and exit silently before createCluster() even resolves.
  //
  // We hold one ref'd timer here for the duration of the cluster's life;
  // shutdown() clears it. Demos and one-shot CLIs work without surprises.
  const keepAlive = setInterval(() => { /* hold the event loop */ }, 1 << 30);

  // -------------------------------------------------------------------------
  // Step 1 — Create a real in-process cluster.
  //
  // createCluster() pre-wires seed nodes so that all nodes discover each
  // other automatically after start(). autoStart: true means start() + the
  // internal gossip loop are called for us.
  // -------------------------------------------------------------------------
  const clusterHandle = await createCluster({
    size: nodeCount,
    transport: 'in-memory',
    autoStart: true,
  });

  // Wait until every node can see every other node in its membership table.
  await clusterHandle.waitForConvergence(5000);

  // -------------------------------------------------------------------------
  // Step 2 — Wire a PipelineModule on each node.
  //
  // This is the boilerplate that a future auto-wire helper could hide, but
  // we show it explicitly here so readers see exactly what is required.
  // -------------------------------------------------------------------------
  const pipelineNodes: PipelineClusterNode[] = [];

  for (let i = 0; i < nodeCount; i++) {
    const handle = clusterHandle.getNode(i);
    const clusterMgr = handle.getCluster();
    const pubsub = handle.getPubSub();
    const nodeId = handle.id;

    // -- Field 2: ResourceRegistry stub --
    // PipelineModule calls context.resourceRegistry.registerResourceType()
    // during initialize(). A no-op is fine for examples that don't use the
    // cluster-level resource routing.
    const resourceRegistry = {
      registerResourceType: () => { /* no-op */ },
      getResourcesByType: () => [],
    };

    // -- Field 3: TopologyManager stub --
    // PipelineModule does not currently call any topologyManager methods.
    const topologyManager = {};

    // -- Field 4: ModuleRegistry stub --
    // ApplicationRegistry.registerModule() is called by the registry itself,
    // not by PipelineModule — so an empty-methods stub is fine here.
    const moduleRegistry = {
      registerModule:           async () => { /* no-op */ },
      unregisterModule:         async () => { /* no-op */ },
      getModule:                () => undefined,
      getAllModules:             () => [],
      getModulesByResourceType: () => [],
    };

    // -- Field 6: Logger --
    // Logging is prefixed with the node ID so multi-node output is legible.
    const logger = {
      info:  (msg: string, meta?: unknown) => console.log(`  [${nodeId}] ${msg}`, meta ?? ''),
      warn:  (msg: string, meta?: unknown) => console.warn(`  [${nodeId}] WARN ${msg}`, meta ?? ''),
      error: (msg: string, meta?: unknown) => console.error(`  [${nodeId}] ERROR ${msg}`, meta ?? ''),
      debug: (_msg: string) => { /* suppress debug noise in demo */ },
    };

    // -- Field 5: configuration.pubsub (THE critical field) --
    // PipelineModule.onInitialize() reads context.configuration['pubsub'] to
    // construct its internal EventBus. If this field is missing, initialize()
    // throws: "PipelineModule requires context.configuration.pubsub".
    const context: ApplicationModuleContext = {
      clusterManager:  clusterMgr as unknown as import('../../src/cluster/ClusterManager').ClusterManager,
      resourceRegistry: resourceRegistry as unknown as import('../../src/cluster/resources/ResourceRegistry').ResourceRegistry,
      topologyManager:  topologyManager as unknown as import('../../src/cluster/topology/ResourceTopologyManager').ResourceTopologyManager,
      moduleRegistry:   moduleRegistry as unknown as import('../../src/applications/types').ApplicationRegistry,
      configuration: {
        // pubsub MUST be the node's PubSubManager — the EventBus uses it for
        // subscribe/publish/unsubscribe internally.
        pubsub,
      },
      logger,
    };

    // -- Create and initialize the module --
    const module = new PipelineModule({
      moduleId:    `pipeline-${nodeId}`,
      moduleName:  'Pipeline',
      version:     '1.0.0',
      resourceTypes: ['pipeline-run'],
      configuration: {},
      llmClient: new FixtureLLMClient(llmResponses),
      ...(opts.walFilePath ? { walFilePath: opts.walFilePath } : {}),
    });

    // initialize() sets up the EventBus and attaches the member-left listener.
    // start() is a no-op in the current implementation (logs only), but is
    // required to advance the module state machine to RUNNING.
    await module.initialize(context);
    await module.start();

    pipelineNodes.push({ nodeId, module, pubsub, cluster: clusterMgr as unknown as ClusterManager, handle });
  }

  // -------------------------------------------------------------------------
  // Step 3 — Return nodes + a coordinated shutdown function.
  // -------------------------------------------------------------------------
  const shutdown = async (): Promise<void> => {
    clearInterval(keepAlive);
    // Stop modules first so in-flight runs are cancelled gracefully and the
    // EventBus subscription on PubSub is removed before the node stops.
    for (const { module } of pipelineNodes) {
      await module.stop();
    }
    // Then tear down the cluster (stops gossip, transport, presence, etc.).
    await clusterHandle.stop();
  };

  return { nodes: pipelineNodes, shutdown };
}
