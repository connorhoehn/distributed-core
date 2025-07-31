import { ClusterManager } from '../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../src/cluster/config/BootstrapConfig';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';

/**
 * Multi-node cluster harness for testing distributed operations
 * Tests cluster formation, member discovery, and distributed routing
 */
export class MultiNodeHarness {
  private clusters: ClusterManager[] = [];
  private transports: InMemoryAdapter[] = [];

  /**
   * Create a multi-node cluster for testing
   */
  async createCluster(nodeCount: number): Promise<ClusterManager[]> {
    const nodeIds = Array.from({ length: nodeCount }, (_, i) => `node-${i + 1}`);
    
    // Create transport adapters for each node
    for (let i = 0; i < nodeCount; i++) {
      const transport = new InMemoryAdapter({ id: nodeIds[i], address: 'localhost', port: 8000 + i });
      this.transports.push(transport);
    }

    // Create cluster managers
    for (let i = 0; i < nodeCount; i++) {
      const seedNodes = nodeIds.filter((_, idx) => idx !== i).slice(0, 2); // Use 2 seed nodes
      const config = BootstrapConfig.create({
        seedNodes,
        joinTimeout: 3000,
        gossipInterval: 500
      });

      const cluster = new ClusterManager(nodeIds[i], this.transports[i], config);
      this.clusters.push(cluster);
    }

    // Start all clusters
    for (const cluster of this.clusters) {
      await cluster.start();
    }

    // Wait for cluster formation
    await this.waitForClusterFormation();

    return this.clusters;
  }

  /**
   * Wait for all nodes to discover each other
   */
  private async waitForClusterFormation(): Promise<void> {
    const maxWaitTime = 10000; // 10 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const memberCounts = this.clusters.map(c => c.getMemberCount());
      const expectedCount = this.clusters.length;
      
      if (memberCounts.every(count => count === expectedCount)) {
        return; // All nodes see all members
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    throw new Error('Cluster formation timeout');
  }

  /**
   * Test distributed key routing across the cluster
   */
  testDistributedRouting(keys: string[]): Map<string, string[]> {
    const routingResults = new Map<string, string[]>();

    for (const key of keys) {
      const routes = this.clusters[0].getReplicaNodes(key, 3);
      routingResults.set(key, routes);
    }

    return routingResults;
  }

  /**
   * Test cluster health monitoring
   */
  getClusterHealthSummary() {
    return this.clusters.map(cluster => ({
      nodeId: cluster.getNodeInfo().id,
      health: cluster.getClusterHealth(),
      memberCount: cluster.getMemberCount()
    }));
  }

  /**
   * Simulate node failure
   */
  async simulateNodeFailure(nodeIndex: number): Promise<void> {
    if (nodeIndex >= 0 && nodeIndex < this.clusters.length) {
      await this.clusters[nodeIndex].stop();
    }
  }

  /**
   * Clean up all cluster resources
   */
  async cleanup(): Promise<void> {
    for (const cluster of this.clusters) {
      await cluster.stop();
    }
    
    for (const transport of this.transports) {
      await transport.stop();
    }

    this.clusters = [];
    this.transports = [];
  }

  /**
   * Get membership view from all nodes
   */
  getMembershipViews() {
    return this.clusters.map(cluster => ({
      nodeId: cluster.getNodeInfo().id,
      membership: Array.from(cluster.getMembership().values()).map(m => ({
        id: m.id,
        status: m.status,
        lastSeen: m.lastSeen
      }))
    }));
  }
}
