import { ClusterManager } from '../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../src/cluster/config/BootstrapConfig';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';

/**
 * Cluster load distribution harness
 * Tests consistent hashing, load balancing, and key distribution
 */
export class LoadDistributionHarness {
  private clusters: ClusterManager[] = [];
  private transports: InMemoryAdapter[] = [];

  /**
   * Create cluster and analyze load distribution
   */
  async setupCluster(nodeCount: number): Promise<void> {
    const nodeIds = Array.from({ length: nodeCount }, (_, i) => `load-node-${i + 1}`);
    
    // Create transport adapters
    for (let i = 0; i < nodeCount; i++) {
      const transport = new InMemoryAdapter({ id: nodeIds[i], address: 'localhost', port: 9000 + i });
      this.transports.push(transport);
    }

    // Create cluster managers
    for (let i = 0; i < nodeCount; i++) {
      const seedNodes = nodeIds.filter((_, idx) => idx !== i);
      const config = BootstrapConfig.create({
        seedNodes,
        joinTimeout: 2000,
        gossipInterval: 300
      });

      const cluster = new ClusterManager(nodeIds[i], this.transports[i], config);
      this.clusters.push(cluster);
    }

    // Start all clusters
    await Promise.all(this.clusters.map(c => c.start()));
    
    // Wait for stabilization
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  /**
   * Test load distribution across nodes
   */
  analyzeLoadDistribution(keyCount: number = 1000): LoadDistributionResult {
    const keys = Array.from({ length: keyCount }, (_, i) => `key-${i}`);
    const nodeDistribution = new Map<string, number>();
    const replicationMap = new Map<string, Set<string>>();

    // Initialize counters
    this.clusters.forEach(cluster => {
      nodeDistribution.set(cluster.getNodeInfo().id, 0);
    });

    // Distribute keys and count assignments
    for (const key of keys) {
      const primaryNode = this.clusters[0].getNodeForKey(key);
      const replicaNodes = this.clusters[0].getReplicaNodes(key, 3);
      
      if (primaryNode) {
        nodeDistribution.set(primaryNode, (nodeDistribution.get(primaryNode) || 0) + 1);
      }

      replicationMap.set(key, new Set(replicaNodes));
    }

    return {
      totalKeys: keyCount,
      nodeDistribution: Object.fromEntries(nodeDistribution),
      averageKeysPerNode: keyCount / this.clusters.length,
      distributionVariance: this.calculateVariance(Array.from(nodeDistribution.values())),
      replicationFactor: this.calculateAverageReplication(replicationMap)
    };
  }

  /**
   * Test different routing strategies
   */
  testRoutingStrategies(testKeys: string[]): RoutingStrategyResult {
    const strategies = ['CONSISTENT_HASH', 'ROUND_ROBIN', 'RANDOM', 'LOCALITY_AWARE'];
    const results: Record<string, string[][]> = {};

    for (const strategy of strategies) {
      results[strategy] = testKeys.map(key => 
        this.clusters[0].getNodesForKey(key, { 
          strategy, 
          replicationFactor: 3, 
          preferLocalZone: false 
        })
      );
    }

    return {
      strategies: results,
      consistency: this.checkRoutingConsistency(results['CONSISTENT_HASH']),
      coverage: this.calculateNodeCoverage(results)
    };
  }

  /**
   * Test hash ring rebalancing when nodes join/leave
   */
  async testRebalancing(): Promise<RebalancingResult> {
    const initialDistribution = this.analyzeLoadDistribution(500);
    
    // Add a new node
    const newNodeId = `rebalance-node-${this.clusters.length + 1}`;
    const newTransport = new InMemoryAdapter({ 
      id: newNodeId, 
      address: 'localhost', 
      port: 9000 + this.clusters.length 
    });
    
    const config = BootstrapConfig.create({
      seedNodes: this.clusters.slice(0, 2).map(c => c.getNodeInfo().id),
      joinTimeout: 2000,
      gossipInterval: 300
    });

    const newCluster = new ClusterManager(newNodeId, newTransport, config);
    this.clusters.push(newCluster);
    this.transports.push(newTransport);

    await newCluster.start();
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for rebalancing

    const afterJoinDistribution = this.analyzeLoadDistribution(500);

    // Remove a node
    const removedNode = this.clusters.pop()!;
    await removedNode.stop();
    await new Promise(resolve => setTimeout(resolve, 1000));

    const afterLeaveDistribution = this.analyzeLoadDistribution(500);

    return {
      initial: initialDistribution,
      afterJoin: afterJoinDistribution,
      afterLeave: afterLeaveDistribution,
      keysMoved: this.calculateKeyMovement(initialDistribution, afterJoinDistribution)
    };
  }

  private calculateVariance(values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(value => Math.pow(value - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  }

  private calculateAverageReplication(replicationMap: Map<string, Set<string>>): number {
    const replicationCounts = Array.from(replicationMap.values()).map(set => set.size);
    return replicationCounts.reduce((a, b) => a + b, 0) / replicationCounts.length;
  }

  private checkRoutingConsistency(routes: string[][]): number {
    // Check how consistent the routing is across multiple calls
    let consistentRoutes = 0;
    for (let i = 0; i < routes.length - 1; i++) {
      if (JSON.stringify(routes[i]) === JSON.stringify(routes[i + 1])) {
        consistentRoutes++;
      }
    }
    return consistentRoutes / Math.max(1, routes.length - 1);
  }

  private calculateNodeCoverage(results: Record<string, string[][]>): Record<string, number> {
    const coverage: Record<string, number> = {};
    
    for (const [strategy, routes] of Object.entries(results)) {
      const uniqueNodes = new Set(routes.flat());
      coverage[strategy] = uniqueNodes.size / this.clusters.length;
    }
    
    return coverage;
  }

  private calculateKeyMovement(before: LoadDistributionResult, after: LoadDistributionResult): number {
    // Simplified calculation of how many keys would need to move
    let totalMovement = 0;
    for (const [node, beforeCount] of Object.entries(before.nodeDistribution)) {
      const afterCount = after.nodeDistribution[node] || 0;
      totalMovement += Math.abs(beforeCount - afterCount);
    }
    return totalMovement / 2; // Divide by 2 because each move is counted twice
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.clusters.map(c => c.stop()));
    await Promise.all(this.transports.map(t => t.stop()));
    this.clusters = [];
    this.transports = [];
  }
}

export interface LoadDistributionResult {
  totalKeys: number;
  nodeDistribution: Record<string, number>;
  averageKeysPerNode: number;
  distributionVariance: number;
  replicationFactor: number;
}

export interface RoutingStrategyResult {
  strategies: Record<string, string[][]>;
  consistency: number;
  coverage: Record<string, number>;
}

export interface RebalancingResult {
  initial: LoadDistributionResult;
  afterJoin: LoadDistributionResult;
  afterLeave: LoadDistributionResult;
  keysMoved: number;
}
