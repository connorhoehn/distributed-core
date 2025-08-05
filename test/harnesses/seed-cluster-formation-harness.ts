import { ClusterManager } from '../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../src/config/BootstrapConfig';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';
import { SeedNodeRegistry, SeedNodeInfo } from '../../src/cluster/seeding/SeedNodeRegistry';
import { YamlSeedConfiguration } from '../../src/config/YamlSeedConfiguration';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface SeedClusterNode {
  id: string;
  address: string;
  port: number;
  clusterManager: ClusterManager;
  transport: InMemoryAdapter;
  seedRegistry?: SeedNodeRegistry;
  role: 'seed' | 'coordinator' | 'worker';
  region: string;
  isPermanent: boolean;
}

export interface SeedClusterFormationConfig {
  seedNodes: number;
  coordinatorNodes: number;
  workerNodes: number;
  basePort: number;
  enableLogging: boolean;
  useYamlConfig: boolean;
  healthCheckInterval: number;
  joinTimeout: number;
  gossipInterval: number;
}

/**
 * Seed-based Cluster Formation Test Harness
 * 
 * Demonstrates realistic cluster formation using SeedNodeRegistry:
 * 1. Creates initial seed nodes that bootstrap the cluster
 * 2. Coordinator nodes discover and join via seed registry
 * 3. Worker nodes join using updated seed information
 * 4. Simulates real-world node failure/recovery scenarios
 * 5. Shows dynamic seed registry updates and health monitoring
 */
export class SeedClusterFormationHarness {
  private nodes: Map<string, SeedClusterNode> = new Map();
  private yamlConfigPath?: string;
  private config: SeedClusterFormationConfig;
  private formationLog: Array<{ timestamp: number; event: string; details: any }> = [];

  constructor(config: Partial<SeedClusterFormationConfig> = {}) {
    this.config = {
      seedNodes: 2,
      coordinatorNodes: 2,
      workerNodes: 3,
      basePort: 19000,
      enableLogging: false,
      useYamlConfig: true,
      healthCheckInterval: 10000,
      joinTimeout: 5000,
      gossipInterval: 1000,
      ...config
    };
    
    this.log('harness-initialized', { config: this.config });
  }

  private log(event: string, details: any = {}) {
    const entry = {
      timestamp: Date.now(),
      event,
      details
    };
    this.formationLog.push(entry);
    
    if (this.config.enableLogging) {
      console.log(`[${new Date().toISOString()}] ${event}:`, details);
    }
  }

  /**
   * Create YAML seed configuration for the cluster
   */
  private async createSeedConfiguration(): Promise<void> {
    if (!this.config.useYamlConfig) return;

    const seedNodeConfigs: Array<{
      id: string;
      address: string;
      port: number;
      priority: number;
      permanent: boolean;
      datacenter: string;
      role: string;
      tags: Record<string, string>;
    }> = [];
    
    // Create seed node configurations
    for (let i = 0; i < this.config.seedNodes; i++) {
      const port = this.config.basePort + i;
      seedNodeConfigs.push({
        id: `seed-${i + 1}`,
        address: '127.0.0.1',
        port,
        priority: 100 - i * 5,
        permanent: true,
        datacenter: `region-${i % 2 + 1}`,
        role: 'seed',
        tags: {
          type: 'seed',
          critical: 'true'
        }
      });
    }

    // Add coordinator nodes to seed config
    for (let i = 0; i < this.config.coordinatorNodes; i++) {
      const port = this.config.basePort + this.config.seedNodes + i;
      seedNodeConfigs.push({
        id: `coordinator-${i + 1}`,
        address: '127.0.0.1',
        port,
        priority: 80 - i * 5,
        permanent: true,
        datacenter: `region-${i % 2 + 1}`,
        role: 'coordinator',
        tags: {
          type: 'coordinator',
          management: 'true'
        }
      });
    }

    const yamlConfig = `
cluster:
  name: test-seed-cluster
  environment: development

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
${seedNodeConfigs.map(seed => `        - id: ${seed.id}
          address: ${seed.address}
          port: ${seed.port}
          priority: ${seed.priority}
          permanent: ${seed.permanent}
          datacenter: ${seed.datacenter}
          role: ${seed.role}
          tags:
${Object.entries(seed.tags).map(([k, v]) => `            ${k}: "${v}"`).join('\n')}`).join('\n')}
`;

    this.yamlConfigPath = path.resolve('test/fixtures/seed-cluster-formation.yaml');
    await fs.writeFile(this.yamlConfigPath, yamlConfig, 'utf8');
    
    this.log('yaml-config-created', { path: this.yamlConfigPath, nodes: seedNodeConfigs.length });
  }

  /**
   * Create and configure a single cluster node
   */
  private async createNode(
    nodeId: string, 
    role: 'seed' | 'coordinator' | 'worker',
    region: string,
    isPermanent: boolean,
    port: number,
    seedNodes: string[] = []
  ): Promise<SeedClusterNode> {
    
    // Create transport adapter
    const transport = new InMemoryAdapter({
      id: nodeId,
      address: '127.0.0.1',
      port
    });

    // Create bootstrap configuration
    const config = BootstrapConfig.create({
      seedNodes,
      joinTimeout: this.config.joinTimeout,
      gossipInterval: this.config.gossipInterval
    });

    // Create cluster manager
    const clusterManager = new ClusterManager(nodeId, transport, config);

    // Create seed registry for seed and coordinator nodes
    let seedRegistry: SeedNodeRegistry | undefined;
    if (role === 'seed' || role === 'coordinator') {
      seedRegistry = new SeedNodeRegistry({
        healthCheckInterval: this.config.healthCheckInterval,
        maxFailures: 3,
        failureTimeout: 30000
      });

      // Load YAML configuration if available
      if (this.yamlConfigPath && this.config.useYamlConfig) {
        try {
          const yamlConfig = new YamlSeedConfiguration();
          await yamlConfig.loadFromFile(this.yamlConfigPath);
          
          const yamlSeeds = yamlConfig.toSeedNodes();
          yamlSeeds.forEach(seed => {
            seedRegistry!.addSeed({
              id: seed.id,
              address: seed.address,
              port: seed.port,
              priority: seed.priority,
              isPermanent: seed.isPermanent,
              metadata: seed.metadata
            });
          });
          
          this.log('seed-registry-loaded', { nodeId, seedCount: yamlSeeds.length });
        } catch (error) {
          this.log('seed-registry-load-failed', { nodeId, error: (error as Error).message });
        }
      }
    }

    const node: SeedClusterNode = {
      id: nodeId,
      address: '127.0.0.1',
      port,
      clusterManager,
      transport,
      seedRegistry,
      role,
      region,
      isPermanent
    };

    this.nodes.set(nodeId, node);
    this.log('node-created', { nodeId, role, region, port });
    
    return node;
  }

  /**
   * Phase 1: Bootstrap seed nodes
   */
  private async bootstrapSeedNodes(): Promise<void> {
    this.log('phase-1-start', { phase: 'Bootstrap Seed Nodes' });
    
    const seedPromises: Promise<void>[] = [];
    
    for (let i = 0; i < this.config.seedNodes; i++) {
      const nodeId = `seed-${i + 1}`;
      const port = this.config.basePort + i;
      const region = `region-${i % 2 + 1}`;
      
      seedPromises.push(
        this.createNode(nodeId, 'seed', region, true, port).then(async (node) => {
          await node.clusterManager.start();
          this.log('seed-node-started', { nodeId, port });
        })
      );
    }
    
    await Promise.all(seedPromises);
    
    // Wait for seed nodes to establish initial cluster
    await this.waitForStabilization(2000);
    this.log('phase-1-complete', { seedNodesActive: this.config.seedNodes });
  }

  /**
   * Phase 2: Join coordinator nodes using seed discovery
   */
  private async joinCoordinatorNodes(): Promise<void> {
    this.log('phase-2-start', { phase: 'Join Coordinator Nodes' });
    
    // Get bootstrap seed information
    const seedNode = this.nodes.get('seed-1');
    if (!seedNode?.seedRegistry) {
      throw new Error('Seed node registry not available');
    }
    
    const bootstrapSeeds = seedNode.seedRegistry.getBootstrapSeeds();
    const seedAddresses = bootstrapSeeds.map(seed => `${seed.address}:${seed.port}`);
    this.log('bootstrap-seeds-discovered', { seeds: seedAddresses });
    
    const coordinatorPromises: Promise<void>[] = [];
    
    for (let i = 0; i < this.config.coordinatorNodes; i++) {
      const nodeId = `coordinator-${i + 1}`;
      const port = this.config.basePort + this.config.seedNodes + i;
      const region = `region-${i % 2 + 1}`;
      
      coordinatorPromises.push(
        this.createNode(nodeId, 'coordinator', region, true, port, seedAddresses).then(async (node) => {
          await node.clusterManager.start();
          this.log('coordinator-node-joined', { nodeId, port, seedsUsed: seedAddresses });
          
          // Update seed registry with new coordinator info
          if (node.seedRegistry) {
            const existingSeeds = node.seedRegistry.getAllSeeds();
            this.log('coordinator-seed-registry-status', { 
              nodeId, 
              totalSeeds: existingSeeds.length,
              availableSeeds: node.seedRegistry.getAvailableSeeds().length
            });
          }
        })
      );
    }
    
    await Promise.all(coordinatorPromises);
    await this.waitForStabilization(3000);
    this.log('phase-2-complete', { coordinatorNodesActive: this.config.coordinatorNodes });
  }

  /**
   * Phase 3: Join worker nodes using updated seed information
   */
  private async joinWorkerNodes(): Promise<void> {
    this.log('phase-3-start', { phase: 'Join Worker Nodes' });
    
    // Get updated seed information from a coordinator
    const coordinatorNode = this.nodes.get('coordinator-1');
    if (!coordinatorNode?.seedRegistry) {
      throw new Error('Coordinator seed registry not available');
    }
    
    const availableSeeds = coordinatorNode.seedRegistry.getAvailableSeeds();
    const seedAddresses = availableSeeds.slice(0, 3).map(seed => `${seed.address}:${seed.port}`);
    this.log('updated-seeds-discovered', { seeds: seedAddresses });
    
    const workerPromises: Promise<void>[] = [];
    
    for (let i = 0; i < this.config.workerNodes; i++) {
      const nodeId = `worker-${i + 1}`;
      const port = this.config.basePort + this.config.seedNodes + this.config.coordinatorNodes + i;
      const region = `region-${i % 3 + 1}`;
      
      workerPromises.push(
        this.createNode(nodeId, 'worker', region, false, port, seedAddresses).then(async (node) => {
          await node.clusterManager.start();
          this.log('worker-node-joined', { nodeId, port, seedsUsed: seedAddresses });
        })
      );
    }
    
    await Promise.all(workerPromises);
    await this.waitForStabilization(2000);
    this.log('phase-3-complete', { workerNodesActive: this.config.workerNodes });
  }

  /**
   * Phase 4: Simulate node failure and recovery
   */
  private async simulateNodeFailureRecovery(): Promise<void> {
    this.log('phase-4-start', { phase: 'Node Failure Recovery Simulation' });
    
    // Simulate seed node failure
    const seedToFail = this.nodes.get('seed-1');
    if (seedToFail) {
      this.log('simulating-seed-failure', { nodeId: 'seed-1' });
      await seedToFail.clusterManager.stop();
      
      // Update health status in other seed registries
      for (const [nodeId, node] of this.nodes) {
        if (node.seedRegistry && nodeId !== 'seed-1') {
          node.seedRegistry.markSeedFailure('seed-1');
          const healthStatus = node.seedRegistry.getHealthStatus();
          this.log('health-status-updated', { 
            nodeId, 
            totalSeeds: healthStatus.totalSeeds,
            availableSeeds: healthStatus.availableSeeds,
            failedSeeds: healthStatus.failedSeeds.length
          });
        }
      }
      
      await this.waitForStabilization(2000);
      
      // Recover the seed node
      this.log('recovering-seed-node', { nodeId: 'seed-1' });
      await seedToFail.clusterManager.start();
      
      // Mark recovery in seed registries
      for (const [nodeId, node] of this.nodes) {
        if (node.seedRegistry && nodeId !== 'seed-1') {
          node.seedRegistry.markSeedSuccess('seed-1');
          this.log('seed-recovery-marked', { nodeId, recoveredSeed: 'seed-1' });
        }
      }
      
      await this.waitForStabilization(2000);
    }
    
    this.log('phase-4-complete', { message: 'Node failure/recovery simulation completed' });
  }

  /**
   * Execute the complete seed-based cluster formation demonstration
   */
  async demonstrateClusterFormation(): Promise<void> {
    try {
      this.log('demonstration-start', { 
        totalNodes: this.config.seedNodes + this.config.coordinatorNodes + this.config.workerNodes 
      });
      
      // Setup
      await this.createSeedConfiguration();
      
      // Phase 1: Bootstrap seed nodes
      await this.bootstrapSeedNodes();
      
      // Phase 2: Join coordinator nodes
      await this.joinCoordinatorNodes();
      
      // Phase 3: Join worker nodes
      await this.joinWorkerNodes();
      
      // Display cluster status
      await this.displayClusterStatus();
      
      // Phase 4: Simulate failures
      await this.simulateNodeFailureRecovery();
      
      // Final status
      await this.displayClusterStatus();
      
      this.log('demonstration-complete', { 
        message: 'Seed-based cluster formation demonstration completed successfully',
        totalNodes: this.nodes.size,
        phases: 4
      });
      
    } catch (error) {
      this.log('demonstration-failed', { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Display comprehensive cluster status
   */
  async displayClusterStatus(): Promise<void> {
    this.log('cluster-status-report', { title: 'Cluster Status Report' });
    
    for (const [nodeId, node] of this.nodes) {
      // Use membership count as a proxy for "started" status since isStarted is private
      const memberCount = node.clusterManager.getMemberCount();
      const isActive = memberCount > 0;
      
      const nodeInfo = {
        nodeId,
        role: node.role,
        region: node.region,
        port: node.port,
        status: isActive ? 'ACTIVE' : 'INACTIVE',
        memberCount,
        isPermanent: node.isPermanent
      };
      
      if (node.seedRegistry) {
        const healthStatus = node.seedRegistry.getHealthStatus();
        (nodeInfo as any).seedRegistry = {
          totalSeeds: healthStatus.totalSeeds,
          availableSeeds: healthStatus.availableSeeds,
          healthyRatio: (healthStatus.healthyRatio * 100).toFixed(1) + '%',
          failedSeeds: healthStatus.failedSeeds.length
        };
      }
      
      this.log('node-status', nodeInfo);
    }
  }

  /**
   * Get formation logs for analysis
   */
  getFormationLogs(): typeof this.formationLog {
    return [...this.formationLog];
  }

  /**
   * Get cluster health summary
   */
  getClusterHealthSummary(): any {
    const summary = {
      totalNodes: this.nodes.size,
      activeNodes: 0,
      seedRegistries: 0,
      totalSeedsInRegistries: 0,
      averageHealthRatio: 0
    };
    
    let totalHealthRatio = 0;
    let registryCount = 0;
    
    for (const node of this.nodes.values()) {
      const memberCount = node.clusterManager.getMemberCount();
      if (memberCount > 0) {
        summary.activeNodes++;
      }
      
      if (node.seedRegistry) {
        summary.seedRegistries++;
        const healthStatus = node.seedRegistry.getHealthStatus();
        summary.totalSeedsInRegistries += healthStatus.totalSeeds;
        totalHealthRatio += healthStatus.healthyRatio;
        registryCount++;
      }
    }
    
    summary.averageHealthRatio = registryCount > 0 ? totalHealthRatio / registryCount : 0;
    
    return summary;
  }

  /**
   * Wait for cluster stabilization
   */
  private async waitForStabilization(ms: number = 1000): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clean shutdown of the entire cluster
   */
  async shutdown(): Promise<void> {
    this.log('shutdown-start', { nodesCount: this.nodes.size });
    
    const shutdownPromises: Promise<void>[] = [];
    
    for (const node of this.nodes.values()) {
      if (node.seedRegistry) {
        node.seedRegistry.stopHealthMonitoring();
      }
      shutdownPromises.push(node.clusterManager.stop());
    }
    
    await Promise.all(shutdownPromises);
    
    // Clean up YAML config file
    if (this.yamlConfigPath) {
      try {
        await fs.unlink(this.yamlConfigPath);
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    
    this.nodes.clear();
    this.log('shutdown-complete', { message: 'All nodes shut down gracefully' });
  }
}

export default SeedClusterFormationHarness;
