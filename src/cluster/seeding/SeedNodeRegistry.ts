import { EventEmitter } from 'events';

/**
 * Structured seed node information
 */
export interface SeedNodeInfo {
  /** Unique identifier for the seed node */
  id: string;
  
  /** Network address (hostname/IP) */
  address: string;
  
  /** Port number */
  port: number;
  
  /** Priority level (higher = preferred, 0 = disabled) */
  priority: number;
  
  /** Whether this is a permanent seed (vs temporary bootstrap) */
  isPermanent: boolean;
  
  /** Optional metadata */
  metadata?: {
    region?: string;
    zone?: string;
    role?: string;
    tags?: Record<string, string>;
  };
  
  /** Health tracking */
  health: {
    isAvailable: boolean;
    lastSeen: number;
    failures: number;
    lastFailure?: number;
  };
}

/**
 * Seed node health status
 */
export interface SeedNodeHealthStatus {
  totalSeeds: number;
  availableSeeds: number;
  permanentSeeds: number;
  temporarySeeds: number;
  healthyRatio: number;
  degradedSeeds: SeedNodeInfo[];
  failedSeeds: SeedNodeInfo[];
}

/**
 * Registry for managing seed nodes with health monitoring and failover
 */
export class SeedNodeRegistry extends EventEmitter {
  private seeds: Map<string, SeedNodeInfo> = new Map();
  private healthCheckInterval?: NodeJS.Timeout;
  private readonly healthCheckIntervalMs: number;
  private readonly maxFailures: number;
  private readonly failureTimeout: number;

  constructor(options: {
    healthCheckInterval?: number;
    maxFailures?: number;
    failureTimeout?: number;
  } = {}) {
    super();
    
    this.healthCheckIntervalMs = options.healthCheckInterval || 30000; // 30 seconds
    this.maxFailures = options.maxFailures || 3;
    this.failureTimeout = options.failureTimeout || 60000; // 1 minute
  }

  /**
   * Add a seed node to the registry
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
   * Remove a seed node from the registry
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
   * Get available seed nodes, ordered by priority
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
   * Get seed nodes for initial bootstrap (mix of permanent and available temporary)
   */
  getBootstrapSeeds(): SeedNodeInfo[] {
    const permanent = this.getPermanentSeeds().filter(s => s.health.isAvailable);
    const temporary = this.getAllSeeds()
      .filter(s => !s.isPermanent && s.health.isAvailable && s.priority > 0)
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 3); // Limit temporary seeds

    // Sort permanent seeds by priority, then add temporary seeds
    const sortedPermanent = permanent.sort((a, b) => b.priority - a.priority);
    const sortedTemporary = temporary.sort((a, b) => b.priority - a.priority);

    return [...sortedPermanent, ...sortedTemporary];
  }

  /**
   * Mark a seed as successful (reset failure count)
   */
  markSeedSuccess(seedId: string): void {
    const seed = this.seeds.get(seedId);
    if (seed) {
      seed.health.isAvailable = true;
      seed.health.lastSeen = Date.now();
      seed.health.failures = 0;
      delete seed.health.lastFailure;
      
      this.emit('seed-recovered', { seed });
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
      
      if (seed.health.failures >= this.maxFailures) {
        seed.health.isAvailable = false;
        this.emit('seed-failed', { seed, error });
      } else {
        this.emit('seed-degraded', { seed, error, failures: seed.health.failures });
      }
    }
  }

  /**
   * Get health status of all seeds
   */
  getHealthStatus(): SeedNodeHealthStatus {
    const allSeeds = this.getAllSeeds();
    const availableSeeds = allSeeds.filter(s => s.health.isAvailable);
    const permanentSeeds = allSeeds.filter(s => s.isPermanent);
    const degradedSeeds = allSeeds.filter(s => s.health.failures > 0 && s.health.isAvailable);
    const failedSeeds = allSeeds.filter(s => !s.health.isAvailable);

    return {
      totalSeeds: allSeeds.length,
      availableSeeds: availableSeeds.length,
      permanentSeeds: permanentSeeds.length,
      temporarySeeds: allSeeds.length - permanentSeeds.length,
      healthyRatio: allSeeds.length > 0 ? availableSeeds.length / allSeeds.length : 0,
      degradedSeeds,
      failedSeeds
    };
  }

  /**
   * Start health monitoring
   */
  startHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      return; // Already started
    }

    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.healthCheckIntervalMs);

    this.healthCheckInterval.unref(); // Don't prevent process exit
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
   * Perform health check on all seeds
   */
  private performHealthCheck(): void {
    const now = Date.now();
    let recoveredSeeds = 0;

    for (const seed of this.seeds.values()) {
      // Auto-recover seeds that have been failed for longer than timeout
      if (!seed.health.isAvailable && 
          seed.health.lastFailure && 
          (now - seed.health.lastFailure) > this.failureTimeout) {
        
        seed.health.isAvailable = true;
        seed.health.failures = Math.max(0, seed.health.failures - 1); // Gradual recovery
        recoveredSeeds++;
        
        this.emit('seed-auto-recovered', { seed });
      }
    }

    if (recoveredSeeds > 0) {
      this.emit('health-check-completed', { 
        recoveredSeeds, 
        healthStatus: this.getHealthStatus() 
      });
    }
  }

  /**
   * Create seed nodes from legacy string array
   */
  static fromStringArray(seedStrings: string[]): SeedNodeInfo[] {
    return seedStrings.map((seedString, index) => {
      // Parse "host:port" or just "host" format
      const [address, portStr] = seedString.includes(':') 
        ? seedString.split(':') 
        : [seedString, '8080'];
      
      return {
        id: `seed-${index}-${address}`,
        address,
        port: parseInt(portStr, 10),
        priority: 100 - index, // Higher priority for earlier seeds
        isPermanent: true, // Assume legacy seeds are permanent
        health: {
          isAvailable: true,
          lastSeen: Date.now(),
          failures: 0
        }
      };
    });
  }

  /**
   * Convert to legacy string array format for backward compatibility
   */
  toLegacyStringArray(): string[] {
    return this.getAvailableSeeds()
      .map(seed => `${seed.address}:${seed.port}`);
  }
}
