import { YamlSeedConfiguration, YamlSeedConfig } from '../../../src/config/YamlSeedConfiguration';
import { SeedNodeInfo } from '../../../src/cluster/seeding/SeedNodeRegistry';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('YamlSeedConfiguration', () => {
  let yamlConfig: YamlSeedConfiguration;
  let tempDir: string;
  let tempFile: string;

  beforeEach(async () => {
    yamlConfig = new YamlSeedConfiguration('development');
    
    // Create temporary directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaml-config-test-'));
    tempFile = path.join(tempDir, 'test-config.yaml');
  });

  afterEach(async () => {
    // Clean up temporary files
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Constructor', () => {
    it('should initialize with default development environment', () => {
      const config = new YamlSeedConfiguration();
      expect(config['currentEnvironment']).toBe('development');
    });

    it('should initialize with specified environment', () => {
      const config = new YamlSeedConfiguration('production');
      expect(config['currentEnvironment']).toBe('production');
    });

    it('should extend EventEmitter', () => {
      expect(yamlConfig.on).toBeDefined();
      expect(yamlConfig.emit).toBeDefined();
    });
  });

  describe('parseFromYaml', () => {
    it('should parse valid YAML configuration', () => {
      const yamlContent = `
cluster:
  name: test-cluster
  environment: development

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - address: 192.168.1.10
          port: 8080
          priority: 100
        - address: 192.168.1.11
          port: 8080
          priority: 90
`;

      const config = yamlConfig.parseFromYaml(yamlContent);
      
      expect(config.cluster.name).toBe('test-cluster');
      expect(config.cluster.environment).toBe('development');
      expect(config.seed_providers).toHaveLength(1);
      expect(config.seed_providers[0].parameters.seeds).toHaveLength(2);
      expect(config.seed_providers[0].parameters.seeds[0].address).toBe('192.168.1.10');
    });

    it('should handle complex configuration with all options', () => {
      const yamlContent = `
cluster:
  name: production-cluster
  version: "2.0.0"
  environment: production

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - id: seed-001
          address: 10.0.1.10
          port: 8080
          priority: 100
          permanent: true
          datacenter: us-east-1
          zone: us-east-1a
          role: coordinator
          tags:
            rack: "A"
            instance_type: "m5.large"
        - id: seed-002
          address: 10.0.2.10
          port: 8080
          priority: 95
          datacenter: us-west-2
          zone: us-west-2a
      regional_preferences:
        prefer_regions:
          - us-east-1
          - us-west-2
        enable_cross_region: true
        max_cross_region_seeds: 2
      load_balancing:
        strategy: priority
        max_concurrent_seeds: 3
        rotation_interval: 30000

health_monitoring:
  enabled: true
  check_interval: 30000
  max_failures: 3
  failure_timeout: 60000
  proactive_checks: true
  check_timeout: 5000

bootstrap:
  join_timeout: 10000
  gossip_interval: 1000
  max_retries: 3
  retry_backoff: exponential
  legacy_compatibility: true
`;

      const config = yamlConfig.parseFromYaml(yamlContent);
      
      expect(config.cluster.name).toBe('production-cluster');
      expect(config.cluster.version).toBe('2.0.0');
      expect(config.seed_providers[0].parameters.regional_preferences?.prefer_regions).toEqual(['us-east-1', 'us-west-2']);
      expect(config.health_monitoring?.enabled).toBe(true);
      expect(config.bootstrap?.retry_backoff).toBe('exponential');
    });

    it('should throw error for invalid YAML', () => {
      const invalidYaml = `
cluster:
  name: test-cluster
  invalid: [unclosed array
`;

      expect(() => yamlConfig.parseFromYaml(invalidYaml)).toThrow('Failed to parse YAML configuration');
    });

    it('should throw error for missing required fields', () => {
      const incompleteYaml = `
cluster:
  version: "1.0.0"
`;

      expect(() => yamlConfig.parseFromYaml(incompleteYaml)).toThrow('cluster.name is required');
    });

    it('should throw error for missing seed providers', () => {
      const noSeedsYaml = `
cluster:
  name: test-cluster
`;

      expect(() => yamlConfig.parseFromYaml(noSeedsYaml)).toThrow('seed_providers array is required');
    });

    it('should throw error for empty seed providers', () => {
      const emptySeedsYaml = `
cluster:
  name: test-cluster
seed_providers: []
`;

      expect(() => yamlConfig.parseFromYaml(emptySeedsYaml)).toThrow('seed_providers array is required and must not be empty');
    });

    it('should throw error for seed provider without class_name', () => {
      const noClassNameYaml = `
cluster:
  name: test-cluster
seed_providers:
  - parameters:
      seeds:
        - address: 192.168.1.10
`;

      expect(() => yamlConfig.parseFromYaml(noClassNameYaml)).toThrow('seed_provider.class_name is required');
    });

    it('should throw error for seed without address', () => {
      const noAddressYaml = `
cluster:
  name: test-cluster
seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - port: 8080
`;

      expect(() => yamlConfig.parseFromYaml(noAddressYaml)).toThrow('seed.address is required');
    });
  });

  describe('loadFromFile', () => {
    it('should load configuration from YAML file', async () => {
      const yamlContent = `
cluster:
  name: file-test-cluster
  environment: development

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - address: 192.168.1.10
          port: 8080
`;

      await fs.writeFile(tempFile, yamlContent);
      
      const configLoadedPromise = new Promise((resolve) => {
        yamlConfig.once('config-loaded', resolve);
      });

      await yamlConfig.loadFromFile(tempFile);
      
      await configLoadedPromise;
      
      const config = yamlConfig.getConfig();
      expect(config?.cluster.name).toBe('file-test-cluster');
    });

    it('should emit config-error event on file read error', async () => {
      const nonExistentFile = path.join(tempDir, 'non-existent.yaml');
      
      const errorPromise = new Promise((resolve) => {
        yamlConfig.once('config-error', resolve);
      });

      await expect(yamlConfig.loadFromFile(nonExistentFile)).rejects.toThrow();
      await errorPromise;
    });

    it('should apply environment overrides after loading', async () => {
      const yamlContent = `
cluster:
  name: env-test-cluster
  environment: development

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - address: 192.168.1.10
          port: 8080

environments:
  production:
    cluster:
      name: env-test-cluster-prod
    health_monitoring:
      check_interval: 60000
`;

      await fs.writeFile(tempFile, yamlContent);
      
      const prodConfig = new YamlSeedConfiguration('production');
      await prodConfig.loadFromFile(tempFile);
      
      const config = prodConfig.getConfig();
      expect(config?.cluster.name).toBe('env-test-cluster-prod');
      expect(config?.health_monitoring?.check_interval).toBe(60000);
    });
  });

  describe('toSeedNodes', () => {
    beforeEach(async () => {
      const yamlContent = `
cluster:
  name: seed-test-cluster

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - id: seed-001
          address: 192.168.1.10
          port: 8080
          priority: 100
          permanent: true
          datacenter: us-east-1
          zone: us-east-1a
          role: coordinator
          tags:
            rack: "A"
        - address: 192.168.1.11
          port: 8081
          priority: 90
`;

      await fs.writeFile(tempFile, yamlContent);
      await yamlConfig.loadFromFile(tempFile);
    });

    it('should convert configuration to SeedNodeInfo array', () => {
      const seedNodes = yamlConfig.toSeedNodes();
      
      expect(seedNodes).toHaveLength(2);
      
      const firstSeed = seedNodes[0];
      expect(firstSeed.id).toBe('seed-001');
      expect(firstSeed.address).toBe('192.168.1.10');
      expect(firstSeed.port).toBe(8080);
      expect(firstSeed.priority).toBe(100);
      expect(firstSeed.isPermanent).toBe(true);
      expect(firstSeed.metadata?.datacenter).toBe('us-east-1');
      expect(firstSeed.metadata?.zone).toBe('us-east-1a');
      expect(firstSeed.metadata?.role).toBe('coordinator');
      expect(firstSeed.metadata?.tags).toEqual({ rack: 'A' });
      expect(firstSeed.metadata?.source).toBe('yaml-config');
      expect(firstSeed.health.isAvailable).toBe(true);
      
      const secondSeed = seedNodes[1];
      expect(secondSeed.id).toBe('seed-192.168.1.11-8081');
      expect(secondSeed.address).toBe('192.168.1.11');
      expect(secondSeed.port).toBe(8081);
      expect(secondSeed.priority).toBe(90);
      expect(secondSeed.isPermanent).toBe(true); // default
    });

    it('should throw error when no configuration loaded', () => {
      const emptyConfig = new YamlSeedConfiguration();
      expect(() => emptyConfig.toSeedNodes()).toThrow('No configuration loaded');
    });

    it('should handle default values correctly', () => {
      const yamlContent = `
cluster:
  name: defaults-test

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - address: 10.0.0.1
`;

      const config = yamlConfig.parseFromYaml(yamlContent);
      yamlConfig['config'] = config;
      
      const seedNodes = yamlConfig.toSeedNodes();
      const seed = seedNodes[0];
      
      expect(seed.id).toBe('seed-10.0.0.1-8080');
      expect(seed.port).toBe(8080);
      expect(seed.priority).toBe(100);
      expect(seed.isPermanent).toBe(true);
      expect(seed.metadata?.tags).toEqual({});
    });
  });

  describe('Configuration getters', () => {
    beforeEach(async () => {
      const yamlContent = `
cluster:
  name: getters-test

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - address: 192.168.1.10
      load_balancing:
        strategy: round_robin
        max_concurrent_seeds: 5
      regional_preferences:
        prefer_regions: ["us-east-1"]

health_monitoring:
  enabled: true
  check_interval: 45000

bootstrap:
  join_timeout: 15000
  max_retries: 5
`;

      await fs.writeFile(tempFile, yamlContent);
      await yamlConfig.loadFromFile(tempFile);
    });

    it('should get health monitoring configuration', () => {
      const healthConfig = yamlConfig.getHealthConfig();
      expect(healthConfig.enabled).toBe(true);
      expect(healthConfig.check_interval).toBe(45000);
    });

    it('should get bootstrap configuration', () => {
      const bootstrapConfig = yamlConfig.getBootstrapConfig();
      expect(bootstrapConfig.join_timeout).toBe(15000);
      expect(bootstrapConfig.max_retries).toBe(5);
    });

    it('should get load balancing configuration', () => {
      const lbConfig = yamlConfig.getLoadBalancingConfig();
      expect(lbConfig.strategy).toBe('round_robin');
      expect(lbConfig.max_concurrent_seeds).toBe(5);
    });

    it('should get regional preferences', () => {
      const regionalConfig = yamlConfig.getRegionalPreferences();
      expect(regionalConfig.prefer_regions).toEqual(['us-east-1']);
    });

    it('should return empty objects for missing configurations', () => {
      const emptyConfig = new YamlSeedConfiguration();
      const yamlContent = `
cluster:
  name: minimal-test
seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - address: 192.168.1.10
`;
      
      const config = emptyConfig.parseFromYaml(yamlContent);
      emptyConfig['config'] = config;
      
      expect(emptyConfig.getHealthConfig()).toEqual({});
      expect(emptyConfig.getBootstrapConfig()).toEqual({});
      expect(emptyConfig.getLoadBalancingConfig()).toEqual({});
      expect(emptyConfig.getRegionalPreferences()).toEqual({});
    });
  });

  describe('toLegacyStringArray', () => {
    it('should convert to legacy string array format', async () => {
      const yamlContent = `
cluster:
  name: legacy-test

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - address: 192.168.1.10
          port: 8080
        - address: 192.168.1.11
          port: 8081
        - address: 192.168.1.12
`;

      await fs.writeFile(tempFile, yamlContent);
      await yamlConfig.loadFromFile(tempFile);
      
      const legacyArray = yamlConfig.toLegacyStringArray();
      expect(legacyArray).toEqual([
        '192.168.1.10:8080',
        '192.168.1.11:8081',
        '192.168.1.12:8080'
      ]);
    });
  });

  describe('saveToFile', () => {
    it('should save configuration to YAML file', async () => {
      const yamlContent = `
cluster:
  name: save-test

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - address: 192.168.1.10
`;

      await fs.writeFile(tempFile, yamlContent);
      await yamlConfig.loadFromFile(tempFile);
      
      const outputFile = path.join(tempDir, 'output.yaml');
      
      const configSavedPromise = new Promise((resolve) => {
        yamlConfig.once('config-saved', resolve);
      });
      
      await yamlConfig.saveToFile(outputFile);
      await configSavedPromise;
      
      const savedContent = await fs.readFile(outputFile, 'utf8');
      expect(savedContent).toContain('name: save-test');
      expect(savedContent).toContain('address: 192.168.1.10');
    });

    it('should throw error when no configuration to save', async () => {
      const emptyConfig = new YamlSeedConfiguration();
      const outputFile = path.join(tempDir, 'output.yaml');
      
      await expect(emptyConfig.saveToFile(outputFile)).rejects.toThrow('No configuration to save');
    });
  });

  describe('Static methods', () => {
    describe('fromSeedNodes', () => {
      it('should create configuration from seed nodes', () => {
        const seedNodes: SeedNodeInfo[] = [
          {
            id: 'seed-001',
            address: '192.168.1.10',
            port: 8080,
            priority: 100,
            isPermanent: true,
            metadata: {
              datacenter: 'us-east-1',
              zone: 'us-east-1a',
              role: 'coordinator',
              tags: { rack: 'A' },
              source: 'manual'
            },
            health: {
              isAvailable: true,
              lastSeen: Date.now(),
              failures: 0
            }
          },
          {
            id: 'seed-002',
            address: '192.168.1.11',
            port: 8081,
            priority: 90,
            isPermanent: false,
            metadata: {
              datacenter: 'us-west-2',
              tags: {},
              source: 'discovery'
            },
            health: {
              isAvailable: true,
              lastSeen: Date.now(),
              failures: 0
            }
          }
        ];

        const config = YamlSeedConfiguration.fromSeedNodes(seedNodes, 'test-cluster', 'staging');
        
        expect(config.cluster.name).toBe('test-cluster');
        expect(config.cluster.environment).toBe('staging');
        expect(config.seed_providers).toHaveLength(1);
        expect(config.seed_providers[0].parameters.seeds).toHaveLength(2);
        
        const firstSeed = config.seed_providers[0].parameters.seeds[0];
        expect(firstSeed.id).toBe('seed-001');
        expect(firstSeed.address).toBe('192.168.1.10');
        expect(firstSeed.datacenter).toBe('us-east-1');
        expect(firstSeed.permanent).toBe(true);
      });

      it('should use default values when not specified', () => {
        const seedNodes: SeedNodeInfo[] = [
          {
            id: 'seed-001',
            address: '192.168.1.10',
            port: 8080,
            priority: 100,
            isPermanent: true,
            metadata: { tags: {}, source: 'test' },
            health: { isAvailable: true, lastSeen: Date.now(), failures: 0 }
          }
        ];

        const config = YamlSeedConfiguration.fromSeedNodes(seedNodes);
        
        expect(config.cluster.name).toBe('distributed-cluster');
        expect(config.cluster.environment).toBe('development');
        expect(config.health_monitoring?.enabled).toBe(true);
        expect(config.bootstrap?.legacy_compatibility).toBe(true);
      });
    });

    describe('mergeConfigurations', () => {
      it('should merge configurations with override precedence', () => {
        const baseConfig: YamlSeedConfig = {
          cluster: { name: 'base-cluster', environment: 'development' },
          seed_providers: [{
            class_name: 'base-provider',
            parameters: { seeds: [{ address: '192.168.1.10' }] }
          }],
          health_monitoring: { enabled: true, check_interval: 30000 },
          bootstrap: { join_timeout: 10000 }
        };

        const overrideConfig: Partial<YamlSeedConfig> = {
          cluster: { name: 'override-cluster' },
          health_monitoring: { check_interval: 60000, max_failures: 5 },
          bootstrap: { max_retries: 5 }
        };

        const merged = YamlSeedConfiguration.mergeConfigurations(baseConfig, overrideConfig);
        
        expect(merged.cluster.name).toBe('override-cluster');
        expect(merged.cluster.environment).toBe('development'); // preserved from base
        expect(merged.health_monitoring?.enabled).toBe(true); // preserved from base
        expect(merged.health_monitoring?.check_interval).toBe(60000); // overridden
        expect(merged.health_monitoring?.max_failures).toBe(5); // added from override
        expect(merged.bootstrap?.join_timeout).toBe(10000); // preserved from base
        expect(merged.bootstrap?.max_retries).toBe(5); // added from override
      });

      it('should handle complete override of seed providers', () => {
        const baseConfig: YamlSeedConfig = {
          cluster: { name: 'base-cluster' },
          seed_providers: [{
            class_name: 'base-provider',
            parameters: { seeds: [{ address: '192.168.1.10' }] }
          }]
        };

        const overrideConfig: Partial<YamlSeedConfig> = {
          seed_providers: [{
            class_name: 'override-provider',
            parameters: { seeds: [{ address: '10.0.0.1' }] }
          }]
        };

        const merged = YamlSeedConfiguration.mergeConfigurations(baseConfig, overrideConfig);
        
        expect(merged.seed_providers[0].class_name).toBe('override-provider');
        expect(merged.seed_providers[0].parameters.seeds[0].address).toBe('10.0.0.1');
      });
    });
  });

  describe('Environment handling', () => {
    it('should set and apply new environment', async () => {
      const yamlContent = `
cluster:
  name: env-change-test
  environment: development

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - address: 192.168.1.10

environments:
  production:
    cluster:
      name: env-change-test-prod
    health_monitoring:
      check_interval: 120000
`;

      await fs.writeFile(tempFile, yamlContent);
      await yamlConfig.loadFromFile(tempFile);
      
      // Initially development
      expect(yamlConfig.getConfig()?.cluster.name).toBe('env-change-test');
      
      // Change to production
      yamlConfig.setEnvironment('production');
      expect(yamlConfig.getConfig()?.cluster.name).toBe('env-change-test-prod');
      expect(yamlConfig.getConfig()?.health_monitoring?.check_interval).toBe(120000);
    });

    it('should handle non-existent environment gracefully', () => {
      const config: YamlSeedConfig = {
        cluster: { name: 'test-cluster' },
        seed_providers: [{
          class_name: 'test-provider',
          parameters: { seeds: [{ address: '192.168.1.10' }] }
        }]
      };

      yamlConfig['config'] = config;
      
      // Should not throw or change config
      yamlConfig.setEnvironment('non-existent');
      expect(yamlConfig.getConfig()?.cluster.name).toBe('test-cluster');
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle configuration with no optional fields', () => {
      const minimalYaml = `
cluster:
  name: minimal-cluster

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - address: 192.168.1.10
`;

      const config = yamlConfig.parseFromYaml(minimalYaml);
      expect(config.cluster.name).toBe('minimal-cluster');
      expect(config.health_monitoring).toBeUndefined();
      expect(config.bootstrap).toBeUndefined();
    });

    it('should handle multiple seed providers', () => {
      const multiProviderYaml = `
cluster:
  name: multi-provider-test

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - address: 192.168.1.10
  - class_name: org.apache.cassandra.locator.Ec2SeedProvider
    parameters:
      seeds:
        - address: 10.0.0.1
`;

      const config = yamlConfig.parseFromYaml(multiProviderYaml);
      expect(config.seed_providers).toHaveLength(2);
      expect(config.seed_providers[0].class_name).toBe('org.apache.cassandra.locator.SimpleSeedProvider');
      expect(config.seed_providers[1].class_name).toBe('org.apache.cassandra.locator.Ec2SeedProvider');
    });

    it('should handle seeds with all optional fields missing', () => {
      const basicSeedYaml = `
cluster:
  name: basic-seed-test

seed_providers:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      seeds:
        - address: 192.168.1.10
        - address: 192.168.1.11
          port: 8081
`;

      const config = yamlConfig.parseFromYaml(basicSeedYaml);
      yamlConfig['config'] = config;
      
      const seedNodes = yamlConfig.toSeedNodes();
      expect(seedNodes).toHaveLength(2);
      
      // First seed with all defaults
      expect(seedNodes[0].port).toBe(8080);
      expect(seedNodes[0].priority).toBe(100);
      expect(seedNodes[0].isPermanent).toBe(true);
      
      // Second seed with custom port
      expect(seedNodes[1].port).toBe(8081);
    });
  });
});
