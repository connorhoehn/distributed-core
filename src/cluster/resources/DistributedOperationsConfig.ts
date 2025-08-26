/**
 * Feature flags for distributed operations phases
 * Each flag can be enabled independently to roll out new functionality safely
 */
export interface DistributedOperationsFlags {
  // Phase 1: Operation envelope and correlation tracking
  'ops.envelope': boolean;
  
  // Phase 2: Operation deduplication and idempotency
  'ops.dedup': boolean;
  
  // Phase 3: Causal ordering with vector clocks
  'ops.causal': boolean;
  
  // Phase 4: Subscription deduplication (exactly-once delivery)
  'subs.dedup': boolean;
  
  // Phase 5: Flow control and backpressure
  'flow.backpressure': boolean;
  
  // Phase 6: Resource-level authorization
  'auth.resource': boolean;
  
  // Phase 7: Observability and tracing
  'obs.trace': boolean;
}

/**
 * Configuration for distributed operations system
 */
export interface DistributedOperationsConfig {
  flags: DistributedOperationsFlags;
  nodeId: string;
  
  // Flow control limits (Phase 5)
  flow?: {
    maxInFlightPerResource: number;
    maxQueuePerConn: number;
    retry: {
      initialMs: number;
      maxMs: number;
    };
    dropPolicy: 'oldest' | 'newest' | 'error';
  };
}

/**
 * Default configuration with all flags disabled for safety
 */
export const DEFAULT_DISTRIBUTED_OPS_CONFIG: DistributedOperationsConfig = {
  flags: {
    'ops.envelope': false,
    'ops.dedup': false,
    'ops.causal': false,
    'subs.dedup': false,
    'flow.backpressure': false,
    'auth.resource': false,
    'obs.trace': false,
  },
  nodeId: 'default-node',
  flow: {
    maxInFlightPerResource: 1000,
    maxQueuePerConn: 256,
    retry: {
      initialMs: 50,
      maxMs: 2000,
    },
    dropPolicy: 'oldest',
  },
};

/**
 * Factory for creating distributed operations config from environment or overrides
 */
export class DistributedOperationsConfigFactory {
  static create(overrides: Partial<DistributedOperationsConfig> = {}): DistributedOperationsConfig {
    return {
      ...DEFAULT_DISTRIBUTED_OPS_CONFIG,
      ...overrides,
      flags: {
        ...DEFAULT_DISTRIBUTED_OPS_CONFIG.flags,
        ...overrides.flags,
      },
      flow: overrides.flow ? {
        ...DEFAULT_DISTRIBUTED_OPS_CONFIG.flow,
        ...overrides.flow,
      } : DEFAULT_DISTRIBUTED_OPS_CONFIG.flow,
    };
  }

  static withFlags(flags: Partial<DistributedOperationsFlags>, nodeId?: string): DistributedOperationsConfig {
    return this.create({
      nodeId: nodeId || 'default-node',
      flags: {
        ...DEFAULT_DISTRIBUTED_OPS_CONFIG.flags,
        ...flags,
      },
    });
  }
}
