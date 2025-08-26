/**
 * Comprehensive configuration for distributed semantics
 */
export interface SemanticsConfig {
  dedupTtlMs: number;
  causal: {
    maxBufferPerResource: number;
    maxWaitMs: number;
    overflow: 'drop-oldest' | 'halt';
  };
  wal: {
    snapshotEveryOps: number;
    maxReplayMs: number;
    messageTtlMs: number;
  };
  flow: {
    maxQueuePerConn: number;
    writeTimeoutMs: number;
    dropPolicy: 'oldest' | 'newest' | 'error';
  };
  auth: {
    enforceAt: Array<'ingress' | 'apply' | 'deliver'>;
  };
  routing: {
    replicationFactor: number;
    preferPrimary: boolean;
  };
}

/**
 * Default semantics configuration
 */
export const DEFAULT_SEMANTICS_CONFIG: SemanticsConfig = {
  dedupTtlMs: 300000, // 5 minutes
  causal: {
    maxBufferPerResource: 1000,
    maxWaitMs: 5000,
    overflow: 'drop-oldest'
  },
  wal: {
    snapshotEveryOps: 10000,
    maxReplayMs: 30000,
    messageTtlMs: 86400000 // 24 hours
  },
  flow: {
    maxQueuePerConn: 1000,
    writeTimeoutMs: 5000,
    dropPolicy: 'oldest'
  },
  auth: {
    enforceAt: ['ingress', 'apply', 'deliver']
  },
  routing: {
    replicationFactor: 3,
    preferPrimary: true
  }
};

/**
 * Configuration validator for distributed semantics
 */
export class SemanticsConfigValidator {
  static validate(config: SemanticsConfig): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate deduplication TTL
    if (config.dedupTtlMs <= 0) {
      errors.push('dedupTtlMs must be positive');
    }

    // Validate causal ordering
    if (config.causal.maxBufferPerResource <= 0) {
      errors.push('causal.maxBufferPerResource must be positive');
    }
    if (config.causal.maxWaitMs <= 0) {
      errors.push('causal.maxWaitMs must be positive');
    }

    // Validate WAL config
    if (config.wal.snapshotEveryOps <= 0) {
      errors.push('wal.snapshotEveryOps must be positive');
    }
    if (config.wal.maxReplayMs <= 0) {
      errors.push('wal.maxReplayMs must be positive');
    }

    // Validate flow control
    if (config.flow.maxQueuePerConn <= 0) {
      errors.push('flow.maxQueuePerConn must be positive');
    }

    // Validate routing
    if (config.routing.replicationFactor < 1) {
      errors.push('routing.replicationFactor must be >= 1');
    }

    // Warnings
    if (!config.auth.enforceAt.includes('deliver')) {
      warnings.push('auth does not enforce at deliver - clients may see unauthorized data');
    }

    if (config.routing.replicationFactor === 1) {
      warnings.push('replicationFactor=1 provides no fault tolerance');
    }

    return { errors, warnings };
  }
}
