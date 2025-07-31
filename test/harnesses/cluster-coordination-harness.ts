import { Node } from '../../src/common/Node';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';

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
  private nodes: Map<string, Node> = new Map();

  /**
   * Create a multi-node cluster test environment
   */
  async createClusterEnvironment(nodeCount: number = 5): Promise<void> {
    console.log(`🚀 Creating ${nodeCount}-node cluster environment...`);

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
    const transport = new InMemoryAdapter({
      id: nodeId,
      address: 'localhost',
      port: 8000 + Math.floor(Math.random() * 1000)
    });

    const node = new Node({
      id: nodeId,
      region: 'test-region',
      zone: 'test-zone',
      role: 'worker',
      seedNodes,
      transport,
      enableMetrics: true,
      enableChaos: true,
      enableLogging: false
    });
    
    this.nodes.set(nodeId, node);
    await node.start();
  }

  /**
   * Demonstrate sophisticated routing strategies
   */
  async demonstrateRoutingStrategies(): Promise<void> {
    console.log('\n🎯 Demonstrating sophisticated routing strategies...');
    
    const node = this.nodes.get('seed-node')!;
    const testKey = 'test-key';

    // Get replica nodes for the key
    const replicaNodes = node.getReplicaNodes(testKey, 3);
    console.log(`🔄 Consistent Hash (3 replicas): ${replicaNodes.join(', ')}`);

    // Get cluster topology
    const topology = node.getClusterTopology();
    console.log(`🌐 Total nodes (${topology.totalAliveNodes}): ${topology.totalAliveNodes} active`);
  }

  /**
   * Display cluster health metrics
   */
  displayClusterHealth(): void {
    console.log('\n💊 Cluster Health Metrics:');
    
    this.nodes.forEach((node, nodeId) => {
      const health = node.getClusterHealth();
      const healthStatus = health.isHealthy ? '✅ HEALTHY' : '⚠️  UNHEALTHY';
      
      console.log(`  ${nodeId}:`);
      console.log(`    Status: ${healthStatus}`);
      console.log(`    Nodes: ${health.aliveNodes}/${health.totalNodes} alive (${(health.healthRatio * 100).toFixed(1)}%)`);
      console.log(`    Ring Coverage: ${(health.ringCoverage * 100).toFixed(1)}%`);
    });
  }

  /**
   * Display cluster topology information
   */
  displayClusterTopology(): void {
    console.log('\n🗺️  Cluster Topology:');
    
    const seedNode = this.nodes.get('seed-node')!;
    const topology = seedNode.getClusterTopology();
    
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
    
    const seedNode = this.nodes.get('seed-node')!;
    const metadata = seedNode.getClusterMetadata();
    
    console.log(`  Cluster ID: ${metadata.clusterId}`);
    console.log(`  Node Count: ${metadata.nodeCount}`);
    console.log(`  Version: ${metadata.version}`);
    console.log(`  Created: ${new Date(metadata.created).toISOString()}`);
    
    if (metadata.roles.length > 0) {
      console.log(`  Roles: ${metadata.roles.join(', ')}`);
    }
  }

  /**
   * Simulate node failure and recovery
   */
  async simulateNodeFailure(): Promise<void> {
    console.log('\n💥 Simulating node failure and recovery...');
    
    const nodeToFail = 'node-1';
    const node = this.nodes.get(nodeToFail);
    
    if (node) {
      console.log(`🔻 Stopping node: ${nodeToFail}`);
      await node.stop();
      
      // Wait for failure detection
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      console.log(`🔺 Recovering node: ${nodeToFail}`);
      await node.start();
      
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
   * Demonstrate the complete cluster coordination system
   */
  async demonstrateClusterCoordination(): Promise<void> {
    try {
      // Create cluster environment
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
    
    const shutdownPromises = Array.from(this.nodes.values()).map(node => node.stop());
    await Promise.all(shutdownPromises);
    
    this.nodes.clear();
    
    console.log('✅ Cluster shutdown completed');
  }
}

// Export for use in test harnesses
export default ClusterCoordinationHarness;
