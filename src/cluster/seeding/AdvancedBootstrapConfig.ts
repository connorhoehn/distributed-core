import { EventEmitter } from 'events';
import { BootstrapConfig, FailureDetectorOptions, KeyManagerOptions, LifecycleOptions } from '../config/BootstrapConfig';
import { SeedNodeRegistry, SeedNodeInfo } from './SeedNodeRegistry';
import { SeedNodeDiscovery, SeedDiscoveryConfig } from './SeedNodeDiscovery';

export interface AdvancedBootstrapOptions {
  /** Join timeout in milliseconds */
  joinTimeout?: number;
  
  /** Gossip interval in milliseconds */
  gossipInterval?: number;
  
  /** Enable logging */
  enableLogging?: boolean;
  
  /** Failure detector options */
  failureDetector?: FailureDetectorOptions;
  
  /** Key manager options */
  keyManager?: KeyManagerOptions;
  
  /** Lifecycle options */
  lifecycle?: LifecycleOptions;
  
  /** Structured seed nodes (replaces string array) */
  seedNodes?: SeedNodeInfo[];
  
  /** Legacy seed node strings for backward compatibility */
  legacySeedNodes?: string[];
  
  /** Seed discovery configuration */
  seedDiscovery?: {
    enabled?: boolean;
    interval?: number;
    strategies?: SeedDiscoveryConfig[];
  };
  
  /** Seed health monitoring configuration */
  seedHealth?: {
    enabled?: boolean;
    healthCheckInterval?: number;
    maxFailures?: number;
    failureTimeout?: number;
  };
}

/**
 * Bootstrap configuration with advanced seed node management capabilities
 */
export class AdvancedBootstrapConfig extends EventEmitter {
  readonly legacyConfig: BootstrapConfig;
  readonly seedRegistry: SeedNodeRegistry;
  readonly seedDiscovery: SeedNodeDiscovery;
  
  private readonly seedHealthEnabled: boolean;
  private readonly seedDiscoveryEnabled: boolean;

  constructor(options: AdvancedBootstrapOptions = {}) {
    super();
    
    // Create legacy seed nodes array for backward compatibility
    const legacySeeds = options.legacySeedNodes || [];
    
    this.legacyConfig = new BootstrapConfig(
      legacySeeds,
      options.joinTimeout || 5000,
      options.gossipInterval || 1000,
      options.enableLogging || false,
      options.failureDetector || {},
      options.keyManager || {},
      options.lifecycle || {}
    );

    // Initialize seed registry
    this.seedRegistry = new SeedNodeRegistry({
      healthCheckInterval: options.seedHealth?.healthCheckInterval,
      maxFailures: options.seedHealth?.maxFailures,
      failureTimeout: options.seedHealth?.failureTimeout
    });

    // Initialize seed discovery
    this.seedDiscovery = new SeedNodeDiscovery(this.seedRegistry, {
      discoveryInterval: options.seedDiscovery?.interval
    });

    this.seedHealthEnabled = options.seedHealth?.enabled !== false;
    this.seedDiscoveryEnabled = options.seedDiscovery?.enabled !== false;

    // Add structured seed nodes
    if (options.seedNodes) {
      for (const seedInfo of options.seedNodes) {
        this.seedRegistry.addSeed(seedInfo);
      }
    }

    // Convert legacy seed nodes to structured format
    if (options.legacySeedNodes && options.legacySeedNodes.length > 0) {
      const structuredSeeds = SeedNodeRegistry.fromStringArray(options.legacySeedNodes);
      for (const seed of structuredSeeds) {
        this.seedRegistry.addSeed(seed);
      }
    }

    // Configure discovery strategies
    if (options.seedDiscovery?.strategies) {
      for (const strategy of options.seedDiscovery.strategies) {
        this.seedDiscovery.addStrategy(strategy);
      }
    }

    // Set up event forwarding
    this.setupEventForwarding();
  }

  // Expose legacy config properties for compatibility
  get seedNodes(): string[] { return this.legacyConfig.getSeedNodes(); }
  get joinTimeout(): number { return this.legacyConfig.joinTimeout; }
  get gossipInterval(): number { return this.legacyConfig.gossipInterval; }
  get enableLogging(): boolean { return this.legacyConfig.enableLogging; }
  get failureDetector() { return this.legacyConfig.failureDetector; }
  get keyManager() { return this.legacyConfig.keyManager; }
  get lifecycle() { return this.legacyConfig.lifecycle; }

  /**
   * Start enhanced bootstrap services
   */
  async start(): Promise<void> {
    if (this.seedHealthEnabled) {
      this.seedRegistry.startHealthMonitoring();
    }

    if (this.seedDiscoveryEnabled) {
      this.seedDiscovery.startDiscovery();
    }
  }

  /**
   * Stop enhanced bootstrap services
   */
  async stop(): Promise<void> {
    this.seedRegistry.stopHealthMonitoring();
    this.seedDiscovery.stopDiscovery();
  }

  /**
   * Get current bootstrap seed nodes
   */
  getBootstrapSeeds(): SeedNodeInfo[] {
    return this.seedRegistry.getBootstrapSeeds();
  }

  /**
   * Get legacy seed nodes array (for backward compatibility)
   */
  getSeedNodes(): string[] {
    return this.seedRegistry.toLegacyStringArray();
  }

  /**
   * Add a seed node
   */
  addSeedNode(seed: string | SeedNodeInfo): void {
    if (typeof seed === 'string') {
      // Handle legacy string format
      this.legacyConfig.addSeedNode(seed);
      
      // Also add to structured registry
      const [address, portStr] = seed.includes(':') ? seed.split(':') : [seed, '8080'];
      this.seedRegistry.addSeed({
        id: `legacy-${address}`,
        address,
        port: parseInt(portStr, 10),
        priority: 50,
        isPermanent: true
      });
    } else {
      // Handle structured format
      this.seedRegistry.addSeed(seed);
    }
  }

  /**
   * Report seed node success (for health tracking)
   */
  reportSeedSuccess(seedId: string): void {
    this.seedRegistry.markSeedSuccess(seedId);
  }

  /**
   * Report seed node failure (for health tracking)
   */
  reportSeedFailure(seedId: string, error?: Error): void {
    this.seedRegistry.markSeedFailure(seedId, error);
  }

  /**
   * Get seed health status
   */
  getSeedHealthStatus() {
    return this.seedRegistry.getHealthStatus();
  }

  /**
   * Set up event forwarding from registry and discovery to config
   */
  private setupEventForwarding(): void {
    // Forward seed registry events
    this.seedRegistry.on('seed-added', (event) => {
      this.emit('seed-added', event);
    });

    this.seedRegistry.on('seed-failed', (event) => {
      this.emit('seed-failed', event);
    });

    this.seedRegistry.on('seed-recovered', (event) => {
      this.emit('seed-recovered', event);
    });

    // Forward discovery events
    this.seedDiscovery.on('discovery-success', (event) => {
      this.emit('seed-discovered', event);
    });

    this.seedDiscovery.on('discovery-error', (event) => {
      this.emit('seed-discovery-error', event);
    });
  }

  /**
   * Create enhanced bootstrap config with convenient defaults
   */
  static create(options: AdvancedBootstrapOptions = {}): AdvancedBootstrapConfig {
    return new AdvancedBootstrapConfig(options);
  }

  /**
   * Create from legacy BootstrapConfig
   */
  static fromLegacy(legacyConfig: BootstrapConfig): AdvancedBootstrapConfig {
    return new AdvancedBootstrapConfig({
      legacySeedNodes: legacyConfig.getSeedNodes(),
      joinTimeout: legacyConfig.joinTimeout,
      gossipInterval: legacyConfig.gossipInterval,
      enableLogging: legacyConfig.enableLogging,
      failureDetector: legacyConfig.failureDetector,
      keyManager: legacyConfig.keyManager,
      lifecycle: legacyConfig.lifecycle
    });
  }
}
