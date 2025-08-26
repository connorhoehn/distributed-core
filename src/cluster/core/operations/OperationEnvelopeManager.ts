import { ResourceMetadata } from '../../../resources';
import { OpType, ResourceOperation, CorrelationContext } from './DistributedOperationsSpec';
import { isDistributedOperationEnabled } from './DistributedOperationsFlags';

// Node.js environment access
declare const console: any;

/**
 * Phase 1: Operation Envelope + Correlation Implementation
 * 
 * Wraps resource operations in ResourceOperation envelope and adds correlation IDs
 * for tracing without changing existing behavior.
 */
export class OperationEnvelopeManager {
  private nodeId: string;

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  /**
   * Wrap a resource operation in an envelope if ops.envelope is enabled
   */
  wrapOperation<T = any>(
    resourceId: string,
    type: OpType,
    payload: T,
    correlationContext?: CorrelationContext
  ): ResourceOperation<T> | null {
    if (!isDistributedOperationEnabled('ops.envelope')) {
      return null;
    }

    const opId = this.generateUuidV7();
    const timestamp = Date.now();
    const correlation = correlationContext || this.createCorrelationContext();

    const operation: ResourceOperation<T> = {
      opId,
      resourceId,
      type,
      timestamp,
      originNodeId: this.nodeId,
      payload,
      correlationId: correlation.correlationId
    };

    // Log structured operation if tracing is enabled
    if (isDistributedOperationEnabled('obs.trace')) {
      this.logOperation(operation, 'created');
    }

    return operation;
  }

  /**
   * Create a new correlation context
   */
  createCorrelationContext(): CorrelationContext {
    return {
      correlationId: this.generateUuidV7(),
      traceId: this.generateUuidV7(),
      spanId: this.generateUuidV7(),
      baggage: {}
    };
  }

  /**
   * Continue an existing correlation context with a new span
   */
  continueCorrelationContext(parent: CorrelationContext): CorrelationContext {
    return {
      correlationId: parent.correlationId,
      traceId: parent.traceId,
      spanId: this.generateUuidV7(),
      parentSpanId: parent.spanId,
      baggage: { ...parent.baggage }
    };
  }

  /**
   * Log operation in structured format
   */
  logOperation(operation: ResourceOperation, phase: string, result: string = 'success'): void {
    if (!isDistributedOperationEnabled('obs.trace')) {
      return;
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      opId: operation.opId,
      correlationId: operation.correlationId,
      resourceId: operation.resourceId,
      type: operation.type,
      originNodeId: operation.originNodeId,
      phase,
      result
    };

    console.log(JSON.stringify(logEntry));
  }

  /**
   * Log cross-node operation
   */
  logCrossNodeOperation(
    operation: ResourceOperation,
    phase: string,
    targetNodeId: string,
    result: string = 'success'
  ): void {
    if (!isDistributedOperationEnabled('obs.trace')) {
      return;
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      opId: operation.opId,
      correlationId: operation.correlationId,
      resourceId: operation.resourceId,
      type: operation.type,
      originNodeId: operation.originNodeId,
      targetNodeId,
      phase,
      result
    };

    console.log(JSON.stringify(logEntry));
  }

  /**
   * Generate UUID v7 (time-ordered)
   * For now using a simple timestamp-based approach
   */
  private generateUuidV7(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `${timestamp.toString(36)}-${random}`;
  }

  /**
   * Extract operation from envelope if it exists, otherwise return null
   */
  unwrapOperation<T = any>(maybeEnvelope: any): ResourceOperation<T> | null {
    if (!isDistributedOperationEnabled('ops.envelope')) {
      return null;
    }

    // Check if this looks like a ResourceOperation envelope
    if (
      maybeEnvelope &&
      typeof maybeEnvelope === 'object' &&
      maybeEnvelope.opId &&
      maybeEnvelope.resourceId &&
      maybeEnvelope.type &&
      maybeEnvelope.originNodeId &&
      maybeEnvelope.correlationId
    ) {
      return maybeEnvelope as ResourceOperation<T>;
    }

    return null;
  }

  /**
   * Create an operation envelope for resource metadata changes
   */
  createResourceOperation(
    resourceMetadata: ResourceMetadata,
    type: OpType,
    correlationContext?: CorrelationContext
  ): ResourceOperation<ResourceMetadata> | null {
    return this.wrapOperation(
      resourceMetadata.resourceId,
      type,
      resourceMetadata,
      correlationContext
    );
  }

  /**
   * Check if operation envelope is enabled
   */
  isEnvelopeEnabled(): boolean {
    return isDistributedOperationEnabled('ops.envelope');
  }

  /**
   * Check if tracing is enabled
   */
  isTracingEnabled(): boolean {
    return isDistributedOperationEnabled('obs.trace');
  }
}

/**
 * Global operation envelope manager instance
 */
let globalEnvelopeManager: OperationEnvelopeManager | null = null;

/**
 * Initialize global envelope manager
 */
export function initializeOperationEnvelopeManager(nodeId: string): OperationEnvelopeManager {
  globalEnvelopeManager = new OperationEnvelopeManager(nodeId);
  return globalEnvelopeManager;
}

/**
 * Get global envelope manager
 */
export function getOperationEnvelopeManager(): OperationEnvelopeManager {
  if (!globalEnvelopeManager) {
    throw new Error('OperationEnvelopeManager not initialized. Call initializeOperationEnvelopeManager() first.');
  }
  return globalEnvelopeManager;
}
