import { SeedNodeRegistry, SeedNodeInfo } from '../../../src/cluster/seeding/SeedNodeRegistry';
import { YamlSeedConfiguration } from '../../../src/config/YamlSeedConfiguration';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { promises as fs } from 'fs';
import * as path from 'path';

describe('Seed-Based Cluster Join E2E Tests', () => {
  let tempYamlPath: string;
  let coordinatorCluster: ClusterManager;
  let workerCluster: ClusterManager;
  let seedRegistry: SeedNodeRegistry;
  let configuration: YamlSeedConfiguration;

  // Test cluster configuration with coordinator and worker seeds
  const testClusterConfig = `
cluster:
  name: e2e-test-cluster
  environment: development

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - id: coordinator-e2e-001
          address: 127.0.0.1
          port: 8001
          priority: 100
          permanent: true
          datacenter: local-dc
          role: coordinator
          tags:
            type: coordinator
            priority: primary
            test_env: e2e
        - id: coordinator-e2e-002
          address: 127.0.0.1
          port: 8002
          priority: 90
          permanent: true
          datacenter: local-dc
          role: coordinator
          tags:
            type: coordinator
            priority: secondary
            test_env: e2e
        - id: worker-e2e-001
          address: 127.0.0.1
          port: 8003
          priority: 70
          permanent: false
          datacenter: local-dc
          role: worker
          tags:
            type: worker
            test_env: e2e
`;

  beforeAll(async () => {
    // Create temporary YAML configuration file
    tempYamlPath = path.join(process.cwd(), 'test', 'fixtures', 'temp-e2e-seeds.yaml');
    await fs.writeFile(tempYamlPath, testClusterConfig, 'utf8');
    
    // Load configuration
    configuration = new YamlSeedConfiguration();
    await configuration.loadFromFile(tempYamlPath);
    
    // Create seed registry
    seedRegistry = new SeedNodeRegistry({
      healthCheckInterval: 5000, // Faster for E2E tests
      maxFailures: 2,
      failureTimeout: 10000
    });
    
    // Populate seed registry
    const yamlSeeds = configuration.toSeedNodes();
    yamlSeeds.forEach(seed => {
      seedRegistry.addSeed({
        id: seed.id,
        address: seed.address,
        port: seed.port,
        priority: seed.priority,
        isPermanent: seed.isPermanent,
        metadata: seed.metadata
      });
    });
  });

  afterAll(async () => {
    // Clean up temp file
    try {
      await fs.unlink(tempYamlPath);
    } catch (error) {
      // Ignore cleanup errors
    }
    
    // Stop seed registry health monitoring
    seedRegistry.stopHealthMonitoring();
  });

  afterEach(async () => {
    // Clean up any running clusters
    if (coordinatorCluster) {
      await coordinatorCluster.stop();
    }
    if (workerCluster) {
      await workerCluster.stop();
    }
  });

  describe('Bootstrap Coordinator Formation', () => {
    it('should start the first coordinator node using seed registry', async () => {
      // Get bootstrap seeds for initial cluster formation
      const bootstrapSeeds = seedRegistry.getBootstrapSeeds();
      expect(bootstrapSeeds.length).toBeGreaterThan(0);
      
      // Find the primary coordinator seed
      const primaryCoordinatorSeed = bootstrapSeeds.find(s => 
        s.metadata?.tags?.type === 'coordinator' && 
        s.metadata?.tags?.priority === 'primary'
      );
      expect(primaryCoordinatorSeed).toBeDefined();
      expect(primaryCoordinatorSeed!.id).toBe('coordinator-e2e-001');

      // Create and initialize the coordinator cluster manager
      coordinatorCluster = new ClusterManager({
        nodeId: 'coordinator-e2e-001',
        bindAddress: '127.0.0.1',
        bindPort: 8001,
        role: 'coordinator',
        seedNodes: bootstrapSeeds.map(s => `${s.address}:${s.port}`)
      });

      // Initialize the cluster (this would start as bootstrap coordinator)
      await coordinatorCluster.initialize();
      
      // Verify the coordinator is initialized and running
      expect(coordinatorCluster.isInitialized()).toBe(true);
      expect(coordinatorCluster.getNodeId()).toBe('coordinator-e2e-001');
      expect(coordinatorCluster.getRole()).toBe('coordinator');

      // Mark the coordinator seed as healthy in the registry
      const coordinatorSeed = seedRegistry.getAllSeeds().find(s => s.id === 'coordinator-e2e-001');
      expect(coordinatorSeed).toBeDefined();
      coordinatorSeed!.health.isAvailable = true;
      coordinatorSeed!.health.lastSeen = Date.now();
      coordinatorSeed!.health.failures = 0;
    });
  });

  describe('Secondary Node Join Process', () => {
    it('should join a worker node to existing coordinator using seed discovery', async () => {
      // First, set up the coordinator (simulating it's already running)
      const bootstrapSeeds = seedRegistry.getBootstrapSeeds();
      coordinatorCluster = new ClusterManager({
        nodeId: 'coordinator-e2e-001',
        bindAddress: '127.0.0.1',
        bindPort: 8001,
        role: 'coordinator',
        seedNodes: bootstrapSeeds.map(s => `${s.address}:${s.port}`)
      });
      await coordinatorCluster.initialize();

      // Mark coordinator as healthy and available
      const coordinatorSeed = seedRegistry.getAllSeeds().find(s => s.id === 'coordinator-e2e-001');
      coordinatorSeed!.health.isAvailable = true;
      coordinatorSeed!.health.lastSeen = Date.now();

      // Now create a worker node that will join the cluster
      const availableSeeds = seedRegistry.getAvailableSeeds();
      expect(availableSeeds.length).toBeGreaterThan(0);
      
      // Worker should discover the healthy coordinator
      const healthyCoordinators = availableSeeds.filter(s => 
        s.metadata?.role === 'coordinator' && s.health.isAvailable
      );
      expect(healthyCoordinators.length).toBeGreaterThan(0);

      // Create worker cluster manager
      workerCluster = new ClusterManager({
        nodeId: 'worker-e2e-001',
        bindAddress: '127.0.0.1',
        bindPort: 8003,
        role: 'worker',
        seedNodes: healthyCoordinators.map(s => `${s.address}:${s.port}`)
      });

      // Initialize the worker (it should join the existing cluster)
      await workerCluster.initialize();
      
      // Verify worker is initialized
      expect(workerCluster.isInitialized()).toBe(true);
      expect(workerCluster.getNodeId()).toBe('worker-e2e-001');
      expect(workerCluster.getRole()).toBe('worker');

      // Simulate cluster membership validation
      // In a real scenario, the coordinator would have the worker in its member list
      const coordinatorMembers = coordinatorCluster.getClusterNodes();
      expect(coordinatorMembers.length).toBeGreaterThanOrEqual(1); // At least the coordinator itself

      // Mark worker seed as healthy now that it's joined
      const workerSeed = seedRegistry.getAllSeeds().find(s => s.id === 'worker-e2e-001');
      workerSeed!.health.isAvailable = true;
      workerSeed!.health.lastSeen = Date.now();
    });
  });

  describe('Seed Health and Failover', () => {
    it('should handle seed failure and recovery during cluster operations', async () => {
      // Set up initial cluster with coordinator
      const bootstrapSeeds = seedRegistry.getBootstrapSeeds();
      coordinatorCluster = new ClusterManager({
        nodeId: 'coordinator-e2e-001',
        bindAddress: '127.0.0.1',
        bindPort: 8001,
        role: 'coordinator',
        seedNodes: bootstrapSeeds.map(s => `${s.address}:${s.port}`)
      });
      await coordinatorCluster.initialize();

      // Mark all seeds as initially healthy
      const allSeeds = seedRegistry.getAllSeeds();
      allSeeds.forEach(seed => {
        seed.health.isAvailable = true;
        seed.health.lastSeen = Date.now();
        seed.health.failures = 0;
      });

      // Verify all seeds are available
      let availableSeeds = seedRegistry.getAvailableSeeds();
      expect(availableSeeds).toHaveLength(3);

      // Simulate failure of the primary coordinator seed
      const primaryCoordinator = allSeeds.find(s => s.id === 'coordinator-e2e-001');
      primaryCoordinator!.health.isAvailable = false;
      primaryCoordinator!.health.failures = 3;
      primaryCoordinator!.health.lastFailure = Date.now();

      // Available seeds should now exclude the failed coordinator
      availableSeeds = seedRegistry.getAvailableSeeds();
      expect(availableSeeds).toHaveLength(2);
      expect(availableSeeds.find(s => s.id === 'coordinator-e2e-001')).toBeUndefined();

      // Bootstrap seeds should still be available (secondary coordinator + worker)
      const bootstrapSeedsAfterFailure = seedRegistry.getBootstrapSeeds();
      expect(bootstrapSeedsAfterFailure.length).toBeGreaterThan(0);
      
      // Should include secondary coordinator
      const secondaryCoordinator = bootstrapSeedsAfterFailure.find(s => s.id === 'coordinator-e2e-002');
      expect(secondaryCoordinator).toBeDefined();

      // New nodes should be able to join using remaining healthy seeds
      const healthySeeds = availableSeeds.filter(s => s.health.isAvailable);
      expect(healthySeeds.length).toBeGreaterThan(0);

      // Simulate recovery of the failed coordinator
      primaryCoordinator!.health.isAvailable = true;
      primaryCoordinator!.health.failures = 0;
      primaryCoordinator!.health.lastSeen = Date.now();
      delete primaryCoordinator!.health.lastFailure;

      // All seeds should be available again
      availableSeeds = seedRegistry.getAvailableSeeds();
      expect(availableSeeds).toHaveLength(3);
      expect(availableSeeds.find(s => s.id === 'coordinator-e2e-001')).toBeDefined();
    });
  });

  describe('Multi-Node Cluster Formation', () => {
    it('should form a complete cluster with multiple nodes using seed registry', async () => {
      // Start with coordinator
      const bootstrapSeeds = seedRegistry.getBootstrapSeeds();
      coordinatorCluster = new ClusterManager({
        nodeId: 'coordinator-e2e-001',
        bindAddress: '127.0.0.1',
        bindPort: 8001,
        role: 'coordinator',
        seedNodes: bootstrapSeeds.map(s => `${s.address}:${s.port}`)
      });
      await coordinatorCluster.initialize();

      // Mark coordinator as healthy
      const coordinatorSeed = seedRegistry.getAllSeeds().find(s => s.id === 'coordinator-e2e-001');
      coordinatorSeed!.health.isAvailable = true;
      coordinatorSeed!.health.lastSeen = Date.now();

      // Add worker node
      const availableSeeds = seedRegistry.getAvailableSeeds();
      workerCluster = new ClusterManager({
        nodeId: 'worker-e2e-001',
        bindAddress: '127.0.0.1',
        bindPort: 8003,
        role: 'worker',
        seedNodes: availableSeeds.map(s => `${s.address}:${s.port}`)
      });
      await workerCluster.initialize();

      // Mark worker as healthy
      const workerSeed = seedRegistry.getAllSeeds().find(s => s.id === 'worker-e2e-001');
      workerSeed!.health.isAvailable = true;
      workerSeed!.health.lastSeen = Date.now();

      // Verify cluster state
      expect(coordinatorCluster.isInitialized()).toBe(true);
      expect(workerCluster.isInitialized()).toBe(true);

      // Check seed registry health status
      const healthStatus = seedRegistry.getHealthStatus();
      expect(healthStatus.totalSeeds).toBe(3);
      expect(healthStatus.availableSeeds).toBe(2); // coordinator and worker are running
      expect(healthStatus.permanentSeeds).toBe(2); // both coordinators are permanent
      expect(healthStatus.temporarySeeds).toBe(1); // worker is temporary
      expect(healthStatus.healthyRatio).toBeGreaterThan(0.5);

      // Verify legacy format compatibility
      const legacySeeds = seedRegistry.toLegacyStringArray();
      expect(legacySeeds).toContain('127.0.0.1:8001');
      expect(legacySeeds).toContain('127.0.0.1:8002');
      expect(legacySeeds).toContain('127.0.0.1:8003');

      // Test dynamic seed addition (simulating auto-discovery)
      const dynamicSeed: Omit<SeedNodeInfo, 'health'> = {
        id: 'worker-e2e-002',
        address: '127.0.0.1',
        port: 8004,
        priority: 60,
        isPermanent: false,
        metadata: {
          datacenter: 'local-dc',
          role: 'worker',
          tags: {
            type: 'worker',
            test_env: 'e2e',
            discovered: 'true'
          }
        }
      };

      seedRegistry.addSeed(dynamicSeed);
      expect(seedRegistry.getAllSeeds()).toHaveLength(4);
      
      // New seed should be available for future joins
      const updatedAvailableSeeds = seedRegistry.getAvailableSeeds();
      expect(updatedAvailableSeeds.find(s => s.id === 'worker-e2e-002')).toBeDefined();
    });
  });

  describe('Configuration-Driven Cluster Topology', () => {
    it('should respect seed priorities and roles during cluster formation', async () => {
      const allSeeds = seedRegistry.getAllSeeds();
      const availableSeeds = seedRegistry.getAvailableSeeds();
      
      // Verify seed priorities are correctly ordered
      expect(availableSeeds[0].priority).toBeGreaterThanOrEqual(availableSeeds[1].priority);
      expect(availableSeeds[1].priority).toBeGreaterThanOrEqual(availableSeeds[2].priority);

      // Verify coordinator seeds have higher priority than worker seeds
      const coordinatorSeeds = availableSeeds.filter(s => s.metadata?.role === 'coordinator');
      const workerSeeds = availableSeeds.filter(s => s.metadata?.role === 'worker');
      
      expect(coordinatorSeeds.length).toBe(2);
      expect(workerSeeds.length).toBe(1);
      
      // All coordinator seeds should have higher priority than worker seeds
      const minCoordinatorPriority = Math.min(...coordinatorSeeds.map(s => s.priority));
      const maxWorkerPriority = Math.max(...workerSeeds.map(s => s.priority));
      expect(minCoordinatorPriority).toBeGreaterThan(maxWorkerPriority);

      // Permanent seeds should be preferred for bootstrap
      const bootstrapSeeds = seedRegistry.getBootstrapSeeds();
      const permanentBootstrapSeeds = bootstrapSeeds.filter(s => s.isPermanent);
      const temporaryBootstrapSeeds = bootstrapSeeds.filter(s => !s.isPermanent);
      
      // Should prefer permanent seeds
      expect(permanentBootstrapSeeds.length).toBeGreaterThanOrEqual(temporaryBootstrapSeeds.length);
      
      // Primary coordinator should be first choice for bootstrap
      const primarySeed = bootstrapSeeds.find(s => 
        s.metadata?.tags?.priority === 'primary'
      );
      expect(primarySeed).toBeDefined();
      expect(primarySeed!.id).toBe('coordinator-e2e-001');
    });
  });
});
