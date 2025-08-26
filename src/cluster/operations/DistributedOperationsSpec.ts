/**
 * Distributed Operations Specification
 * 
 * This file contains the complete specification for evolving the distributed core
 * from "good plumbing" to "production-grade distributed semantics" through
 * a phased approach with feature flags.
 */

// =============================================================================
// PHASE 0: FEATURE FLAGS & BASELINE
// =============================================================================

export interface DistributedOperationsConfig {
  // Core operation features
  'ops.envelope': boolean;        // Phase 1: Wrap changes in ResourceOperation
  'ops.dedup': boolean;          // Phase 2: Idempotent apply via OperationDeduplicator
  'ops.causal': boolean;         // Phase 3: Vector clocks + causal ordering
  
  // Subscription features
  'subs.dedup': boolean;         // Phase 4: Exactly-once delivery to clients
  
  // Flow control
  'flow.backpressure': boolean;  // Phase 5: Bounded queues + retry/backoff
  
  // Security
  'auth.resource': boolean;      // Phase 6: Resource-level authorization
  
  // Observability
  'obs.trace': boolean;          // Phase 1+: Correlation IDs + structured logging
  
  // Partition handling
  'heal.merge': boolean;         // Phase 7: Partition-heal merge procedures
}

// Default configuration (all features disabled initially)
export const DEFAULT_DISTRIBUTED_OPS_CONFIG: DistributedOperationsConfig = {
  'ops.envelope': false,
  'ops.dedup': false,
  'ops.causal': false,
  'subs.dedup': false,
  'flow.backpressure': false,
  'auth.resource': false,
  'obs.trace': false,
  'heal.merge': false
};

// =============================================================================
// PHASE 1: OPERATION ENVELOPE + CORRELATION
// =============================================================================

export type OpType = 'CREATE' | 'UPDATE' | 'DELETE' | 'TRANSFER';

export interface ResourceOperation<T = any> {
  opId: string;                    // uuid v7
  resourceId: string;
  type: OpType;
  version?: number;                // optional until Phase 2
  timestamp: number;               // ms
  originNodeId: string;
  payload: T;                      // minimal diff
  parents?: string[];              // for Phase 3 causal ordering
  vector?: Record<string, number>; // Phase 3 vector clock
  correlationId: string;           // request trace
}

export interface CorrelationContext {
  correlationId: string;           // uuid v7
  traceId: string;                 // uuid v7
  spanId: string;                  // uuid v7
  parentSpanId?: string;
  baggage: Record<string, string>;
}

// =============================================================================
// PHASE 2: IDEMPOTENT APPLY
// =============================================================================

export interface OperationDeduplicator {
  seen(opId: string): boolean;                      // no side effects
  markApplied(opId: string, ttlSec: number): void; // mark as processed
  getResult(opId: string): any | null;             // get cached result
}

// =============================================================================
// PHASE 3: CAUSAL ORDERING
// =============================================================================

export interface VectorClock { 
  [nodeId: string]: number;
}

export interface CausalBuffer {
  buffer(op: ResourceOperation): void;                    // queue operation
  ready(resourceId: string): ResourceOperation[];         // get ready ops in order
  hasPending(resourceId: string): boolean;                // check for buffered ops
}

export interface CausalOrderingEngine {
  incrementClock(nodeId: string): VectorClock;
  compare(a: VectorClock, b: VectorClock): 'before' | 'after' | 'concurrent';
  merge(a: VectorClock, b: VectorClock): VectorClock;
  canApply(op: ResourceOperation, lastApplied: VectorClock): boolean;
}

// =============================================================================
// PHASE 4: SUBSCRIBER EXACTLY-ONCE
// =============================================================================

export interface SubscriptionIndex {
  add(connId: string, resourceId: string): void;
  remove(connId: string, resourceId: string): void;
  get(resourceId: string): ReadonlySet<string>;
  removeConnection(connId: string): void;              // cleanup on disconnect
}

export interface DeliveryDeduper {
  delivered(connId: string, opId: string): boolean;   // check+record atomically
  gc(connId: string): void;                           // cleanup on disconnect
  getStats(connId: string): { delivered: number; skipped: number };
}

// =============================================================================
// PHASE 5: BACKPRESSURE & RETRIES
// =============================================================================

export interface FlowControlConfig {
  maxInFlightPerResource: number;  // default: 1000
  maxQueuePerConn: number;         // default: 256
  retry: {
    initialMs: number;             // default: 50
    maxMs: number;                 // default: 2000
    maxAttempts: number;           // default: 5
  };
  dropPolicy: 'oldest' | 'newest' | 'error';  // default: 'oldest'
}

export interface BoundedQueue<T> {
  enqueue(item: T): boolean;       // false if dropped
  dequeue(): T | null;
  size(): number;
  clear(): void;
  getDropCount(): number;
}

export interface RetryManager {
  scheduleRetry(fn: () => Promise<void>, attempt: number): void;
  cancel(id: string): void;
}

// =============================================================================
// PHASE 6: RESOURCE-LEVEL AUTHORIZATION
// =============================================================================

export interface Principal {
  id: string;
  roles: string[];
  attributes: Record<string, any>;
  nodeId: string;                  // for cross-node trust verification
}

export interface ResourceAuthorizationService {
  canCreate(p: Principal, type: string, meta: any): Promise<boolean>;
  canRead(p: Principal, resourceId: string): Promise<boolean>;
  canUpdate(p: Principal, resourceId: string, changes: any): Promise<boolean>;
  canDelete(p: Principal, resourceId: string): Promise<boolean>;
  canSubscribe(p: Principal, resourceId: string): Promise<boolean>;
}

// =============================================================================
// PHASE 7: PARTITION-HEAL MERGE
// =============================================================================

export interface PartitionHealService {
  detectHeal(): void;                                    // called on network recovery
  requestMissingOps(nodeId: string, since: VectorClock): Promise<ResourceOperation[]>;
  gossipLastVectors(): Promise<Map<string, VectorClock>>; // resourceId -> vector
  mergeAndApply(ops: ResourceOperation[]): Promise<void>;
}

export interface MergeMetrics {
  resourceId: string;
  opsApplied: number;
  conflictsResolved: number;
  mergeStrategy: string;
  timestamp: number;
}

// =============================================================================
// OBSERVABILITY KEYS (ALL PHASES)
// =============================================================================

export interface ObservabilityKeys {
  opId: string;
  correlationId: string;
  resourceId: string;
  originNodeId: string;
  targetNodeId?: string;
  phase: 'send' | 'apply' | 'fanout' | 'replay' | 'merge';
  timestamp: number;
}

export interface DistributedMetrics {
  // Operation metrics
  'ops.sent': number;
  'ops.applied': number;
  'ops.deduplicated': number;
  'ops.buffered': number;
  'ops.conflicts': number;
  
  // Subscription metrics
  'subs.delivered': number;
  'subs.skipped': number;
  'subs.failed': number;
  
  // Flow control metrics
  'flow.queued': number;
  'flow.dropped': number;
  'flow.retries': number;
  
  // Auth metrics
  'auth.allowed': number;
  'auth.denied': number;
  
  // Merge metrics
  'merge.completed': number;
  'merge.conflicts': number;
}

// =============================================================================
// FAULT INJECTION (DEV ONLY)
// =============================================================================

export interface FaultInjector {
  dropMessage(nodeId: string, probability: number): void;
  duplicateMessage(opId: string): void;
  reorderMessages(resourceId: string, delayMs: number): void;
  partitionNodes(groupA: string[], groupB: string[], durationMs: number): void;
  slowConsumer(connId: string, delayMs: number): void;
}

export interface TestScenario {
  name: string;
  steps: TestStep[];
  expectedSignals: ExpectedSignal[];
}

export interface TestStep {
  type: 'create' | 'update' | 'delete' | 'subscribe' | 'fault';
  params: Record<string, any>;
  delayMs?: number;
}

export interface ExpectedSignal {
  metric: string;
  value: number;
  tolerance?: number;
  timeoutMs?: number;
}

// =============================================================================
// ACCEPTANCE CRITERIA CHECKLIST
// =============================================================================

/**
 * PHASE 0 ACCEPTANCE:
 * - [x] System runs as-is with all flags off
 * - [x] WAL replay can be triggered (env var FORCE_WAL_REPLAY=true)
 * - [x] NodeId constant everywhere
 * 
 * PHASE 1 ACCEPTANCE:
 * - [ ] Happy path unaffected when ops.envelope=true
 * - [ ] Logs show correlation across nodes when obs.trace=true
 * - [ ] One-line log format: {opId, correlationId, resourceId, type, originNodeId}
 * 
 * PHASE 2 ACCEPTANCE:
 * - [ ] Send same op twice → state unchanged + single "applied" log
 * - [ ] Kill node after WAL append but before broadcast → restart → no double apply
 * 
 * PHASE 3 ACCEPTANCE:
 * - [ ] Deliver B before A (B depends on A) → A applied first after buffering
 * - [ ] Concurrent A & B from different nodes → deterministic tie-break documented
 * 
 * PHASE 4 ACCEPTANCE:
 * - [ ] Force inter-node retry → clients receive exactly once
 * 
 * PHASE 5 ACCEPTANCE:
 * - [ ] Slow consumer → queue limit hit → policy honored (drop/close/error)
 * 
 * PHASE 6 ACCEPTANCE:
 * - [ ] Unauthorized subscribe/update blocked on remote node too
 * 
 * PHASE 7 ACCEPTANCE:
 * - [ ] 30s A|BC partition, concurrent updates; on heal, end state consistent, no dup emits
 */

// =============================================================================
// MERGE STRATEGY DOCUMENTATION
// =============================================================================

/**
 * CONFLICT RESOLUTION POLICY:
 * 
 * 1. Causal First: If operation A causally precedes B (A → B), apply A before B
 * 2. LWW Tie-break: For concurrent operations, use Last-Writer-Wins with deterministic tie-breaking:
 *    a. Higher vector clock sum wins
 *    b. If equal, lexicographically larger originNodeId wins
 * 3. Merge Strategy: Field-level merging where possible, otherwise LWW
 * 
 * LOGGING FORMAT:
 * Every operation logs exactly this structure:
 * {
 *   "timestamp": "2025-08-22T10:30:45.123Z",
 *   "level": "info",
 *   "opId": "01H...",
 *   "correlationId": "01H...", 
 *   "resourceId": "resource-123",
 *   "type": "UPDATE",
 *   "originNodeId": "node-a",
 *   "targetNodeId": "node-b",
 *   "phase": "apply",
 *   "result": "success"
 * }
 */
