import { ClusterManager } from '../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../src/cluster/BootstrapConfig';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';
import { NodeId } from '../../src/types';

/**
 * Cluster Coordination Test Harness
 * 
 * Demonstrates comprehensive cluster coordination capabilities including:
 * - Multi-node cluster formation with seed nodes
 * - Sophisticated routing strategies (consistent hashing, primary, broadcast)  
 * - Cluster health monitoring and metrics
 * - Topology awareness and load balancing
 * - Node failure simulation and recovery
 * - Complete cluster lifecycle management
 */
export class ClusterCoordinationHarness {
  private clusters: Map<string, ClusterManager> = new Map();
  private transports: Map<string, InMemoryAdapter> = new Map();

  /**
   * Create an elegant multi-node cluster test environment
   */
  async createClusterEnvironment(nodeCount: number = 5): Promise<void> {
    console.log(`🚀 Creating elegant ${nodeCount}-node cluster environment...`);

    // Create seed node first
    const seedNodeId = 'seed-node';
    await this.createNode(seedNodeId, []);

    // Create remaining nodes with seed node bootstrap
    const nodePromises: Promise<void>[] = [];
    for (let i = 1; i < nodeCount; i++) {
      const nodeId = `node-${i}`;
      nodePromises.push(this.createNode(nodeId, [seedNodeId]));
    }

    await Promise.all(nodePromises);
    
    // Allow cluster stabilization
    await this.waitForStabilization();
    
    console.log(`✅ Cluster environment ready with ${nodeCount} nodes`);
  }

  /**
   * Create and start a single cluster node
   */
  private async createNode(nodeId: string, seedNodes: string[]): Promise<void> {
    const nodeIdObj: NodeId = { id: nodeId, address: 'localhost', port: 8000 + Math.floor(Math.random() * 1000) };
    const transport = new InMemoryAdapter(nodeIdObj);
    this.transports.set(nodeId, transport);

    const config = BootstrapConfig.create({
      seedNodes,
      joinTimeout: 2000,
      gossipInterval: 500
    });

    const cluster = new ClusterManager(nodeId, transport, config, 150); // 150 virtual nodes for better distribution
    
    this.clusters.set(nodeId, cluster);
    await cluster.start();
  }

  /**
   * Demonstrate sophisticated routing strategies
   */
  async demonstrateRoutingStrategies(): Promise<void> {
    console.log('\n🎯 Demonstrating sophisticated routing strategies...');
    
    const cluster = this.clusters.get('seed-node')!;
    const testKey = 'elegant-test-key';

    // Consistent hash routing (default)
    const consistentNodes = cluster.getNodesForKey(testKey, {
      type: 'replicas',
      count: 3
    });
    console.log(`🔄 Consistent Hash (3 replicas): ${consistentNodes.join(', ')}`);

    // Primary node routing
    const primaryNode = cluster.getNodesForKey(testKey, {
      type: 'primary'
    });
    console.log(`🎯 Primary node: ${primaryNode.join(', ')}`);

    // All nodes routing
    const allNodes = cluster.getNodesForKey(testKey, {
      type: 'all'
    });
    console.log(`🌐 All nodes (${allNodes.length}): ${allNodes.slice(0, 3).join(', ')}...`);
  }

  /**
   * Display elegant cluster health metrics
   */
  displayClusterHealth(): void {
    console.log('\n💊 Cluster Health Metrics:');
    
    this.clusters.forEach((cluster, nodeId) => {
      const health = cluster.getClusterHealth();
      const healthStatus = health.isHealthy ? '✅ HEALTHY' : '⚠️  UNHEALTHY';
      
      console.log(`  ${nodeId}:`);
      console.log(`    Status: ${healthStatus}`);
      console.log(`    Nodes: ${health.aliveNodes}/${health.totalNodes} alive (${(health.healthRatio * 100).toFixed(1)}%)`);
      console.log(`    Ring Coverage: ${(health.ringCoverage * 100).toFixed(1)}%`);
    });
  }

  /**
   * Display elegant cluster topology information
   */
  displayClusterTopology(): void {
    console.log('\n🗺️  Cluster Topology:');
    
    const seedCluster = this.clusters.get('seed-node')!;
    const topology = seedCluster.getTopology();
    
    console.log(`  Total Active Nodes: ${topology.totalAliveNodes}`);
    console.log(`  Replication Factor: ${topology.replicationFactor}`);
    console.log(`  Load Balance Score: ${topology.averageLoadBalance.toFixed(3)}`);
    console.log(`  Virtual Nodes per Node: ${topology.rings[0]?.virtualNodes || 'N/A'}`);
    
    if (Object.keys(topology.zones).length > 0) {
      console.log(`  Zone Distribution: ${JSON.stringify(topology.zones)}`);
    }
  }

  /**
   * Display cluster metadata summary
   */
  displayClusterMetadata(): void {
    console.log('\n📊 Cluster Metadata:');
    
    const seedCluster = this.clusters.get('seed-node')!;
    const metadata = seedCluster.getMetadata();
    
    console.log(`  Cluster ID: ${metadata.clusterId}`);
    console.log(`  Node Count: ${metadata.nodeCount}`);
    console.log(`  Version: ${metadata.version}`);
    console.log(`  Created: ${new Date(metadata.created).toISOString()}`);
    
    if (metadata.roles.length > 0) {
      console.log(`  Roles: ${metadata.roles.join(', ')}`);
    }
  }

  /**
   * Simulate elegant node failure and recovery
   */
  async simulateNodeFailure(): Promise<void> {
    console.log('\n💥 Simulating elegant node failure and recovery...');
    
    const nodeToFail = 'node-1';
    const cluster = this.clusters.get(nodeToFail);
    
    if (cluster) {
      console.log(`🔻 Stopping node: ${nodeToFail}`);
      await cluster.stop();
      
      // Wait for failure detection
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      console.log(`🔺 Recovering node: ${nodeToFail}`);
      await cluster.start();
      
      // Wait for recovery stabilization
      await this.waitForStabilization();
      console.log(`✅ Node recovery completed`);
    }
  }

  /**
   * Wait for cluster stabilization
   */
  private async waitForStabilization(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  /**
   * Demonstrate the complete elegant cluster coordination system
   */
  async demonstrateElegantCluster(): Promise<void> {
    try {
      // Create elegant cluster environment
      await this.createClusterEnvironment(6);
      
      // Display cluster status
      this.displayClusterHealth();
      this.displayClusterTopology();
      this.displayClusterMetadata();
      
      // Demonstrate sophisticated routing
      await this.demonstrateRoutingStrategies();
      
      // Simulate failure recovery
      await this.simulateNodeFailure();
      
      // Final status check
      console.log('\n🏁 Final cluster state:');
      this.displayClusterHealth();
      
    } catch (error) {
      console.error('❌ Cluster coordination demonstration failed:', error);
    }
  }

  /**
   * Clean shutdown of all cluster nodes
   */
  async shutdown(): Promise<void> {
    console.log('\n🛑 Gracefully shutting down cluster...');
    
    const shutdownPromises = Array.from(this.clusters.values()).map(cluster => cluster.stop());
    await Promise.all(shutdownPromises);
    
    this.clusters.clear();
    this.transports.clear();
    
    console.log('✅ Cluster shutdown completed');
  }
}

// Export for use in test harnesses
export default ClusterTestHarness;
