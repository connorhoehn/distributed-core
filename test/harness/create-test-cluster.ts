import { ClusterManager } from '../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../src/cluster/BootstrapConfig';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';
import { createTestClusterConfig, createTestClusterConfigWithDebug } from '../support/test-config';

export interface TestClusterOptions {
  size: number;
  enableLogging?: boolean;
  enableDebugLogs?: boolean;  // New option for debug console logs
  testType?: 'unit' | 'integration' | 'scenario';
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
  const { size, enableLogging = false, enableDebugLogs, testType = 'unit' } = options;
  
  const nodes: ClusterManager[] = [];
  const logs: any[] = [];
  
  // Get optimized test configuration
  // If enableDebugLogs is explicitly set, use that; otherwise use config default
  const testConfig = enableDebugLogs === true 
    ? createTestClusterConfigWithDebug(testType)
    : createTestClusterConfig(testType);
  
  // Create simple node IDs
  const nodeIds: string[] = Array.from({ length: size }, (_, i) => `test-node-${i}`);

  // Create cluster managers with transports
  for (let i = 0; i < size; i++) {
    const nodeId = nodeIds[i];
    const transport = new InMemoryAdapter({
      id: nodeId,
      address: '127.0.0.1',
      port: 3000 + i
    });
    
    // Use first node as seed for others
    const seedNodes = i === 0 ? [] : [nodeIds[0]];
    const config = new BootstrapConfig(
      seedNodes, 
      testConfig.joinTimeout,      // Fast join timeout
      testConfig.gossipInterval,   // Fast gossip interval  
      enableDebugLogs || testConfig.enableLogging  // Use enableDebugLogs for system logging, not enableLogging
    );
    
    const nodeMetadata = {
      region: 'test-region',
      zone: 'test-zone',
      role: 'worker',
      tags: { testCluster: 'true' }
    };
    
    const manager = new ClusterManager(nodeId, transport, config, 100, nodeMetadata);
    
    if (enableLogging) {
      (manager as any).on('started', () => logs.push({ node: nodeId, event: 'started', timestamp: Date.now() }));
      (manager as any).on('member-joined', (member: any) => logs.push({ node: nodeId, event: 'member-joined', member: member.id, timestamp: Date.now() }));
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
        // Small delay between node starts (reduced for tests)
        await new Promise(resolve => setTimeout(resolve, testConfig.failureDetector.heartbeatInterval / 10));
      }
      
      // Small delay for cluster formation (reduced for tests)
      await new Promise(resolve => setTimeout(resolve, testConfig.gossipInterval));
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
