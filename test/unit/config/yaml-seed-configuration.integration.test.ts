import { YamlSeedConfiguration } from '../../../src/config/YamlSeedConfiguration';
import * as path from 'path';

describe('YamlSeedConfiguration Integration with Example Files', () => {
  const configExamplesDir = path.join(__dirname, '../fixtures/config-examples');

  describe('Cassandra-style configuration', () => {
    it('should load and parse the production-style configuration', async () => {
      const yamlConfig = new YamlSeedConfiguration('production');
      const configPath = path.join(configExamplesDir, 'cassandra-style-seeds.yaml');
      
      await yamlConfig.loadFromFile(configPath);
      
      const config = yamlConfig.getConfig();
      expect(config).toBeDefined();
      expect(config!.cluster.name).toBe('distributed-production-cluster');
      expect(config!.cluster.environment).toBe('production');
      
      // Test seed nodes conversion
      const seedNodes = yamlConfig.toSeedNodes();
      expect(seedNodes).toHaveLength(4);
      
      // Test coordinator nodes
      const coordinator1 = seedNodes.find(s => s.id === 'coordinator-001');
      expect(coordinator1).toBeDefined();
      expect(coordinator1!.address).toBe('10.0.1.10');
      expect(coordinator1!.priority).toBe(100);
      expect(coordinator1!.isPermanent).toBe(true);
      expect(coordinator1!.metadata?.datacenter).toBe('us-east-1');
      expect(coordinator1!.metadata?.role).toBe('coordinator');
      
      // Test cross-region seed
      const westCoordinator = seedNodes.find(s => s.id === 'coordinator-west-001');
      expect(westCoordinator).toBeDefined();
      expect(westCoordinator!.metadata?.datacenter).toBe('us-west-2');
      expect(westCoordinator!.priority).toBe(90);
      
      // Test worker node
      const worker = seedNodes.find(s => s.id === 'worker-001');
      expect(worker).toBeDefined();
      expect(worker!.isPermanent).toBe(false);
      expect(worker!.metadata?.role).toBe('worker');
    });

    it('should apply environment-specific overrides', async () => {
      const devConfig = new YamlSeedConfiguration('development');
      const configPath = path.join(configExamplesDir, 'cassandra-style-seeds.yaml');
      
      await devConfig.loadFromFile(configPath);
      
      const config = devConfig.getConfig();
      expect(config!.cluster.name).toBe('distributed-dev-cluster');
      expect(config!.health_monitoring?.check_interval).toBe(10000);
      expect(config!.bootstrap?.max_retries).toBe(10);
    });

    it('should get regional preferences correctly', async () => {
      const yamlConfig = new YamlSeedConfiguration('production');
      const configPath = path.join(configExamplesDir, 'cassandra-style-seeds.yaml');
      
      await yamlConfig.loadFromFile(configPath);
      
      const regionalConfig = yamlConfig.getRegionalPreferences();
      expect(regionalConfig.prefer_regions).toEqual(['us-east-1', 'us-west-2', 'eu-west-1']);
      expect(regionalConfig.enable_cross_region).toBe(true);
      expect(regionalConfig.max_cross_region_seeds).toBe(2);
    });

    it('should get load balancing configuration correctly', async () => {
      const yamlConfig = new YamlSeedConfiguration('production');
      const configPath = path.join(configExamplesDir, 'cassandra-style-seeds.yaml');
      
      await yamlConfig.loadFromFile(configPath);
      
      const lbConfig = yamlConfig.getLoadBalancingConfig();
      expect(lbConfig.strategy).toBe('priority');
      expect(lbConfig.max_concurrent_seeds).toBe(3);
      expect(lbConfig.rotation_interval).toBe(30000);
    });
  });

  describe('Simple development configuration', () => {
    it('should load and parse the simple dev configuration', async () => {
      const yamlConfig = new YamlSeedConfiguration('development');
      const configPath = path.join(configExamplesDir, 'simple-dev-seeds.yaml');
      
      await yamlConfig.loadFromFile(configPath);
      
      const config = yamlConfig.getConfig();
      expect(config!.cluster.name).toBe('local-dev-cluster');
      expect(config!.cluster.environment).toBe('development');
      
      // Test seed nodes
      const seedNodes = yamlConfig.toSeedNodes();
      expect(seedNodes).toHaveLength(3);
      
      seedNodes.forEach((seed, index) => {
        expect(seed.address).toBe('localhost');
        expect(seed.port).toBe(8080 + index);
        expect(seed.priority).toBe(100);
      });
      
      // Test legacy string array conversion
      const legacyArray = yamlConfig.toLegacyStringArray();
      expect(legacyArray).toEqual([
        'localhost:8080',
        'localhost:8081',
        'localhost:8082'
      ]);
    });

    it('should get health monitoring configuration', async () => {
      const yamlConfig = new YamlSeedConfiguration('development');
      const configPath = path.join(configExamplesDir, 'simple-dev-seeds.yaml');
      
      await yamlConfig.loadFromFile(configPath);
      
      const healthConfig = yamlConfig.getHealthConfig();
      expect(healthConfig.enabled).toBe(true);
      expect(healthConfig.check_interval).toBe(10000);
      expect(healthConfig.max_failures).toBe(5);
    });
  });

  describe('Configuration conversion', () => {
    it('should convert seed nodes back to YAML configuration', async () => {
      const yamlConfig = new YamlSeedConfiguration('development');
      const configPath = path.join(configExamplesDir, 'simple-dev-seeds.yaml');
      
      await yamlConfig.loadFromFile(configPath);
      
      // Get seed nodes and convert back to config
      const seedNodes = yamlConfig.toSeedNodes();
      const newConfig = YamlSeedConfiguration.fromSeedNodes(
        seedNodes,
        'converted-cluster',
        'development'
      );
      
      expect(newConfig.cluster.name).toBe('converted-cluster');
      expect(newConfig.cluster.environment).toBe('development');
      expect(newConfig.seed_providers[0].parameters.seeds).toHaveLength(3);
      
      // Verify addresses are preserved
      const addresses = newConfig.seed_providers[0].parameters.seeds.map(s => s.address);
      expect(addresses).toEqual(['localhost', 'localhost', 'localhost']);
    });

    it('should merge configurations correctly', async () => {
      const yamlConfig = new YamlSeedConfiguration('production');
      const configPath = path.join(configExamplesDir, 'cassandra-style-seeds.yaml');
      
      await yamlConfig.loadFromFile(configPath);
      
      const baseConfig = yamlConfig.getConfig()!;
      const override = {
        cluster: { name: 'merged-cluster' },
        health_monitoring: { check_interval: 45000 }
      };
      
      const merged = YamlSeedConfiguration.mergeConfigurations(baseConfig, override);
      
      expect(merged.cluster.name).toBe('merged-cluster');
      expect(merged.cluster.environment).toBe('production'); // preserved
      expect(merged.health_monitoring?.check_interval).toBe(45000); // overridden
      expect(merged.health_monitoring?.enabled).toBe(true); // preserved
    });
  });
});
