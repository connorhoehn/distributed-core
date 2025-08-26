/**
 * Feature flags for distributed semantics evolution
 * Phase 0 - Baseline & Flags
 */
export interface DistributedSemanticsFlags {
  // Phase 1 - Operation Envelope + Correlation
  'ops.envelope': boolean;
  'obs.trace': boolean;
  
  // Phase 2 - Idempotent Apply  
  'ops.dedup': boolean;
  
  // Phase 3 - Causal Ordering
  'ops.causal': boolean;
  
  // Phase 4 - Subscriber Exactly-Once
  'subs.dedup': boolean;
  
  // Phase 5 - Backpressure & Retries
  'flow.backpressure': boolean;
  
  // Phase 6 - Resource-Level Authorization
  'auth.resource': boolean;
}

export class DistributedSemanticsConfig {
  private flags: DistributedSemanticsFlags;
  
  constructor(overrides: Partial<DistributedSemanticsFlags> = {}) {
    // All flags default to false for safety
    this.flags = {
      'ops.envelope': false,
      'obs.trace': false,
      'ops.dedup': false,
      'ops.causal': false,
      'subs.dedup': false,
      'flow.backpressure': false,
      'auth.resource': false,
      ...overrides
    };
  }
  
  isEnabled(flag: keyof DistributedSemanticsFlags): boolean {
    return this.flags[flag];
  }
  
  enable(flag: keyof DistributedSemanticsFlags): void {
    this.flags[flag] = true;
  }
  
  disable(flag: keyof DistributedSemanticsFlags): void {
    this.flags[flag] = false;
  }
  
  getFlags(): Readonly<DistributedSemanticsFlags> {
    return { ...this.flags };
  }
  
  // Phase rollout helpers
  enablePhase1(): void {
    this.enable('ops.envelope');
    this.enable('obs.trace');
  }
  
  enablePhase2(): void {
    this.enablePhase1();
    this.enable('ops.dedup');
  }
  
  enablePhase3(): void {
    this.enablePhase2();
    this.enable('ops.causal');
  }
  
  enablePhase4(): void {
    this.enablePhase3();
    this.enable('subs.dedup');
  }
  
  enablePhase5(): void {
    this.enablePhase4();
    this.enable('flow.backpressure');
  }
  
  enablePhase6(): void {
    this.enablePhase5();
    this.enable('auth.resource');
  }
}

// Global instance - can be overridden by passing config to components
export const globalSemanticsConfig = new DistributedSemanticsConfig();
