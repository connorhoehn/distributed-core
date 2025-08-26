/**
 * Core operation types for distributed resource management
 */
export type OpType = 'CREATE' | 'UPDATE' | 'DELETE' | 'TRANSFER' | 'JOIN' | 'LEAVE';

/**
 * Vector clock for causal ordering
 */
export interface VectorClock {
  nodeId: string;
  vector: Map<string, number>;
  increment(): VectorClock;
  compare(other: VectorClock): number;
  merge(other: VectorClock): VectorClock;
}

/**
 * Resource Operation envelope - wraps all resource changes
 */
export interface ResourceOperation<T = any> {
  opId: string;                    // uuid v7 for ordering
  resourceId: string;
  type: OpType;
  version: number;                 // monotonic version
  timestamp: number;               // wall clock time
  originNodeId: string;
  payload: T;                      // actual change data
  parents?: string[];              // causal dependencies (opIds)
  vectorClock: VectorClock;        // vector clock for causal ordering
  correlationId: string;           // request trace ID
  leaseTerm: number;               // monotonic term from ResourceLeaseManager - PREVENTS SPLIT-BRAIN
  metadata?: Record<string, any>;
}

/**
 * Correlation context for tracing operations
 */
export interface CorrelationContext {
  correlationId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  baggage: Record<string, string>;
}

/**
 * Operation result with correlation
 */
export interface OperationResult<T = any> {
  success: boolean;
  operation: ResourceOperation<T>;
  result?: T;
  error?: Error;
  correlationId: string;
}

/**
 * Generate correlation context
 */
export function generateCorrelationContext(parentContext?: CorrelationContext): CorrelationContext {
  const correlationId = generateUuidV7();
  const traceId = parentContext?.traceId || generateUuidV7();
  const spanId = generateUuidV7();
  
  return {
    correlationId,
    traceId,
    spanId,
    parentSpanId: parentContext?.spanId,
    baggage: parentContext?.baggage ? { ...parentContext.baggage } : {}
  };
}

/**
 * Generate UUID v7 (timestamp-based)
 */
export function generateUuidV7(): string {
  const timestamp = Date.now();
  const timestampHex = timestamp.toString(16).padStart(12, '0');
  const randomHex = Math.random().toString(16).substr(2, 14);
  return `${timestampHex.substr(0, 8)}-${timestampHex.substr(8, 4)}-7${randomHex.substr(0, 3)}-${randomHex.substr(3, 4)}-${randomHex.substr(7, 12)}`;
}

/**
 * Create a resource operation envelope
 */
export function createResourceOperation<T>(
  resourceId: string,
  type: OpType,
  payload: T,
  originNodeId: string,
  version: number,
  vectorClock: VectorClock,
  correlationId: string,
  leaseTerm: number,
  parents?: string[]
): ResourceOperation<T> {
  return {
    opId: generateUuidV7(),
    resourceId,
    type,
    version,
    timestamp: Date.now(),
    originNodeId,
    payload,
    parents: parents || [],
    vectorClock,
    correlationId,
    leaseTerm,
  };
}
