/**
 * AgentHandler -- collects cluster metrics and health from a set of Node
 * instances and exposes them to the dashboard formatter.
 *
 * Demonstrates:
 *   - DiagnosticTool for system health checks
 *   - MetricsTracker for unified metric collection
 *   - ChaosInjector for fault injection experiments
 *   - Node introspection APIs (health, topology, membership)
 */
import {
  Node,
  DiagnosticTool,
  MetricsTracker,
  ChaosInjector,
} from 'distributed-core';

export interface ClusterSnapshot {
  timestamp: number;
  nodes: NodeSnapshot[];
  systemHealth: any;
  metrics: any;
  chaosActive: boolean;
  activeScenarios: string[];
}

export interface NodeSnapshot {
  id: string;
  isRunning: boolean;
  memberCount: number;
  health: any;
}

export class AgentHandler {
  private nodes: Node[];
  private diagnosticTool: DiagnosticTool;
  private metricsTracker: MetricsTracker;
  private chaosInjector: ChaosInjector;

  constructor(nodes: Node[]) {
    this.nodes = nodes;
    this.diagnosticTool = new DiagnosticTool({
      enablePerformanceMetrics: true,
      enableHealthChecks: true,
      enableLogging: false,
    });
    this.metricsTracker = new MetricsTracker({
      collectionInterval: 5000,
      enableAlerts: true,
      enableTrends: true,
    });
    this.chaosInjector = new ChaosInjector({ enableLogging: false });
  }

  /**
   * Start the management agent's diagnostic tools.
   */
  async start(): Promise<void> {
    await this.diagnosticTool.start();
  }

  /**
   * Stop the management agent and clean up timers.
   */
  async stop(): Promise<void> {
    await this.chaosInjector.stopAll();
    this.metricsTracker.stopCollection();
    await this.diagnosticTool.stop();
  }

  /**
   * Collect a point-in-time snapshot of the cluster.
   */
  async collectSnapshot(): Promise<ClusterSnapshot> {
    const nodeSnapshots: NodeSnapshot[] = this.nodes.map((node) => ({
      id: node.id,
      isRunning: node.isRunning(),
      memberCount: node.getMemberCount(),
      health: node.getClusterHealth(),
    }));

    const systemHealth = await this.diagnosticTool.checkSystemHealth();
    const perfMetrics = await this.diagnosticTool.collectPerformanceMetrics();

    return {
      timestamp: Date.now(),
      nodes: nodeSnapshots,
      systemHealth,
      metrics: perfMetrics,
      chaosActive: this.chaosInjector.isActive(),
      activeScenarios: this.chaosInjector.getActiveScenarios(),
    };
  }

  /**
   * Inject a network latency chaos scenario.
   */
  async injectLatency(ms: number): Promise<void> {
    await this.chaosInjector.injectNetworkLatency(ms);
  }

  /**
   * Inject a network partition affecting the given node IDs.
   */
  async injectPartition(nodeIds: string[]): Promise<void> {
    await this.chaosInjector.injectNetworkPartition(nodeIds);
  }

  /**
   * Stop all active chaos scenarios.
   */
  async stopChaos(): Promise<void> {
    await this.chaosInjector.stopAll();
  }

  /**
   * Get the ChaosInjector statistics.
   */
  getChaosStats(): any {
    return this.chaosInjector.getStatistics();
  }

  /**
   * Get the DiagnosticTool for advanced usage.
   */
  getDiagnosticTool(): DiagnosticTool {
    return this.diagnosticTool;
  }

  /**
   * Get the MetricsTracker for advanced usage.
   */
  getMetricsTracker(): MetricsTracker {
    return this.metricsTracker;
  }
}
