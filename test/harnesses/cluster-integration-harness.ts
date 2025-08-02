/**
 * Cluster Test Harness Utilities
 * Provides helper functions for multi-node cluster testing
 */

import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { InMemoryCoordinator } from '../../../src/coordinators/InMemoryCoordinator';
import { NodeMetadata } from '../../../src/identity/NodeMetadata';
import { DeltaSyncEngine } from '../../../src/cluster/delta-sync/DeltaSync';
import { LogicalService } from '../../../src/cluster/introspection/ClusterIntrospection';
import { StateFingerprintGenerator } from '../../../src/cluster/delta-sync/StateFingerprint';
import { StateDeltaManager } from '../../../src/cluster/delta-sync/StateDelta';

export interface TestClusterNode {
  id: string;
  port: number;
  address: string;
  clusterManager: ClusterManager;
  websocketAdapter: WebSocketAdapter;
  coordinator: InMemoryCoordinator;
  deltaSyncEngine: DeltaSyncEngine;
  services: LogicalService[];
  metadata: NodeMetadata;
}

export interface ClusterTestConfig {
  basePort?: number;
  nodeCount?: number;
  enableLogging?: boolean;
  gossipInterval?: number;
  pingInterval?: number;
  syncInterval?: number;
}

export class ClusterTestHarness {
  private nodes: TestClusterNode[] = [];
  private config: Required<ClusterTestConfig>;

  constructor(config: ClusterTestConfig = {}) {
    this.config = {
      basePort: config.basePort || 19000,
      nodeCount: config.nodeCount || 3,
      enableLogging: config.enableLogging || false,
      gossipInterval: config.gossipInterval || 1000,
      pingInterval: config.pingInterval || 5000,
      syncInterval: config.syncInterval || 2000
    };
  }

  /**
   * Create a cluster of test nodes
   */
  async createCluster(): Promise<TestClusterNode[]> {
    const nodePromises = [];
    
    for (let i = 0; i < this.config.nodeCount; i++) {
      const nodeId = `test-node-${i}`;
      const port = this.config.basePort + i;
      nodePromises.push(this.createNode(nodeId, port));
    }

    this.nodes = await Promise.all(nodePromises);
    return this.nodes;
  }

  /**
   * Create a single test node
   */
  async createNode(nodeId: string, port: number): Promise<TestClusterNode> {
    const address = '127.0.0.1';
    
    const nodeMetadata = new NodeMetadata(
      nodeId,
      address,
      port,
      {
        version: '1.0.0',
        capabilities: ['delta-sync', 'websocket'],
        region: 'test'
      },
      // Additional required parameters based on constructor
      {
        maxConnections: 50,
        timeout: 30000
      },
      // Services list
      []
    );

    const websocketAdapter = new WebSocketAdapter(
      { id: nodeId, address, port },
      {
        port,
        host: address,
        maxConnections: 50,
        pingInterval: this.config.pingInterval,
        enableCompression: true
      }
    );

    const coordinator = new InMemoryCoordinator();
    
    const clusterManager = new ClusterManager(
      nodeMetadata,
      websocketAdapter,
      coordinator
    );

    const deltaSyncEngine = new DeltaSyncEngine();

    // Start the node components
    await websocketAdapter.start();
    await clusterManager.start();

    const testNode: TestClusterNode = {
      id: nodeId,
      port,
      address,
      clusterManager,
      websocketAdapter,
      coordinator,
      deltaSyncEngine,
      services: [],
      metadata: nodeMetadata
    };

    return testNode;
  }

  /**
   * Connect all nodes in a full mesh topology
   */
  async connectAllNodes(): Promise<void> {
    const connectionPromises = [];
    
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        connectionPromises.push(this.connectNodes(this.nodes[i], this.nodes[j]));
      }
    }

    await Promise.all(connectionPromises);
    
    // Allow time for connections to stabilize
    await this.wait(1000);
  }

  /**
   * Connect two specific nodes
   */
  async connectNodes(nodeA: TestClusterNode, nodeB: TestClusterNode): Promise<void> {
    await Promise.all([
      nodeA.websocketAdapter.connect({
        id: nodeB.id,
        address: nodeB.address,
        port: nodeB.port
      }),
      nodeB.websocketAdapter.connect({
        id: nodeA.id,
        address: nodeA.address,
        port: nodeA.port
      })
    ]);
  }

  /**
   * Add a service to a specific node
   */
  addServiceToNode(nodeId: string, serviceId: string, serviceConfig: Partial<LogicalService> = {}): LogicalService {
    const node = this.nodes.find(n => n.id === nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    const service: LogicalService = {
      id: serviceId,
      type: serviceConfig.type || 'test-service',
      nodeId: node.id,
      metadata: {
        name: `Service ${serviceId}`,
        version: '1.0.0',
        ...serviceConfig.metadata
      },
      stats: {
        requests: Math.floor(Math.random() * 1000),
        latency: Math.floor(Math.random() * 100),
        errors: Math.floor(Math.random() * 10),
        ...serviceConfig.stats
      },
      lastUpdated: Date.now(),
      vectorClock: { [node.id]: 1 },
      version: 1,
      checksum: `checksum-${serviceId}-${Date.now()}`,
      conflictPolicy: 'last-writer-wins',
      ...serviceConfig
    };

    node.services.push(service);
    return service;
  }

  /**
   * Perform delta synchronization between all nodes
   */
  async performClusterSync(): Promise<void> {
    const fingerprintGen = new StateFingerprintGenerator({
      hashAlgorithm: 'sha256',
      includeTimestamps: false,
      includeMetadata: true,
      includeStats: true,
      chunkSize: 10
    });

    const deltaManager = new StateDeltaManager({
      maxDeltaSize: 50,
      includeFullServices: true,
      enableCausality: true,
      compressionThreshold: 512,
      enableEncryption: false
    });

    // Generate fingerprints for all nodes
    const fingerprints = new Map();
    for (const node of this.nodes) {
      const fingerprint = fingerprintGen.generateServiceFingerprint(node.services, node.id);
      fingerprints.set(node.id, fingerprint);
    }

    // Perform pairwise synchronization
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const nodeA = this.nodes[i];
        const nodeB = this.nodes[j];
        
        const fingerprintA = fingerprints.get(nodeA.id);
        const fingerprintB = fingerprints.get(nodeB.id);
        
        const comparison = fingerprintGen.compareFingerprints(fingerprintA, fingerprintB);
        
        if (!comparison.identical) {
          // Generate and apply deltas
          const deltasForB = deltaManager.generateDelta(nodeA.services, comparison, nodeA.id, fingerprintB.rootHash);
          const deltasForA = deltaManager.generateDelta(nodeB.services, comparison, nodeB.id, fingerprintA.rootHash);
          
          for (const delta of deltasForB) {
            const result = deltaManager.applyDelta(nodeB.services, delta);
            if (result.success && result.resultingServices) {
              nodeB.services = result.resultingServices;
            }
          }
          
          for (const delta of deltasForA) {
            const result = deltaManager.applyDelta(nodeA.services, delta);
            if (result.success && result.resultingServices) {
              nodeA.services = result.resultingServices;
            }
          }
        }
      }
    }
  }

  /**
   * Simulate network partition by disconnecting specific nodes
   */
  async simulatePartition(partitionedNodeIds: string[]): Promise<void> {
    const partitionedNodes = this.nodes.filter(n => partitionedNodeIds.includes(n.id));
    
    for (const node of partitionedNodes) {
      await node.websocketAdapter.stop();
    }
  }

  /**
   * Heal network partition by reconnecting nodes
   */
  async healPartition(partitionedNodeIds: string[]): Promise<void> {
    const partitionedNodes = this.nodes.filter(n => partitionedNodeIds.includes(n.id));
    
    // Restart adapters
    for (const node of partitionedNodes) {
      await node.websocketAdapter.start();
    }
    
    // Reconnect to all other nodes
    for (const partitionedNode of partitionedNodes) {
      for (const otherNode of this.nodes) {
        if (otherNode.id !== partitionedNode.id) {
          await this.connectNodes(partitionedNode, otherNode);
        }
      }
    }
    
    // Allow time for reconnection
    await this.wait(2000);
  }

  /**
   * Get cluster-wide statistics
   */
  getClusterStats(): {
    nodeCount: number;
    totalServices: number;
    totalConnections: number;
    averageServicesPerNode: number;
    serviceDistribution: Record<string, number>;
  } {
    const totalServices = this.nodes.reduce((sum, node) => sum + node.services.length, 0);
    const totalConnections = this.nodes.reduce((sum, node) => sum + node.websocketAdapter.getConnectedNodes().length, 0);
    
    const serviceDistribution: Record<string, number> = {};
    for (const node of this.nodes) {
      serviceDistribution[node.id] = node.services.length;
    }

    return {
      nodeCount: this.nodes.length,
      totalServices,
      totalConnections,
      averageServicesPerNode: totalServices / this.nodes.length,
      serviceDistribution
    };
  }

  /**
   * Verify cluster consistency
   */
  verifyClusterConsistency(): {
    isConsistent: boolean;
    inconsistencies: string[];
    serviceCount: number;
  } {
    const inconsistencies: string[] = [];
    let isConsistent = true;

    // Check if all nodes have the same services
    if (this.nodes.length > 1) {
      const firstNodeServices = new Set(this.nodes[0].services.map(s => s.id));
      
      for (let i = 1; i < this.nodes.length; i++) {
        const nodeServices = new Set(this.nodes[i].services.map(s => s.id));
        
        const missing = [...firstNodeServices].filter(id => !nodeServices.has(id));
        const extra = [...nodeServices].filter(id => !firstNodeServices.has(id));
        
        if (missing.length > 0) {
          inconsistencies.push(`Node ${this.nodes[i].id} missing services: ${missing.join(', ')}`);
          isConsistent = false;
        }
        
        if (extra.length > 0) {
          inconsistencies.push(`Node ${this.nodes[i].id} has extra services: ${extra.join(', ')}`);
          isConsistent = false;
        }
      }
    }

    return {
      isConsistent,
      inconsistencies,
      serviceCount: this.nodes[0]?.services.length || 0
    };
  }

  /**
   * Clean shutdown of all nodes
   */
  async cleanup(): Promise<void> {
    await Promise.all(
      this.nodes.map(async (node) => {
        try {
          await node.websocketAdapter.stop();
          await node.clusterManager.stop();
        } catch (error) {
          if (this.config.enableLogging) {
            console.warn(`Error stopping node ${node.id}:`, error);
          }
        }
      })
    );
    this.nodes = [];
  }

  /**
   * Get all nodes
   */
  getNodes(): TestClusterNode[] {
    return [...this.nodes];
  }

  /**
   * Get a specific node by ID
   */
  getNode(nodeId: string): TestClusterNode | undefined {
    return this.nodes.find(n => n.id === nodeId);
  }

  /**
   * Utility method to wait for a specified time
   */
  private async wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Utility function to measure bandwidth savings
 */
export function measureBandwidthSavings(
  fullState: any,
  deltaData: any
): {
  fullStateSize: number;
  deltaSize: number;
  bandwidthSavings: number;
  compressionRatio: number;
} {
  const fullStateSize = Buffer.byteLength(JSON.stringify(fullState), 'utf8');
  const deltaSize = Buffer.byteLength(JSON.stringify(deltaData), 'utf8');
  const bandwidthSavings = ((fullStateSize - deltaSize) / fullStateSize) * 100;
  const compressionRatio = deltaSize / fullStateSize;

  return {
    fullStateSize,
    deltaSize,
    bandwidthSavings,
    compressionRatio
  };
}

/**
 * Generate test services with realistic data
 */
export function generateTestServices(
  count: number,
  nodeId: string,
  serviceTypePrefix: string = 'service'
): LogicalService[] {
  const services: LogicalService[] = [];
  
  for (let i = 0; i < count; i++) {
    services.push({
      id: `${serviceTypePrefix}-${nodeId}-${i}`,
      type: `${serviceTypePrefix}-type-${i % 5}`,
      nodeId,
      metadata: {
        name: `Test Service ${i}`,
        version: `1.${i}.0`,
        description: `Generated test service ${i} for node ${nodeId}`,
        tags: [`tag-${i % 3}`, `env-test`]
      },
      stats: {
        requests: Math.floor(Math.random() * 10000),
        latency: Math.floor(Math.random() * 200),
        errors: Math.floor(Math.random() * 50),
        uptime: Math.floor(Math.random() * 86400)
      },
      lastUpdated: Date.now() - Math.floor(Math.random() * 3600000),
      vectorClock: { [nodeId]: i + 1 },
      version: i + 1,
      checksum: `checksum-${serviceTypePrefix}-${nodeId}-${i}-${Date.now()}`,
      conflictPolicy: 'last-writer-wins'
    });
  }
  
  return services;
}
