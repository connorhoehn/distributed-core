import { EventEmitter } from 'events';

export interface FailureDetectorOptions {
  heartbeatInterval?: number;
  failureTimeout?: number;
  deadTimeout?: number;
  pingTimeout?: number;
  maxMissedHeartbeats?: number;
  maxMissedPings?: number;
  enableActiveProbing?: boolean;
  enableLogging?: boolean;
}

export interface LifecycleOptions {
  shutdownTimeout?: number;
  drainTimeout?: number;
  enableAutoRebalance?: boolean;
  rebalanceThreshold?: number;
  enableGracefulShutdown?: boolean;
  maxShutdownWait?: number;
}

export interface KeyManagerOptions {
  privateKeyPem?: string;
  publicKeyPem?: string;
  keySize?: number;
  algorithm?: 'rsa' | 'ec';
  curve?: string;
  enableLogging?: boolean;
}

/** Seed node information with health monitoring */
export interface SeedNodeInfo {
  id: string;
  address: string;
  port: number;
  priority: number;
  isPermanent: boolean;
  metadata?: Record<string, any>;
  health: {
    isAvailable: boolean;
    lastSeen: number;
    failures: number;
    lastFailure?: number;
    error?: string;
  };
}

export interface BootstrapOptions {
  /** Seed nodes - can be strings or structured objects */
  seedNodes?: (string | Omit<SeedNodeInfo, 'health'>)[];
  
  joinTimeout?: number;
  gossipInterval?: number;
  enableLogging?: boolean;
  failureDetector?: FailureDetectorOptions;
  keyManager?: KeyManagerOptions;
  lifecycle?: LifecycleOptions;
  
  /** Seed health monitoring */
  seedHealth?: {
    enabled?: boolean;
    healthCheckInterval?: number;
    maxFailures?: number;
    failureTimeout?: number;
  };
}

export class BootstrapConfig extends EventEmitter {
  private seeds: Map<string, SeedNodeInfo> = new Map();
  private healthCheckInterval?: NodeJS.Timeout;
  
  readonly joinTimeout: number;
  readonly gossipInterval: number;
  readonly enableLogging: boolean;
  readonly failureDetector: FailureDetectorOptions;
  readonly keyManager: KeyManagerOptions;
  readonly lifecycle: LifecycleOptions;
  
  private readonly seedHealthEnabled: boolean;
  private readonly healthCheckIntervalMs: number;
  private readonly maxFailures: number;
  private readonly failureTimeout: number;

  constructor(
    seedNodes: (string | Omit<SeedNodeInfo, 'health'>)[] = [],
    joinTimeout: number = 5000,
    gossipInterval: number = 1000,
    enableLogging: boolean = false,
    failureDetector: FailureDetectorOptions = {},
    keyManager: KeyManagerOptions = {},
    lifecycle: LifecycleOptions = {},
    seedHealthOptions: { enabled?: boolean; healthCheckInterval?: number; maxFailures?: number; failureTimeout?: number; } = {}
  ) {
    super();
    
    this.joinTimeout = joinTimeout;
    this.gossipInterval = gossipInterval;
    this.enableLogging = enableLogging;
    this.failureDetector = failureDetector;
    this.keyManager = keyManager;
    this.lifecycle = lifecycle;
    
    // Seed health settings
    this.seedHealthEnabled = seedHealthOptions.enabled !== false;
    this.healthCheckIntervalMs = seedHealthOptions.healthCheckInterval || 30000;
    this.maxFailures = seedHealthOptions.maxFailures || 3;
    this.failureTimeout = seedHealthOptions.failureTimeout || 60000;
    
    // Process seed nodes
    this.processSeedNodes(seedNodes);
  }

  static create(options: Partial<BootstrapOptions> = {}): BootstrapConfig {
    return new BootstrapConfig(
      options.seedNodes || [],
      options.joinTimeout || 5000,
      options.gossipInterval || 1000,
      options.enableLogging || false,
      options.failureDetector || {},
      options.keyManager || {},
      options.lifecycle || {},
      options.seedHealth || {}
    );
  }

  /**
   * Convert string array to structured seed format
   */
  static fromStringArray(seeds: string[]): Omit<SeedNodeInfo, 'health'>[] {
    return seeds.map((seedStr, index) => {
      const [address, portStr] = seedStr.includes(':') ? seedStr.split(':') : [seedStr, '8080'];
      return {
        id: `seed-${address}-${index}`,
        address,
        port: parseInt(portStr, 10),
        priority: 100 - index, // Earlier seeds get higher priority
        isPermanent: true,
        metadata: { source: 'string-array' }
      };
    });
  }

  /**
   * Process mixed seed node input (strings or objects)
   */
  private processSeedNodes(seedNodes: (string | Omit<SeedNodeInfo, 'health'>)[]): void {
    seedNodes.forEach((seed, index) => {
      if (typeof seed === 'string') {
        // Convert string to structured format
        const hasPort = seed.includes(':');
        const [address, portStr] = hasPort ? seed.split(':') : [seed, '8080'];
        this.addSeed({
          id: `seed-${address}-${index}`,
          address,
          port: parseInt(portStr, 10),
          priority: 100 - index, // Earlier seeds get higher priority
          isPermanent: true,
          metadata: { 
            source: 'string',
            originalFormat: hasPort ? 'address:port' : 'address'
          }
        });
      } else {
        // Already structured
        this.addSeed(seed);
      }
    });
  }

  /**
   * Add a seed node
   */
  addSeed(seedInfo: Omit<SeedNodeInfo, 'health'>): void {
    const seed: SeedNodeInfo = {
      ...seedInfo,
      health: {
        isAvailable: true,
        lastSeen: Date.now(),
        failures: 0
      }
    };

    this.seeds.set(seed.id, seed);
    this.emit('seed-added', { seed });
  }

  /**
   * Add structured seed node (alias for addSeed)
   */
  addStructuredSeed(seedInfo: Omit<SeedNodeInfo, 'health'>): void {
    this.addSeed(seedInfo);
  }

  /**
   * Add seed node (supports both string and object)
   */
  addSeedNode(seed: string | Omit<SeedNodeInfo, 'health'>): void {
    if (typeof seed === 'string') {
      const hasPort = seed.includes(':');
      const [address, portStr] = hasPort ? seed.split(':') : [seed, '8080'];
      this.addSeed({
        id: `seed-${address}-${Date.now()}`,
        address,
        port: parseInt(portStr, 10),
        priority: 50,
        isPermanent: true,
        metadata: { 
          source: 'added-string',
          originalFormat: hasPort ? 'address:port' : 'address'
        }
      });
    } else {
      this.addSeed(seed);
    }
  }

  /**
   * Remove a seed node
   */
  removeSeed(seedId: string): boolean {
    const removed = this.seeds.delete(seedId);
    if (removed) {
      this.emit('seed-removed', { seedId });
    }
    return removed;
  }

  /**
   * Get all seed nodes
   */
  getAllSeeds(): SeedNodeInfo[] {
    return Array.from(this.seeds.values());
  }

  /**
   * Get structured seeds (alias for getAllSeeds)
   */
  getStructuredSeeds(): SeedNodeInfo[] {
    return this.getAllSeeds();
  }

  /**
   * Get available seed nodes ordered by priority
   */
  getAvailableSeeds(): SeedNodeInfo[] {
    return Array.from(this.seeds.values())
      .filter(seed => seed.health.isAvailable && seed.priority > 0)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get permanent seed nodes only
   */
  getPermanentSeeds(): SeedNodeInfo[] {
    return this.getAllSeeds().filter(seed => seed.isPermanent);
  }

  /**
   * Get bootstrap seeds (mix of permanent and best temporary)
   */
  getBootstrapSeeds(): SeedNodeInfo[] {
    const permanent = this.getPermanentSeeds().filter(s => s.health.isAvailable);
    const temporary = this.getAllSeeds()
      .filter(s => !s.isPermanent && s.health.isAvailable && s.priority > 0)
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 3);

    const sortedPermanent = permanent.sort((a, b) => b.priority - a.priority);
    return [...sortedPermanent, ...temporary];
  }

  /**
   * Get seed nodes as string array (for compatibility)
   */
  getSeedNodes(): string[] {
    return this.getAvailableSeeds()
      .map(seed => {
        // If original format was bare address (no port), return bare address
        if (seed.metadata?.originalFormat === 'address') {
          return seed.address;
        }
        return `${seed.address}:${seed.port}`;
      });
  }

  /**
   * Mark a seed as successful
   */
  markSeedSuccess(seedId: string): void {
    const seed = this.seeds.get(seedId);
    if (seed) {
      seed.health.isAvailable = true;
      seed.health.lastSeen = Date.now();
      seed.health.failures = 0;
      delete seed.health.lastFailure;
      delete seed.health.error;
      this.emit('seed-success', { seed });
    }
  }

  /**
   * Mark a seed as failed
   */
  markSeedFailure(seedId: string, error?: Error): void {
    const seed = this.seeds.get(seedId);
    if (seed) {
      seed.health.failures++;
      seed.health.lastFailure = Date.now();
      seed.health.error = error?.message;

      if (seed.health.failures >= this.maxFailures) {
        seed.health.isAvailable = false;
        this.emit('seed-failed', { seed, error });
      }
    }
  }

  /**
   * Start health monitoring
   */
  startHealthMonitoring(): void {
    if (!this.seedHealthEnabled || this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.healthCheckIntervalMs);

    this.healthCheckInterval.unref();
  }

  /**
   * Stop health monitoring
   */
  stopHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
  }

  /**
   * Get seed health status
   */
  getHealthStatus() {
    const seeds = this.getAllSeeds();
    return {
      totalSeeds: seeds.length,
      availableSeeds: seeds.filter(s => s.health.isAvailable).length,
      failedSeeds: seeds.filter(s => !s.health.isAvailable).length,
      seedDetails: seeds.map(s => ({
        id: s.id,
        address: `${s.address}:${s.port}`,
        isAvailable: s.health.isAvailable,
        failures: s.health.failures,
        lastSeen: s.health.lastSeen,
        isPermanent: s.isPermanent,
        priority: s.priority
      }))
    };
  }

  /**
   * Perform health check cycle
   */
  private performHealthCheck(): void {
    const now = Date.now();
    for (const seed of this.seeds.values()) {
      // Auto-recover seeds that have been down long enough
      if (!seed.health.isAvailable && 
          seed.health.lastFailure && 
          (now - seed.health.lastFailure) > this.failureTimeout) {
        
        seed.health.isAvailable = true;
        seed.health.failures = 0;
        delete seed.health.lastFailure;
        delete seed.health.error;
        this.emit('seed-recovered', { seed });
      }
    }
  }
}
