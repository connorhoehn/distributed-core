import { ClusterManager } from '../../src/cluster/ClusterManager';
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

  // Create cluster managers (stubs)
  for (let i = 0; i < size; i++) {
    const manager = new ClusterManager();
    nodes.push(manager);
  }

  return {
    nodes,
    
    async start(): Promise<void> {
      if (enableLogging) {
        logs.push({ message: 'Starting test cluster', timestamp: Date.now() });
      }
      // Stub implementation - no actual starting logic
    },
    
    async stop(): Promise<void> {
      if (enableLogging) {
        logs.push({ message: 'Test cluster stopped', timestamp: Date.now() });
      }
      // Stub implementation - no actual stopping logic
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
