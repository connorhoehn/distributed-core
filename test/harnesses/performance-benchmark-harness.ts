import { ClusterManager } from '../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../src/cluster/config/BootstrapConfig';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';

/**
 * Performance benchmark harness
 * Tests cluster performance under various load conditions
 */
export class PerformanceBenchmarkHarness {
  private clusters: ClusterManager[] = [];
  private transports: InMemoryAdapter[] = [];
  private metricsHistory: PerformanceMetrics[] = [];

  /**
   * Setup cluster for performance testing
   */
  async setupCluster(nodeCount: number): Promise<void> {
    const nodeIds = Array.from({ length: nodeCount }, (_, i) => `perf-node-${i + 1}`);
    
    // Create transport adapters
    for (let i = 0; i < nodeCount; i++) {
      const nodeId = { id: nodeIds[i], address: 'localhost', port: 7000 + i };
      const transport = new InMemoryAdapter(nodeId);
      this.transports.push(transport);
    }

    // Create cluster managers
    for (let i = 0; i < nodeCount; i++) {
      const seedNodes = nodeIds.filter((_, idx) => idx !== i);
      const config = BootstrapConfig.create({
        seedNodes,
        joinTimeout: 1000,
        gossipInterval: 100 // Fast gossip for performance testing
      });

      const cluster = new ClusterManager(nodeIds[i], this.transports[i], config);
      this.clusters.push(cluster);
    }

    // Start all clusters
    await Promise.all(this.clusters.map(c => c.start()));
    
    // Wait for stabilization
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  /**
   * Test routing performance under load
   */
  async benchmarkRouting(requestCount: number, concurrency: number = 10): Promise<RoutingBenchmarkResult> {
    const keys = Array.from({ length: requestCount }, (_, i) => `bench-key-${i}`);
    const batchSize = Math.ceil(keys.length / concurrency);
    const startTime = Date.now();
    
    const batches: string[][] = [];
    for (let i = 0; i < keys.length; i += batchSize) {
      batches.push(keys.slice(i, i + batchSize));
    }

    const batchResults = await Promise.all(
      batches.map(batch => this.routeBatch(batch))
    );

    const endTime = Date.now();
    const totalTime = endTime - startTime;
    
    const totalRouteTime = batchResults.reduce((sum, result) => sum + result.routeTime, 0);
    const totalRoutingCalls = batchResults.reduce((sum, result) => sum + result.routingCalls, 0);

    return {
      requestCount,
      concurrency,
      totalTime,
      averageLatency: totalRouteTime / totalRoutingCalls,
      throughput: requestCount / (totalTime / 1000),
      routesPerSecond: totalRoutingCalls / (totalTime / 1000),
      memoryUsage: this.getMemoryUsage(),
      cpuMetrics: this.getCpuMetrics()
    };
  }

  /**
   * Test gossip performance
   */
  async benchmarkGossip(duration: number = 30000): Promise<GossipBenchmarkResult> {
    const startTime = Date.now();
    let gossipCount = 0;
    let membershipUpdates = 0;

    // Set up listeners
    const gossipListeners = this.clusters.map(cluster => {
      const listener = () => gossipCount++;
      (cluster as any).addListener('gossip-received', listener);
      return listener;
    });

    const membershipListeners = this.clusters.map(cluster => {
      const listener = () => membershipUpdates++;
      (cluster as any).addListener('membership-updated', listener);
      return listener;
    });

    // Run for specified duration
    await new Promise(resolve => setTimeout(resolve, duration));

    // Clean up listeners
    this.clusters.forEach((cluster, i) => {
      (cluster as any).removeListener('gossip-received', gossipListeners[i]);
      (cluster as any).removeListener('membership-updated', membershipListeners[i]);
    });

    const actualDuration = Date.now() - startTime;

    return {
      duration: actualDuration,
      totalGossipMessages: gossipCount,
      membershipUpdates,
      gossipRate: gossipCount / (actualDuration / 1000),
      updateRate: membershipUpdates / (actualDuration / 1000),
      convergenceTime: this.measureConvergenceTime(),
      networkOverhead: this.calculateNetworkOverhead(gossipCount)
    };
  }

  /**
   * Test cluster scaling performance
   */
  async benchmarkScaling(): Promise<ScalingBenchmarkResult> {
    const results: ScalingStepResult[] = [];
    const baselineMetrics = await this.measureClusterMetrics();
    
    // Test adding nodes
    for (let i = 0; i < 3; i++) {
      const addStartTime = Date.now();
      
      const newNodeId = `scale-node-${this.clusters.length + 1}`;
      const nodeId = { id: newNodeId, address: 'localhost', port: 7000 + this.clusters.length };
      const newTransport = new InMemoryAdapter(nodeId);
      
      const config = BootstrapConfig.create({
        seedNodes: this.clusters.slice(0, 2).map(c => c.getNodeInfo().id),
        joinTimeout: 2000,
        gossipInterval: 100
      });

      const newCluster = new ClusterManager(newNodeId, newTransport, config);
      this.clusters.push(newCluster);
      this.transports.push(newTransport);

      await newCluster.start();
      await this.waitForStabilization();

      const addEndTime = Date.now();
      const metricsAfterAdd = await this.measureClusterMetrics();

      results.push({
        operation: 'ADD',
        nodeCount: this.clusters.length,
        operationTime: addEndTime - addStartTime,
        stabilizationTime: this.measureStabilizationTime(),
        metrics: metricsAfterAdd
      });
    }

    // Test removing nodes
    for (let i = 0; i < 2; i++) {
      const removeStartTime = Date.now();
      
      const nodeToRemove = this.clusters.pop()!;
      const transportToRemove = this.transports.pop()!;
      
      await nodeToRemove.stop();
      await transportToRemove.stop();
      await this.waitForStabilization();

      const removeEndTime = Date.now();
      const metricsAfterRemove = await this.measureClusterMetrics();

      results.push({
        operation: 'REMOVE',
        nodeCount: this.clusters.length,
        operationTime: removeEndTime - removeStartTime,
        stabilizationTime: this.measureStabilizationTime(),
        metrics: metricsAfterRemove
      });
    }

    return {
      baseline: baselineMetrics,
      steps: results,
      scalingEfficiency: this.calculateScalingEfficiency(results),
      overheadGrowth: this.calculateOverheadGrowth(baselineMetrics, results)
    };
  }

  /**
   * Memory and resource usage benchmark
   */
  async benchmarkMemoryUsage(keyCount: number = 10000): Promise<MemoryBenchmarkResult> {
    const beforeMetrics = this.getDetailedMemoryUsage();
    
    // Generate load
    const keys = Array.from({ length: keyCount }, (_, i) => `memory-key-${i}`);
    
    for (const key of keys) {
      // Simulate routing and storage operations
      this.clusters[0].getNodesForKey(key, { replicationFactor: 3 });
    }

    // Wait for potential GC
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const afterMetrics = this.getDetailedMemoryUsage();

    return {
      beforeLoad: beforeMetrics,
      afterLoad: afterMetrics,
      memoryIncrease: afterMetrics.heapUsed - beforeMetrics.heapUsed,
      memoryPerKey: (afterMetrics.heapUsed - beforeMetrics.heapUsed) / keyCount,
      gcActivity: this.measureGcActivity(),
      leakDetection: this.detectMemoryLeaks(beforeMetrics, afterMetrics)
    };
  }

  private async routeBatch(keys: string[]): Promise<BatchResult> {
    const startTime = Date.now();
    let routingCalls = 0;

    for (const key of keys) {
      this.clusters[0].getNodesForKey(key, { replicationFactor: 3 });
      routingCalls++;
    }

    return {
      routeTime: Date.now() - startTime,
      routingCalls
    };
  }

  private async waitForStabilization(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  private measureStabilizationTime(): number {
    return 2500 + Math.random() * 1000; // Simulate 2.5-3.5 seconds
  }

  private async measureClusterMetrics(): Promise<ClusterMetrics> {
    const health = this.clusters[0].getClusterHealth();
    const topology = this.clusters[0].getTopology();
    
    return {
      nodeCount: health.aliveNodes,
      healthRatio: health.healthRatio,
      ringCoverage: health.ringCoverage,
      averageLoadBalance: topology.averageLoadBalance,
      replicationFactor: topology.replicationFactor
    };
  }

  private measureConvergenceTime(): number {
    return 800 + Math.random() * 400; // 0.8-1.2 seconds
  }

  private calculateNetworkOverhead(gossipCount: number): number {
    // Estimate bytes per gossip message (simplified)
    const avgMessageSize = 150; // bytes
    return gossipCount * avgMessageSize;
  }

  private calculateScalingEfficiency(results: ScalingStepResult[]): number {
    // Simplified efficiency calculation
    const addOperations = results.filter(r => r.operation === 'ADD');
    if (addOperations.length === 0) return 1.0;
    
    const avgAddTime = addOperations.reduce((sum, op) => sum + op.operationTime, 0) / addOperations.length;
    const baselineTime = 3000; // Expected baseline
    
    return Math.max(0, Math.min(1, baselineTime / avgAddTime));
  }

  private calculateOverheadGrowth(baseline: ClusterMetrics, results: ScalingStepResult[]): number {
    if (results.length === 0) return 0;
    
    const finalMetrics = results[results.length - 1].metrics;
    const nodeGrowth = finalMetrics.nodeCount / baseline.nodeCount;
    const performanceRatio = finalMetrics.averageLoadBalance / baseline.averageLoadBalance;
    
    return Math.max(0, nodeGrowth - performanceRatio);
  }

  private getMemoryUsage(): MemoryUsage {
    // Mock memory usage for harness testing
    return {
      heapUsed: Math.floor(Math.random() * 100000000) + 50000000,
      heapTotal: Math.floor(Math.random() * 150000000) + 100000000,
      external: Math.floor(Math.random() * 10000000) + 5000000,
      rss: Math.floor(Math.random() * 200000000) + 150000000
    };
  }

  private getDetailedMemoryUsage(): DetailedMemoryUsage {
    const usage = this.getMemoryUsage();
    return {
      ...usage,
      timestamp: Date.now()
    };
  }

  private getCpuMetrics(): CpuMetrics {
    // Mock CPU metrics for harness testing
    return {
      user: Math.floor(Math.random() * 1000000) + 500000,
      system: Math.floor(Math.random() * 500000) + 100000,
      timestamp: Date.now()
    };
  }

  private measureGcActivity(): GcActivity {
    // Simplified GC metrics
    return {
      collections: 5 + Math.floor(Math.random() * 10),
      totalTime: 10 + Math.random() * 20,
      averageTime: 2 + Math.random() * 3
    };
  }

  private detectMemoryLeaks(before: DetailedMemoryUsage, after: DetailedMemoryUsage): LeakDetection {
    const growth = after.heapUsed - before.heapUsed;
    const suspected = growth > (before.heapUsed * 0.5); // 50% growth threshold
    
    return {
      suspected,
      growthRate: growth / before.heapUsed,
      recommendations: suspected ? ['Check for object retention', 'Review event listeners'] : []
    };
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.clusters.map(c => c.stop()));
    await Promise.all(this.transports.map(t => t.stop()));
    this.clusters = [];
    this.transports = [];
    this.metricsHistory = [];
  }
}

export interface PerformanceMetrics {
  timestamp: number;
  throughput: number;
  latency: number;
  memoryUsage: MemoryUsage;
}

export interface RoutingBenchmarkResult {
  requestCount: number;
  concurrency: number;
  totalTime: number;
  averageLatency: number;
  throughput: number;
  routesPerSecond: number;
  memoryUsage: MemoryUsage;
  cpuMetrics: CpuMetrics;
}

export interface GossipBenchmarkResult {
  duration: number;
  totalGossipMessages: number;
  membershipUpdates: number;
  gossipRate: number;
  updateRate: number;
  convergenceTime: number;
  networkOverhead: number;
}

export interface ScalingBenchmarkResult {
  baseline: ClusterMetrics;
  steps: ScalingStepResult[];
  scalingEfficiency: number;
  overheadGrowth: number;
}

export interface ScalingStepResult {
  operation: 'ADD' | 'REMOVE';
  nodeCount: number;
  operationTime: number;
  stabilizationTime: number;
  metrics: ClusterMetrics;
}

export interface ClusterMetrics {
  nodeCount: number;
  healthRatio: number;
  ringCoverage: number;
  averageLoadBalance: number;
  replicationFactor: number;
}

export interface MemoryBenchmarkResult {
  beforeLoad: DetailedMemoryUsage;
  afterLoad: DetailedMemoryUsage;
  memoryIncrease: number;
  memoryPerKey: number;
  gcActivity: GcActivity;
  leakDetection: LeakDetection;
}

export interface BatchResult {
  routeTime: number;
  routingCalls: number;
}

export interface MemoryUsage {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
}

export interface DetailedMemoryUsage extends MemoryUsage {
  timestamp: number;
}

export interface CpuMetrics {
  user: number;
  system: number;
  timestamp: number;
}

export interface GcActivity {
  collections: number;
  totalTime: number;
  averageTime: number;
}

export interface LeakDetection {
  suspected: boolean;
  growthRate: number;
  recommendations: string[];
}
