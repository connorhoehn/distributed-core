// src/applications/pipeline/PipelineModule.ts
//
// ApplicationModule implementation for pipeline execution.
// Extends ApplicationModule; declares resource type 'pipeline-run'; owns runs
// via the cluster's identity (ownerNodeId from ClusterManager.localNodeId).
//
// Phase 3 integration: this module is meant to be instantiated per-node inside
// a createCluster() call, then wired to the gateway's WebSocket bridge for
// real-time event forwarding to the frontend.

import { randomUUID } from 'crypto';
import { ApplicationModule } from '../ApplicationModule';
import {
  ApplicationModuleConfig,
  ApplicationModuleContext,
  ApplicationModuleMetrics,
  ApplicationModuleDashboardData,
  ModuleState,
  ScalingStrategy,
} from '../types';
import {
  ResourceMetadata,
  ResourceTypeDefinition,
  ResourceState,
  ResourceHealth,
  DistributionStrategy,
} from '../../cluster/resources/types';
import { EventBus } from '../../messaging/EventBus';
import { PubSubManager } from '../../gateway/pubsub/PubSubManager';
import { PipelineExecutor, PipelineExecutorOptions } from './PipelineExecutor';
import { LLMClient } from './LLMClient';
import type {
  PipelineDefinition,
  PipelineEventMap,
  PipelineRun,
} from './types';

// ---------------------------------------------------------------------------
// Pipeline-run resource metadata
// ---------------------------------------------------------------------------

export interface PipelineRunResource extends ResourceMetadata {
  resourceType: 'pipeline-run';
  applicationData: {
    runId: string;
    pipelineId: string;
    pipelineVersion: number;
    status: PipelineRun['status'];
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    ownerNodeId: string;
  };
}

// ---------------------------------------------------------------------------
// Module configuration
// ---------------------------------------------------------------------------

export interface PipelineModuleConfig extends ApplicationModuleConfig {
  /**
   * LLM client used by every executor for pipeline "llm" node execution.
   * distributed-core ships only the LLMClient interface; concrete vendor
   * implementations (Anthropic, Bedrock, OpenAI, fixture/replay, …) live
   * in the consuming project. Pass a FixtureLLMClient for tests.
   */
  llmClient: LLMClient;
  /** Number of runs kept in the active map before eviction. Default: 1000. */
  maxActiveRuns?: number;
  /** Checkpoint every N events emitted per run. Default: 10. */
  checkpointEveryN?: number;
  /** PubSub topic for the pipeline EventBus. Default: 'pipeline.events'. */
  eventBusTopic?: string;
  /**
   * WAL file path for the pipeline EventBus. Set to enable durability and replay.
   * Default: undefined (in-memory only, suitable for tests and single-node demos).
   */
  walFilePath?: string;
}

// ---------------------------------------------------------------------------
// Internal metrics state
// ---------------------------------------------------------------------------

interface PipelineMetricsState {
  runsStarted: number;
  runsCompleted: number;
  runsFailed: number;
  runsCancelled: number;
  llmTokensIn: number;
  llmTokensOut: number;
  totalDurationMs: number;
  completedCount: number;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// PipelineModule
// ---------------------------------------------------------------------------

export class PipelineModule extends ApplicationModule {
  /** Map of runId → executor for in-flight runs owned by this node. */
  private readonly activeExecutors = new Map<string, PipelineExecutor>();

  /** Completed run snapshots kept for dashboard queries. */
  private readonly completedRuns = new Map<string, PipelineRun>();

  /** EventBus for WAL-backed, cluster-visible pipeline events. */
  private eventBus!: EventBus<PipelineEventMap>;

  /** LLM client injected into every executor. */
  private readonly llmClient: LLMClient;

  private readonly pipelineConfig: PipelineModuleConfig;

  private metrics: PipelineMetricsState = {
    runsStarted: 0,
    runsCompleted: 0,
    runsFailed: 0,
    runsCancelled: 0,
    llmTokensIn: 0,
    llmTokensOut: 0,
    totalDurationMs: 0,
    completedCount: 0,
    startedAt: Date.now(),
  };

  constructor(config: PipelineModuleConfig) {
    super({
      ...config,
      resourceTypes: ['pipeline-run'],
    });
    this.pipelineConfig = config;
    this.llmClient = config.llmClient;
  }

  // -------------------------------------------------------------------------
  // ApplicationModule lifecycle
  // -------------------------------------------------------------------------

  protected async onInitialize(context: ApplicationModuleContext): Promise<void> {
    this.log('info', 'Initializing PipelineModule');

    // Create the EventBus backed by the node's PubSub.
    // The PubSubManager is accessible via the underlying node's pubsub — we
    // pull it off the ClusterManager here since the context doesn't surface it
    // directly. At module initialization time, the caller must have set
    // context.configuration.pubsub to the node's PubSubManager.
    const pubsub = context.configuration['pubsub'] as PubSubManager | undefined;
    if (!pubsub) {
      throw new Error(
        'PipelineModule requires context.configuration.pubsub (PubSubManager). ' +
        'Pass it when constructing the ApplicationModuleContext.',
      );
    }

    const localNodeId = context.clusterManager.localNodeId;

    this.eventBus = new EventBus<PipelineEventMap>(pubsub, localNodeId, {
      topic: this.pipelineConfig.eventBusTopic ?? 'pipeline.events',
      walFilePath: this.pipelineConfig.walFilePath,
    });
    await this.eventBus.start();
    this.log('info', 'Pipeline EventBus started');

    // Subscribe to resource:orphaned events on the ResourceRouter — emitted
    // when the owner node of a run has left the cluster. The surviving node
    // that processes this event should resume from the latest checkpoint.
    // Since the ResourceRouter is not directly exposed through context, we
    // listen via the ClusterManager's member-left event as a lightweight proxy.
    context.clusterManager.on('member-left', (nodeId: string) => {
      this.handleOrphanedNodeRuns(nodeId).catch((err: unknown) => {
        this.log('error', `Error handling orphaned runs from node ${nodeId}`, err);
      });
    });

    this.log('info', 'PipelineModule initialized');
  }

  protected async onStart(): Promise<void> {
    this.log('info', 'PipelineModule started');
  }

  protected async onStop(): Promise<void> {
    this.log('info', 'Stopping PipelineModule — cancelling active runs');

    // Cancel all in-flight runs gracefully.
    for (const [runId, executor] of this.activeExecutors) {
      this.log('info', `Cancelling run ${runId} on shutdown`);
      executor.cancel();
    }
    this.activeExecutors.clear();

    if (this.eventBus?.isStarted()) {
      await this.eventBus.stop();
    }

    this.log('info', 'PipelineModule stopped');
  }

  protected async onConfigurationUpdate(_newConfig: ApplicationModuleConfig): Promise<void> {
    this.log('info', 'PipelineModule configuration updated');
  }

  protected getResourceTypeDefinitions(): ResourceTypeDefinition[] {
    return [
      {
        typeName: 'pipeline-run',
        version: '1.0.0',
        defaultCapacity: {
          totalCapacity: this.pipelineConfig.maxActiveRuns ?? 1000,
          availableCapacity: this.pipelineConfig.maxActiveRuns ?? 1000,
          reservedCapacity: 0,
        },
        capacityCalculator: (_metadata: ResourceMetadata) => 1,
        healthChecker: (_resource: ResourceMetadata) => ResourceHealth.HEALTHY,
        performanceMetrics: ['runsStarted', 'runsCompleted', 'runsFailed', 'avgDurationMs'],
        defaultDistributionStrategy: DistributionStrategy.LEAST_LOADED,
        distributionConstraints: [],
        serialize: (resource: ResourceMetadata) => JSON.stringify(resource),
        deserialize: (data: unknown) => JSON.parse(data as string) as ResourceMetadata,
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Resource management
  // -------------------------------------------------------------------------

  /**
   * Start a new pipeline run.
   *
   * `metadata.applicationData` must contain:
   *   - `definition`: PipelineDefinition
   *   - `triggerPayload?`: Record<string, unknown>
   *   - `failureRateLLM?`: number (0–1, for testing)
   *   - `failureRateOther?`: number (0–1, for testing)
   *   - `speedMultiplier?`: number (for testing — 0.02 = 50x faster)
   */
  async createResource(metadata: Partial<ResourceMetadata>): Promise<ResourceMetadata> {
    const appData = (metadata.applicationData ?? {}) as Record<string, unknown>;
    const definition = appData['definition'] as PipelineDefinition | undefined;
    if (!definition) {
      throw new Error('createResource: metadata.applicationData.definition (PipelineDefinition) is required');
    }

    const triggerPayload = (appData['triggerPayload'] as Record<string, unknown> | undefined) ?? {};
    const failureRateLLM = (appData['failureRateLLM'] as number | undefined) ?? 0;
    const failureRateOther = (appData['failureRateOther'] as number | undefined) ?? 0;
    const speedMultiplier = (appData['speedMultiplier'] as number | undefined) ?? 1.0;

    const localNodeId = this.context.clusterManager.localNodeId;

    const executorOpts: PipelineExecutorOptions = {
      definition,
      ownerNodeId: localNodeId,
      llmClient: this.llmClient,
      eventBus: this.eventBus,
      triggerPayload,
      failureRateLLM,
      failureRateOther,
      speedMultiplier,
    };

    const executor = new PipelineExecutor(executorOpts);
    const runId = executor.runId;

    this.activeExecutors.set(runId, executor);
    this.metrics.runsStarted++;

    const resource: PipelineRunResource = {
      resourceId: runId,
      resourceType: 'pipeline-run',
      nodeId: localNodeId,
      timestamp: Date.now(),
      capacity: { current: 1, maximum: 1, unit: 'run' },
      performance: { latency: 0, throughput: 0, errorRate: 0 },
      distribution: { shardCount: 1, replicationFactor: 1 },
      applicationData: {
        runId,
        pipelineId: definition.id,
        pipelineVersion: definition.publishedVersion ?? definition.version,
        status: 'running',
        startedAt: new Date().toISOString(),
        ownerNodeId: localNodeId,
      },
      state: ResourceState.ACTIVE,
      health: ResourceHealth.HEALTHY,
    };

    // Subscribe to terminal events to update our metrics and move to completed.
    const completedSub = this.eventBus.subscribe('pipeline.run.completed', async (event) => {
      if (event.payload.runId !== runId) return;
      this.metrics.runsCompleted++;
      this.metrics.completedCount++;
      this.metrics.totalDurationMs += event.payload.durationMs;
      this.finaliseRun(runId);
      this.eventBus.unsubscribe(completedSub);
      this.eventBus.unsubscribe(failedSub);
      this.eventBus.unsubscribe(cancelledSub);
    });

    const failedSub = this.eventBus.subscribe('pipeline.run.failed', async (event) => {
      if (event.payload.runId !== runId) return;
      this.metrics.runsFailed++;
      this.finaliseRun(runId);
      this.eventBus.unsubscribe(completedSub);
      this.eventBus.unsubscribe(failedSub);
      this.eventBus.unsubscribe(cancelledSub);
    });

    const cancelledSub = this.eventBus.subscribe('pipeline.run.cancelled', async (event) => {
      if (event.payload.runId !== runId) return;
      this.metrics.runsCancelled++;
      this.finaliseRun(runId);
      this.eventBus.unsubscribe(completedSub);
      this.eventBus.unsubscribe(failedSub);
      this.eventBus.unsubscribe(cancelledSub);
    });

    // Track LLM token usage.
    this.eventBus.subscribe('pipeline.llm.response', async (event) => {
      if (event.payload.runId !== runId) return;
      this.metrics.llmTokensIn += event.payload.tokensIn;
      this.metrics.llmTokensOut += event.payload.tokensOut;
    });

    // Fire-and-forget: run() returns a Promise that resolves when the run
    // reaches a terminal state. We don't await it here so createResource()
    // returns immediately. Callers can observe progress via the EventBus.
    executor.run().catch((err: unknown) => {
      this.log('error', `Unhandled error in run ${runId}`, err);
    });

    this.log('info', `Pipeline run ${runId} started on node ${localNodeId}`);
    return resource;
  }

  async scaleResource(_resourceId: string, _strategy: ScalingStrategy): Promise<void> {
    // Pipeline runs are not scalable in the traditional sense; this is a no-op.
    this.log('info', `scaleResource called (no-op for pipeline-run)`);
  }

  async deleteResource(resourceId: string): Promise<void> {
    const executor = this.activeExecutors.get(resourceId);
    if (executor) {
      executor.cancel();
    }
    this.activeExecutors.delete(resourceId);
    this.completedRuns.delete(resourceId);
    this.log('info', `Pipeline run ${resourceId} deleted`);
  }

  // -------------------------------------------------------------------------
  // Orphan handling
  // -------------------------------------------------------------------------

  /**
   * Called when a cluster member leaves. Emits `pipeline.run.orphaned` for
   * any runs that were owned by the departed node. In a full implementation,
   * this node would then pick up those runs from their last checkpoint.
   * For Phase 3 the orphan is logged and the event is emitted; checkpoint
   * resume is a future enhancement.
   */
  private async handleOrphanedNodeRuns(departedNodeId: string): Promise<void> {
    this.log('warn', `Node ${departedNodeId} left the cluster — scanning for orphaned runs`);

    // In a production system we'd query the ResourceRouter for runs owned by
    // departedNodeId. For now we scan our local completedRuns snapshot and the
    // resource registry for runs with ownerNodeId === departedNodeId.
    const at = new Date().toISOString();

    for (const run of this.completedRuns.values()) {
      if (run.ownerNodeId === departedNodeId) {
        await this.eventBus.publish('pipeline.run.orphaned', {
          runId: run.id,
          previousOwner: departedNodeId,
          at,
        });
        this.log('warn', `Run ${run.id} orphaned from node ${departedNodeId}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Metrics and dashboard
  // -------------------------------------------------------------------------

  async getMetrics(): Promise<ApplicationModuleMetrics & {
    runsStarted: number;
    runsCompleted: number;
    runsFailed: number;
    runsActive: number;
    avgDurationMs: number;
    llmTokensIn: number;
    llmTokensOut: number;
  }> {
    const avgDurationMs =
      this.metrics.completedCount > 0
        ? this.metrics.totalDurationMs / this.metrics.completedCount
        : 0;

    const uptimeMs = Date.now() - this.metrics.startedAt;
    const errorRate =
      this.metrics.runsStarted > 0
        ? this.metrics.runsFailed / this.metrics.runsStarted
        : 0;

    return {
      moduleId: this.config.moduleId,
      timestamp: Date.now(),
      state: this.state,
      resourceCounts: {
        'pipeline-run': this.activeExecutors.size + this.completedRuns.size,
      },
      performance: {
        requestsPerSecond: this.metrics.runsStarted / Math.max(1, uptimeMs / 1000),
        averageLatency: avgDurationMs,
        errorRate,
        uptime: uptimeMs,
      },
      // Pipeline-specific
      runsStarted: this.metrics.runsStarted,
      runsCompleted: this.metrics.runsCompleted,
      runsFailed: this.metrics.runsFailed,
      runsActive: this.activeExecutors.size,
      avgDurationMs,
      llmTokensIn: this.metrics.llmTokensIn,
      llmTokensOut: this.metrics.llmTokensOut,
    };
  }

  async getDashboardData(): Promise<ApplicationModuleDashboardData> {
    const m = await this.getMetrics();

    return {
      moduleId: this.config.moduleId,
      moduleName: this.config.moduleName,
      state: this.state,
      summary: {
        totalResources: m.resourceCounts['pipeline-run'] ?? 0,
        healthyResources: m.runsCompleted,
        activeConnections: m.runsActive,
        throughput: m.performance.requestsPerSecond,
      },
      charts: [
        {
          title: 'Run Outcomes',
          type: 'bar',
          data: {
            completed: m.runsCompleted,
            failed: m.runsFailed,
            active: m.runsActive,
          },
        },
        {
          title: 'LLM Token Usage',
          type: 'line',
          data: {
            tokensIn: m.llmTokensIn,
            tokensOut: m.llmTokensOut,
          },
        },
        {
          title: 'Average Run Duration (ms)',
          type: 'gauge',
          data: { avgDurationMs: m.avgDurationMs },
        },
      ],
      alerts:
        m.performance.errorRate > 0.1
          ? [
              {
                level: 'warning',
                message: `High pipeline failure rate: ${(m.performance.errorRate * 100).toFixed(1)}%`,
                timestamp: Date.now(),
              },
            ]
          : [],
    };
  }

  // -------------------------------------------------------------------------
  // Public accessors (for gateway bridge / testing)
  // -------------------------------------------------------------------------

  /** The EventBus this module publishes all pipeline events to. */
  getEventBus(): EventBus<PipelineEventMap> {
    return this.eventBus;
  }

  /** Cancel a specific run by ID. No-op if the run is not active on this node. */
  cancelRun(runId: string): void {
    const executor = this.activeExecutors.get(runId);
    if (executor) executor.cancel();
  }

  /** Forward an approval decision into the appropriate in-flight executor. */
  resolveApproval(
    runId: string,
    stepId: string,
    userId: string,
    decision: 'approve' | 'reject',
    comment?: string,
  ): void {
    const executor = this.activeExecutors.get(runId);
    if (executor) executor.resolveApproval(runId, stepId, userId, decision, comment);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private finaliseRun(runId: string): void {
    const executor = this.activeExecutors.get(runId);
    if (executor) {
      const run = executor.getCurrentRun();
      this.completedRuns.set(runId, run);
      this.activeExecutors.delete(runId);
    }
  }
}
