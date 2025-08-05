import * as yaml from 'js-yaml';
import { promises as fs } from 'fs';
import { EventEmitter } from 'events';
import { SeedNodeInfo } from '../cluster/seeding/SeedNodeRegistry';

/**
 * YAML Seed Configuration Schema (Cassandra-style)
 */
export interface YamlSeedConfig {
  /** Cluster configuration */
  cluster: {
    name: string;
    version?: string;
    environment?: 'development' | 'staging' | 'production';
  };

  /** Seed node definitions */
  seed_providers: Array<{
    /** Provider class name (for extensibility) */
    class_name: string;
    
    /** Seed provider parameters */
    parameters: {
      /** List of seed nodes */
      seeds: Array<{
        /** Seed node identifier */
        id?: string;
        
        /** Network address */
        address: string;
        
        /** Port number */
        port?: number;
        
        /** Priority (higher = preferred) */
        priority?: number;
        
        /** Whether this is a permanent seed */
        permanent?: boolean;
        
        /** Datacenter/region */
        datacenter?: string;
        
        /** Availability zone */
        zone?: string;
        
        /** Node role */
        role?: string;
        
        /** Additional tags */
        tags?: Record<string, string>;
      }>;
      
      /** Regional preferences */
      regional_preferences?: {
        /** Preferred region order */
        prefer_regions?: string[];
        
        /** Cross-region failover enabled */
        enable_cross_region?: boolean;
        
        /** Maximum cross-region seeds */
        max_cross_region_seeds?: number;
      };
      
      /** Load balancing strategy */
      load_balancing?: {
        /** Strategy: 'priority', 'round_robin', 'least_connections' */
        strategy?: 'priority' | 'round_robin' | 'least_connections';
        
        /** Maximum seeds to use simultaneously */
        max_concurrent_seeds?: number;
        
        /** Seed rotation interval (ms) */
        rotation_interval?: number;
      };
    };
  }>;

  /** Health monitoring configuration */
  health_monitoring?: {
    /** Enable health checks */
    enabled?: boolean;
    
    /** Health check interval (ms) */
    check_interval?: number;
    
    /** Maximum failures before marking unhealthy */
    max_failures?: number;
    
    /** Failure timeout for auto-recovery (ms) */
    failure_timeout?: number;
    
    /** Enable proactive health checks */
    proactive_checks?: boolean;
    
    /** Health check timeout (ms) */
    check_timeout?: number;
  };

  /** Bootstrap configuration */
  bootstrap?: {
    /** Join timeout (ms) */
    join_timeout?: number;
    
    /** Gossip interval (ms) */
    gossip_interval?: number;
    
    /** Maximum bootstrap retries */
    max_retries?: number;
    
    /** Retry backoff strategy */
    retry_backoff?: 'linear' | 'exponential';
    
    /** Enable legacy compatibility */
    legacy_compatibility?: boolean;
  };

  /** Environment-specific overrides */
  environments?: {
    [env: string]: Partial<YamlSeedConfig>;
  };
}

/**
 * YAML Seed Configuration Loader with Cassandra-style configuration support
 */
export class YamlSeedConfiguration extends EventEmitter {
  private config: YamlSeedConfig | null = null;
  private configPath: string | null = null;
  private currentEnvironment: string;

  constructor(environment: string = 'development') {
    super();
    this.currentEnvironment = environment;
  }

  // Expose EventEmitter methods for testing
  public on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  public emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  public once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  /**
   * Load configuration from YAML file
   */
  async loadFromFile(filePath: string): Promise<void> {
    try {
      const yamlContent = await fs.readFile(filePath, 'utf8');
      this.config = this.parseFromYaml(yamlContent);
      this.configPath = filePath;
      
      // Apply environment-specific overrides
      this.applyEnvironmentOverrides();
      
      this.emit('config-loaded', { filePath, config: this.config });
    } catch (error) {
      this.emit('config-error', { filePath, error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load YAML configuration from ${filePath}: ${errorMessage}`);
    }
  }

  /**
   * Parse YAML content into configuration object
   */
  parseFromYaml(yamlContent: string): YamlSeedConfig {
    try {
      const parsed = yaml.load(yamlContent) as YamlSeedConfig;
      this.validateConfiguration(parsed);
      return parsed;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse YAML configuration: ${errorMessage}`);
    }
  }

  /**
   * Convert configuration to seed nodes
   */
  toSeedNodes(): SeedNodeInfo[] {
    if (!this.config) {
      throw new Error('No configuration loaded');
    }

    const seedNodes: SeedNodeInfo[] = [];
    
    for (const provider of this.config.seed_providers) {
      if (provider.class_name === 'org.apache.cassandra.locator.SimpleSeedProvider') {
        for (const seed of provider.parameters.seeds) {
          const seedNode: SeedNodeInfo = {
            id: seed.id || `seed-${seed.address}-${seed.port || 8080}`,
            address: seed.address,
            port: seed.port || 8080,
            priority: seed.priority || 100,
            isPermanent: seed.permanent !== false,
            metadata: {
              datacenter: seed.datacenter,
              zone: seed.zone,
              role: seed.role,
              tags: seed.tags || {},
              source: 'yaml-config'
            },
            health: {
              isAvailable: true,
              lastSeen: Date.now(),
              failures: 0
            }
          };
          
          seedNodes.push(seedNode);
        }
      }
    }

    return seedNodes;
  }

  /**
   * Get health monitoring configuration
   */
  getHealthConfig() {
    return this.config?.health_monitoring || {};
  }

  /**
   * Get bootstrap configuration
   */
  getBootstrapConfig() {
    return this.config?.bootstrap || {};
  }

  /**
   * Get load balancing configuration
   */
  getLoadBalancingConfig() {
    const provider = this.config?.seed_providers?.[0];
    return provider?.parameters?.load_balancing || {};
  }

  /**
   * Get regional preferences
   */
  getRegionalPreferences() {
    const provider = this.config?.seed_providers?.[0];
    return provider?.parameters?.regional_preferences || {};
  }

  /**
   * Convert to legacy string array format
   */
  toLegacyStringArray(): string[] {
    return this.toSeedNodes().map(seed => `${seed.address}:${seed.port}`);
  }

  /**
   * Save configuration to YAML file
   */
  async saveToFile(filePath: string): Promise<void> {
    if (!this.config) {
      throw new Error('No configuration to save');
    }

    try {
      const yamlContent = yaml.dump(this.config, {
        indent: 2,
        lineWidth: 100,
        quotingType: '"',
        forceQuotes: false
      });
      
      await fs.writeFile(filePath, yamlContent, 'utf8');
      this.emit('config-saved', { filePath });
    } catch (error) {
      this.emit('config-error', { filePath, error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to save YAML configuration to ${filePath}: ${errorMessage}`);
    }
  }

  /**
   * Create configuration from seed nodes
   */
  static fromSeedNodes(
    seedNodes: SeedNodeInfo[], 
    clusterName: string = 'distributed-cluster',
    environment: string = 'development'
  ): YamlSeedConfig {
    return {
      cluster: {
        name: clusterName,
        version: '1.0.0',
        environment: environment as any
      },
      seed_providers: [{
        class_name: 'org.apache.cassandra.locator.SimpleSeedProvider',
        parameters: {
          seeds: seedNodes.map(seed => ({
            id: seed.id,
            address: seed.address,
            port: seed.port,
            priority: seed.priority,
            permanent: seed.isPermanent,
            datacenter: seed.metadata?.datacenter,
            zone: seed.metadata?.zone,
            role: seed.metadata?.role,
            tags: seed.metadata?.tags
          }))
        }
      }],
      health_monitoring: {
        enabled: true,
        check_interval: 30000,
        max_failures: 3,
        failure_timeout: 60000,
        proactive_checks: true,
        check_timeout: 5000
      },
      bootstrap: {
        join_timeout: 10000,
        gossip_interval: 1000,
        max_retries: 3,
        retry_backoff: 'exponential',
        legacy_compatibility: true
      }
    };
  }

  /**
   * Merge configurations with precedence
   */
  static mergeConfigurations(base: YamlSeedConfig, override: Partial<YamlSeedConfig>): YamlSeedConfig {
    return {
      cluster: { ...base.cluster, ...override.cluster },
      seed_providers: override.seed_providers || base.seed_providers,
      health_monitoring: { ...base.health_monitoring, ...override.health_monitoring },
      bootstrap: { ...base.bootstrap, ...override.bootstrap },
      environments: { ...base.environments, ...override.environments }
    };
  }

  /**
   * Validate configuration structure
   */
  private validateConfiguration(config: any): void {
    if (!config.cluster?.name) {
      throw new Error('cluster.name is required');
    }

    if (!Array.isArray(config.seed_providers) || config.seed_providers.length === 0) {
      throw new Error('seed_providers array is required and must not be empty');
    }

    for (const provider of config.seed_providers) {
      if (!provider.class_name) {
        throw new Error('seed_provider.class_name is required');
      }

      if (!Array.isArray(provider.parameters?.seeds)) {
        throw new Error('seed_provider.parameters.seeds must be an array');
      }

      for (const seed of provider.parameters.seeds) {
        if (!seed.address) {
          throw new Error('seed.address is required');
        }
      }
    }
  }

  /**
   * Apply environment-specific configuration overrides
   */
  private applyEnvironmentOverrides(): void {
    if (!this.config?.environments?.[this.currentEnvironment]) {
      return;
    }

    const envOverrides = this.config.environments[this.currentEnvironment];
    this.config = YamlSeedConfiguration.mergeConfigurations(this.config, envOverrides);
  }

  /**
   * Get current configuration
   */
  getConfig(): YamlSeedConfig | null {
    return this.config;
  }

  /**
   * Set environment for configuration overrides
   */
  setEnvironment(environment: string): void {
    this.currentEnvironment = environment;
    if (this.config) {
      this.applyEnvironmentOverrides();
    }
  }
}
