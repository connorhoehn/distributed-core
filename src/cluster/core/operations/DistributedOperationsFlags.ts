import { DistributedOperationsConfig, DEFAULT_DISTRIBUTED_OPS_CONFIG } from './DistributedOperationsSpec';


/**
 * Feature Flags Manager for Distributed Operations
 * 
 * Provides centralized control over distributed operations features
 * with safe rollout and rollback capabilities.
 */
export class DistributedOperationsFlags {
  private flags: DistributedOperationsConfig;
  public readonly nodeId: string;

  constructor(nodeId: string, overrides?: Partial<DistributedOperationsConfig>) {
    this.nodeId = nodeId;
    this.flags = {
      ...DEFAULT_DISTRIBUTED_OPS_CONFIG,
      ...this.loadFromEnvironment(),
      ...overrides
    };
  }

  /**
   * Load feature flags from environment variables
   * Format: DISTRIBUTED_OPS_<FLAG>=true/false
   */
  private loadFromEnvironment(): Partial<DistributedOperationsConfig> {
    const envFlags: Partial<DistributedOperationsConfig> = {};
    
    const flagMap = {
      'DISTRIBUTED_OPS_ENVELOPE': 'ops.envelope' as const,
      'DISTRIBUTED_OPS_DEDUP': 'ops.dedup' as const,
      'DISTRIBUTED_OPS_CAUSAL': 'ops.causal' as const,
      'DISTRIBUTED_OPS_SUBS_DEDUP': 'subs.dedup' as const,
      'DISTRIBUTED_OPS_BACKPRESSURE': 'flow.backpressure' as const,
      'DISTRIBUTED_OPS_AUTH': 'auth.resource' as const,
      'DISTRIBUTED_OPS_TRACE': 'obs.trace' as const,
      'DISTRIBUTED_OPS_HEAL': 'heal.merge' as const,
    };

    Object.entries(flagMap).forEach(([envVar, flagKey]) => {
      const value = process.env[envVar];
      if (value !== undefined) {
        envFlags[flagKey] = value.toLowerCase() === 'true';
      }
    });

    return envFlags;
  }

  /**
   * Check if a feature flag is enabled
   */
  isEnabled(flag: keyof DistributedOperationsConfig): boolean {
    return this.flags[flag];
  }

  /**
   * Enable a feature flag
   */
  enable(flag: keyof DistributedOperationsConfig): void {
    this.flags[flag] = true;
    this.logFlagChange(flag, true);
  }

  /**
   * Disable a feature flag
   */
  disable(flag: keyof DistributedOperationsConfig): void {
    this.flags[flag] = false;
    this.logFlagChange(flag, false);
  }

  /**
   * Get all current flag states
   */
  getAllFlags(): DistributedOperationsConfig {
    return { ...this.flags };
  }

  /**
   * Bulk update flags (useful for testing)
   */
  updateFlags(updates: Partial<DistributedOperationsConfig>): void {
    Object.entries(updates).forEach(([key, value]) => {
      if (key in this.flags) {
        this.flags[key as keyof DistributedOperationsConfig] = value as boolean;
        this.logFlagChange(key as keyof DistributedOperationsConfig, value as boolean);
      }
    });
  }

  /**
   * Reset all flags to defaults
   */
  reset(): void {
    this.flags = { ...DEFAULT_DISTRIBUTED_OPS_CONFIG };
    console.log(`[DistributedOpsFlags:${this.nodeId}] All flags reset to defaults`);
  }

  /**
   * Get the current phase based on enabled flags
   */
  getCurrentPhase(): number {
    if (this.flags['heal.merge']) return 7;
    if (this.flags['auth.resource']) return 6;
    if (this.flags['flow.backpressure']) return 5;
    if (this.flags['subs.dedup']) return 4;
    if (this.flags['ops.causal']) return 3;
    if (this.flags['ops.dedup']) return 2;
    if (this.flags['ops.envelope']) return 1;
    return 0;
  }

  /**
   * Check if dependencies are satisfied for a flag
   */
  canEnable(flag: keyof DistributedOperationsConfig): boolean {
    const dependencies: Record<keyof DistributedOperationsConfig, (keyof DistributedOperationsConfig)[]> = {
      'ops.envelope': [],
      'ops.dedup': ['ops.envelope'],
      'ops.causal': ['ops.envelope', 'ops.dedup'],
      'subs.dedup': ['ops.envelope'],
      'flow.backpressure': ['ops.envelope'],
      'auth.resource': ['ops.envelope'],
      'obs.trace': ['ops.envelope'],
      'heal.merge': ['ops.envelope', 'ops.causal'],
    };

    const deps = dependencies[flag] || [];
    return deps.every(dep => this.flags[dep]);
  }

  /**
   * Log flag changes for audit trail
   */
  private logFlagChange(flag: keyof DistributedOperationsConfig, enabled: boolean): void {
    console.log(`[DistributedOpsFlags:${this.nodeId}] ${flag} = ${enabled} (phase=${this.getCurrentPhase()})`);
  }

  /**
   * Validate flag configuration
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    Object.keys(this.flags).forEach(flag => {
      const typedFlag = flag as keyof DistributedOperationsConfig;
      if (this.flags[typedFlag] && !this.canEnable(typedFlag)) {
        errors.push(`${flag} is enabled but dependencies are not satisfied`);
      }
    });

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

/**
 * Global flags instance (initialized by NodeManager)
 */
let globalFlags: DistributedOperationsFlags | null = null;

/**
 * Initialize global flags instance
 */
export function initializeDistributedOperationsFlags(
  nodeId: string, 
  overrides?: Partial<DistributedOperationsConfig>
): DistributedOperationsFlags {
  globalFlags = new DistributedOperationsFlags(nodeId, overrides);
  return globalFlags;
}

/**
 * Get global flags instance
 */
export function getDistributedOperationsFlags(): DistributedOperationsFlags {
  if (!globalFlags) {
    throw new Error('DistributedOperationsFlags not initialized. Call initializeDistributedOperationsFlags() first.');
  }
  return globalFlags;
}

/**
 * Convenience function to check if a flag is enabled
 */
export function isDistributedOperationEnabled(flag: keyof DistributedOperationsConfig): boolean {
  try {
    return getDistributedOperationsFlags().isEnabled(flag);
  } catch {
    // Fallback to disabled if not initialized
    return false;
  }
}

/**
 * WAL Replay Trigger (for development)
 */
export function shouldForceWalReplay(): boolean {
  return process.env.FORCE_WAL_REPLAY === 'true';
}

/**
 * Get consistent node ID across the system
 */
export function getNodeId(): string {
  return process.env.NODE_ID || globalFlags?.nodeId || 'unknown-node';
}
