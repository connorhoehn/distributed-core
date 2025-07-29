import { ClusterManager } from '../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../src/cluster/BootstrapConfig';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';
import { NodeId } from '../../src/types';

export interface TestClusterOptions {
  size: number;
  enableLogging?: boolean;
}

export interface TestCluster {
  nodes: ClusterManager[];
  start(): Promise<void>;
  stop(): Promise<void>;
  getNode(index: number): ClusterManager;
  getLogs(): any[];
}

/**
 * Creates a lightweight test cluster for integration testing
 */
export function createTestCluster(options: TestClusterOptions): TestCluster {
  const { size, enableLogging = true } = options;
  
  const nodes: ClusterManager[] = [];
  const logs: any[] = [];
  
  // Create simple node IDs
  const nodeIds: NodeId[] = Array.from({ length: size }, (_, i) => ({
    id: `test-node-${i}`,
    address: `127.0.0.1`,
    port: 3000 + i
  }));

  // Create cluster managers with transports
  for (let i = 0; i < size; i++) {
    const nodeId = nodeIds[i];
    const transport = new InMemoryAdapter(nodeId);
    
    // Use first node as seed for others
    const seedNodes = i === 0 ? [] : [nodeIds[0].id];
    const config = new BootstrapConfig(seedNodes, 5000, 1000);
    
    const manager = new ClusterManager(nodeId.id, transport, config);
    
    if (enableLogging) {
      manager.on('started', () => logs.push({ node: nodeId.id, event: 'started', timestamp: Date.now() }));
      manager.on('member-joined', (member) => logs.push({ node: nodeId.id, event: 'member-joined', member: member.id, timestamp: Date.now() }));
      manager.on('join-sent', (target) => logs.push({ node: nodeId.id, event: 'join-sent', target: target, timestamp: Date.now() }));
    }
    
    nodes.push(manager);
  }

  return {
    nodes,
    
    async start(): Promise<void> {
      if (enableLogging) {
        logs.push({ message: 'Starting test cluster', timestamp: Date.now() });
      }
      
      // Start all nodes sequentially to avoid race conditions
      for (const node of nodes) {
        await node.start();
        // Small delay between node starts
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      // Small delay for cluster formation
      await new Promise(resolve => setTimeout(resolve, 50));
    },
    
    async stop(): Promise<void> {
      if (enableLogging) {
        logs.push({ message: 'Stopping test cluster', timestamp: Date.now() });
      }
      
      // Stop all nodes
      for (const node of nodes) {
        await node.stop();
      }
    },
    
    getNode(index: number): ClusterManager {
      if (index < 0 || index >= nodes.length) {
        throw new Error(`Node index ${index} out of bounds`);
      }
      return nodes[index];
    },
    
    getLogs(): any[] {
      return logs.slice();
    }
  };
}
