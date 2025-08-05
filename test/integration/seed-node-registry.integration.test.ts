import { SeedNodeRegistry, SeedNodeInfo } from '../../src/cluster/seeding/SeedNodeRegistry';
import { YamlSeedConfiguration } from '../../src/config/YamlSeedConfiguration';
import { promises as fs } from 'fs';
import * as path from 'path';

describe('SeedNodeRegistry Integration Tests', () => {
  let registry: SeedNodeRegistry;
  let configuration: YamlSeedConfiguration;
  let tempYamlPath: string;

  const testYamlConfig = `
cluster:
  name: test-cluster
  environment: development

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - id: coordinator-001
          address: 10.0.1.100
          port: 7000
          priority: 100
          permanent: true
          datacenter: us-east-1a
          role: coordinator
          tags:
            type: coordinator
            priority: primary
        - id: coordinator-002
          address: 10.0.1.101
          port: 7000
          priority: 90
          permanent: true
          datacenter: us-east-1b
          role: coordinator
          tags:
            type: coordinator
            priority: secondary
        - id: worker-001
          address: 10.0.2.100
          port: 7000
          priority: 70
          permanent: false
          datacenter: us-east-1a
          role: worker
          tags:
            type: worker
            version: "1.0.0"
`;

  beforeEach(async () => {
    // Create temporary YAML file for testing
    tempYamlPath = path.join(process.cwd(), 'test', 'fixtures', 'temp-integration-seeds.yaml');
    await fs.writeFile(tempYamlPath, testYamlConfig, 'utf8');
    
    // Create YAML configuration and load seeds
    configuration = new YamlSeedConfiguration();
    await configuration.loadFromFile(tempYamlPath);
    
    // Create registry with health monitoring options
    registry = new SeedNodeRegistry({
      healthCheckInterval: 30000,
      maxFailures: 3,
      failureTimeout: 60000
    });
    
    // Convert YAML seeds to SeedNodeInfo and add to registry
    const yamlSeeds = configuration.toSeedNodes();
    yamlSeeds.forEach(yamlSeed => {
      registry.addSeed({
        id: yamlSeed.id,
        address: yamlSeed.address,
        port: yamlSeed.port,
        priority: yamlSeed.priority,
        isPermanent: yamlSeed.isPermanent,
        metadata: yamlSeed.metadata
      });
    });
  });

  afterEach(async () => {
    registry.stopHealthMonitoring();
    // Clean up temp file
    try {
      await fs.unlink(tempYamlPath);
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('YAML Configuration Integration', () => {
    it('should successfully load and manage seeds from YAML configuration', async () => {
      // Verify seeds were loaded correctly
      const allSeeds = registry.getAllSeeds();
      expect(allSeeds).toHaveLength(3);
      
      // Check coordinator-001 (highest priority permanent seed)
      const coordinatorSeed = allSeeds.find(s => s.id === 'coordinator-001');
      expect(coordinatorSeed).toBeDefined();
      expect(coordinatorSeed!.address).toBe('10.0.1.100');
      expect(coordinatorSeed!.port).toBe(7000);
      expect(coordinatorSeed!.metadata?.datacenter).toBe('us-east-1a');
      expect(coordinatorSeed!.priority).toBe(100);
      expect(coordinatorSeed!.isPermanent).toBe(true);
      expect(coordinatorSeed!.metadata?.role).toBe('coordinator');
      expect(coordinatorSeed!.metadata?.tags?.type).toBe('coordinator');

      // Check worker-001 (temporary seed)
      const workerSeed = allSeeds.find(s => s.id === 'worker-001');
      expect(workerSeed).toBeDefined();
      expect(workerSeed!.isPermanent).toBe(false);
      expect(workerSeed!.metadata?.role).toBe('worker');
      expect(workerSeed!.metadata?.tags?.version).toBe('1.0.0');
    });

    it('should properly prioritize seeds for bootstrap process', async () => {
      // Get available seeds (should be sorted by priority)
      const availableSeeds = registry.getAvailableSeeds();
      expect(availableSeeds).toHaveLength(3);
      expect(availableSeeds[0].id).toBe('coordinator-001'); // Highest priority
      expect(availableSeeds[1].id).toBe('coordinator-002'); // Second highest
      expect(availableSeeds[2].id).toBe('worker-001'); // Lowest priority

      // Get bootstrap seeds (should prefer permanent seeds)
      const bootstrapSeeds = registry.getBootstrapSeeds();
      expect(bootstrapSeeds.length).toBeGreaterThan(0);
      
      // Should include both permanent seeds since they're available
      const permanentBootstrapSeeds = bootstrapSeeds.filter(s => s.isPermanent);
      expect(permanentBootstrapSeeds).toHaveLength(2);
    });

    it('should filter seeds by region preference', async () => {
      // Get permanent seeds (used for regional filtering)
      const permanentSeeds = registry.getPermanentSeeds();
      expect(permanentSeeds).toHaveLength(2);
      
      // Both permanent seeds should be in different datacenters
      const usEast1aSeeds = permanentSeeds.filter(s => s.metadata?.datacenter === 'us-east-1a');
      const usEast1bSeeds = permanentSeeds.filter(s => s.metadata?.datacenter === 'us-east-1b');
      
      expect(usEast1aSeeds).toHaveLength(1);
      expect(usEast1bSeeds).toHaveLength(1);
    });
  });

  describe('Health Monitoring Integration', () => {
    it('should handle seed health state changes', async () => {
      // Initial state - all seeds should be available
      const initialAvailable = registry.getAvailableSeeds();
      expect(initialAvailable).toHaveLength(3);

      // Mark one seed as unhealthy
      const coordinatorSeed = registry.getAllSeeds().find(s => s.id === 'coordinator-001');
      expect(coordinatorSeed).toBeDefined();

      // Manually update health status (simulating health check failure)
      coordinatorSeed!.health.isAvailable = false;
      coordinatorSeed!.health.failures = 3;
      coordinatorSeed!.health.lastFailure = Date.now();

      // Available seeds should now exclude the unhealthy seed
      const updatedAvailable = registry.getAvailableSeeds();
      expect(updatedAvailable).toHaveLength(2);
      expect(updatedAvailable.find(s => s.id === 'coordinator-001')).toBeUndefined();
    });

    it('should maintain bootstrap capability with partial seed failures', async () => {
      // Start with all seeds available
      let bootstrapSeeds = registry.getBootstrapSeeds();
      const initialBootstrapCount = bootstrapSeeds.length;
      expect(initialBootstrapCount).toBeGreaterThan(0);

      // Mark one coordinator as unhealthy
      const coordinator1 = registry.getAllSeeds().find(s => s.id === 'coordinator-001');
      coordinator1!.health.isAvailable = false;

      // Should still have bootstrap seeds available
      bootstrapSeeds = registry.getBootstrapSeeds();
      expect(bootstrapSeeds.length).toBeGreaterThan(0);
      expect(bootstrapSeeds.length).toBeLessThan(initialBootstrapCount);

      // Verify healthy coordinator is still in bootstrap set
      expect(bootstrapSeeds.find(s => s.id === 'coordinator-002')).toBeDefined();
    });
  });

  describe('Legacy Format Compatibility', () => {
    it('should convert to legacy string array format', async () => {
      const legacyFormat = registry.toLegacyStringArray();
      expect(legacyFormat).toHaveLength(3);
      
      // Check format: "address:port"
      expect(legacyFormat).toContain('10.0.1.100:7000');
      expect(legacyFormat).toContain('10.0.1.101:7000');
      expect(legacyFormat).toContain('10.0.2.100:7000');
    });
  });

  describe('Dynamic Seed Management', () => {
    it('should support adding and removing seeds at runtime', async () => {
      const initialCount = registry.getAllSeeds().length;
      expect(initialCount).toBe(3);

      // Add a new temporary seed
      const newSeed: Omit<SeedNodeInfo, 'health'> = {
        id: 'dynamic-001',
        address: '10.0.3.100',
        port: 7000,
        priority: 50,
        isPermanent: false,
        metadata: {
          datacenter: 'us-west-1a',
          role: 'worker',
          tags: {
            dynamic: 'true',
            type: 'worker'
          }
        }
      };

      registry.addSeed(newSeed);
      expect(registry.getAllSeeds()).toHaveLength(4);

      // Remove the seed
      const removed = registry.removeSeed('dynamic-001');
      expect(removed).toBe(true);
      expect(registry.getAllSeeds()).toHaveLength(3);

      // Verify it's actually gone
      expect(registry.getAllSeeds().find(s => s.id === 'dynamic-001')).toBeUndefined();
    });
  });

  describe('Configuration Reload', () => {
    it('should handle configuration updates gracefully', async () => {
      const initialSeeds = registry.getAllSeeds();
      expect(initialSeeds).toHaveLength(3);

      // Update the YAML configuration
      const updatedYamlConfig = `
cluster:
  name: test-cluster-updated
  environment: development

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - id: coordinator-001
          address: 10.0.1.100
          port: 7000
          priority: 100
          permanent: true
          datacenter: us-east-1a
          role: coordinator
          tags:
            type: coordinator
            priority: primary
        - id: coordinator-003
          address: 10.0.1.102
          port: 7000
          priority: 85
          permanent: true
          datacenter: us-east-1c
          role: coordinator
          tags:
            type: coordinator
            priority: tertiary
`;

      // Write updated config and reload
      await fs.writeFile(tempYamlPath, updatedYamlConfig, 'utf8');
      const newConfiguration = new YamlSeedConfiguration();
      await newConfiguration.loadFromFile(tempYamlPath);

      // Create new registry with updated config
      const newRegistry = new SeedNodeRegistry({
        healthCheckInterval: 30000,
        maxFailures: 3,
        failureTimeout: 60000
      });
      
      // Add seeds from new configuration
      const newSeeds = newConfiguration.toSeedNodes();
      newSeeds.forEach(seed => {
        newRegistry.addSeed({
          id: seed.id,
          address: seed.address,
          port: seed.port,
          priority: seed.priority,
          isPermanent: seed.isPermanent,
          metadata: seed.metadata
        });
      });
      
      const updatedSeeds = newRegistry.getAllSeeds();
      
      expect(updatedSeeds).toHaveLength(2);
      expect(updatedSeeds.find(s => s.id === 'coordinator-001')).toBeDefined();
      expect(updatedSeeds.find(s => s.id === 'coordinator-003')).toBeDefined();
      expect(updatedSeeds.find(s => s.id === 'coordinator-002')).toBeUndefined();
      expect(updatedSeeds.find(s => s.id === 'worker-001')).toBeUndefined();

      newRegistry.stopHealthMonitoring();
    });
  });
});
