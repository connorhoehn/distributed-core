import { ClusterManager } from '../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../src/config/BootstrapConfig';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';
import { createTestClusterConfig, createTestClusterConfigWithDebug } from '../support/test-config';

export interface TestClusterOptions {
  size: number;
  enableLogging?: boolean;  // Controls both test harness logs AND debug console logs
  enableTestHarnessOnly?: boolean;  // Only test harness logs, no debug console logs
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
  const { size, enableLogging = false, enableTestHarnessOnly = false, testType = 'unit' } = options;
  
  const nodes: ClusterManager[] = [];
  const logs: any[] = [];
  
  // Determine what type of logging to enable
  const enableDebugConsole = enableLogging && !enableTestHarnessOnly;
  const enableTestEvents = enableLogging || enableTestHarnessOnly;
  
  // Get optimized test configuration
  const testConfig = enableDebugConsole 
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
      enableDebugConsole || testConfig.enableLogging,  // Only enable system debug logs when explicitly requested
      testConfig.failureDetector,  // Failure detector config
      testConfig.keyManager,       // Fast EC key configuration for tests
      testConfig.lifecycle          // Fast lifecycle configuration for tests
    );
    
    const nodeMetadata = {
      region: 'test-region',
      zone: 'test-zone',
      role: 'worker',
      tags: { testCluster: 'true' }
    };
    
    const manager = new ClusterManager(
      nodeId, 
      transport, 
      config, 
      100, 
      nodeMetadata
    );
    
    if (enableTestEvents) {
      (manager as any).on('started', () => logs.push({ node: nodeId, event: 'started', timestamp: Date.now() }));
      (manager as any).on('member-joined', (member: any) => logs.push({ node: nodeId, event: 'member-joined', member: member.id, timestamp: Date.now() }));
    }
    
    nodes.push(manager);
  }

  return {
    nodes,
    
    async start(): Promise<void> {
      if (enableTestEvents) {
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
      if (enableTestEvents) {
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
