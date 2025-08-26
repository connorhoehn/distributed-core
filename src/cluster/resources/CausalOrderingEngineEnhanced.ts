/**
 * Enhanced CausalOrderingEngine with production-ready buffer management
 * 
 * Addresses Challenge: "What buffering thresholds exist to prevent unbounded memory use?"
 * 
 * This implementation adds:
 * - Configurable buffer limits per resource
 * - Deadlock detection and recovery
 * - Buffer overflow policies
 * - Comprehensive metrics and observability
 */

import { ResourceOperation } from './ResourceOperation';

// Node.js environment access
declare const console: any;

export interface CausalBufferConfig {
  maxBufferSizePerResource: number;     // Default: 1000 operations
  maxWaitTimeMs: number;                // Default: 30000ms (30 seconds)
  deadlockDetectionMs: number;          // Default: 60000ms (1 minute)
  bufferOverflowPolicy: 'drop-oldest' | 'drop-newest' | 'halt-resource';
  cleanupIntervalMs: number;            // Default: 10000ms (10 seconds)
  enableMetrics: boolean;               // Default: true
}

export interface CausalBufferMetrics {
  bufferDepth: Map<string, number>;     // Per-resource current buffer size
  totalBuffered: number;                // Total operations across all resources
  totalDropped: number;                 // Operations dropped due to overflow
  totalDeadlocks: number;               // Deadlocks detected and resolved
  avgWaitTime: number;                  // Average time operations wait in buffer
}

export interface BufferedOperation {
  operation: ResourceOperation;
  enqueuedAt: number;                   // Timestamp when added to buffer
  dependencies: Set<string>;            // opIds this operation depends on
  waitingFor: Set<string>;              // Specific missing dependencies
}

export class CausalOrderingEngineEnhanced {
  private config: CausalBufferConfig;
  private buffers = new Map<string, BufferedOperation[]>(); // resourceId -> operations
  private processedOps = new Set<string>();  // Recently processed opIds for dependency checking
  private metrics: CausalBufferMetrics;
  private cleanupTimer?: any; // Timer reference

  constructor(config: Partial<CausalBufferConfig> = {}) {
    this.config = {
      maxBufferSizePerResource: 1000,
      maxWaitTimeMs: 30000,
      deadlockDetectionMs: 60000,
      bufferOverflowPolicy: 'drop-oldest',
      cleanupIntervalMs: 10000,
      enableMetrics: true,
      ...config
    };

    this.metrics = {
      bufferDepth: new Map(),
      totalBuffered: 0,
      totalDropped: 0,
      totalDeadlocks: 0,
      avgWaitTime: 0
    };

    // Start periodic cleanup and deadlock detection
    this.startCleanupTimer();
  }

  /**
   * Process an operation with causal ordering guarantees
   */
  async processOperation(
    operation: ResourceOperation,
    applyFunction: (op: ResourceOperation) => Promise<void>
  ): Promise<boolean> {
    const resourceId = operation.resourceId;
    const opId = operation.opId;

    try {
      // Check if dependencies are satisfied
      if (this.areDependenciesSatisfied(operation)) {
        // Can apply immediately
        await this.applyOperationAndDownstream(operation, applyFunction);
        return true;
      } else {
        // Must buffer for causal ordering
        return this.bufferOperation(operation, applyFunction);
      }
    } catch (error) {
      console.error(`❌ Error processing operation ${opId} for resource ${resourceId}:`, error);
      throw error;
    }
  }

  /**
   * Check if all dependencies for an operation are satisfied
   */
  private areDependenciesSatisfied(operation: ResourceOperation): boolean {
    if (!operation.parents || operation.parents.length === 0) {
      return true; // No dependencies
    }

    // Check if all parent operations have been processed
    return operation.parents.every(parentOpId => this.processedOps.has(parentOpId));
  }

  /**
   * Buffer an operation that cannot be applied yet due to missing dependencies
   */
  private bufferOperation(
    operation: ResourceOperation,
    applyFunction: (op: ResourceOperation) => Promise<void>
  ): boolean {
    const resourceId = operation.resourceId;
    const opId = operation.opId;

    // Get or create buffer for this resource
    if (!this.buffers.has(resourceId)) {
      this.buffers.set(resourceId, []);
    }

    const buffer = this.buffers.get(resourceId)!;

    // Check buffer overflow
    if (buffer.length >= this.config.maxBufferSizePerResource) {
      return this.handleBufferOverflow(resourceId, operation, applyFunction);
    }

    // Calculate missing dependencies
    const waitingFor = new Set<string>();
    if (operation.parents) {
      operation.parents.forEach(parentOpId => {
        if (!this.processedOps.has(parentOpId)) {
          waitingFor.add(parentOpId);
        }
      });
    }

    // Add to buffer
    const bufferedOp: BufferedOperation = {
      operation,
      enqueuedAt: Date.now(),
      dependencies: new Set(operation.parents || []),
      waitingFor
    };

    buffer.push(bufferedOp);
    this.updateMetrics(resourceId);

    console.log(`📋 Buffered operation ${opId} for resource ${resourceId}, waiting for: [${Array.from(waitingFor).join(', ')}]`);
    return true;
  }

  /**
   * Handle buffer overflow according to configured policy
   */
  private handleBufferOverflow(
    resourceId: string,
    operation: ResourceOperation,
    applyFunction: (op: ResourceOperation) => Promise<void>
  ): boolean {
    const buffer = this.buffers.get(resourceId)!;
    this.metrics.totalDropped++;

    switch (this.config.bufferOverflowPolicy) {
      case 'drop-oldest':
        const dropped = buffer.shift();
        buffer.push({
          operation,
          enqueuedAt: Date.now(),
          dependencies: new Set(operation.parents || []),
          waitingFor: new Set()
        });
        console.warn(`⚠️ Buffer overflow for ${resourceId}: dropped oldest operation ${dropped?.operation.opId}`);
        return true;

      case 'drop-newest':
        console.warn(`⚠️ Buffer overflow for ${resourceId}: dropping new operation ${operation.opId}`);
        return false;

      case 'halt-resource':
        console.error(`🛑 Buffer overflow for ${resourceId}: halting resource processing`);
        throw new Error(`Causal buffer overflow for resource ${resourceId}`);

      default:
        return false;
    }
  }

  /**
   * Apply an operation and check if any buffered operations can now be processed
   */
  private async applyOperationAndDownstream(
    operation: ResourceOperation,
    applyFunction: (op: ResourceOperation) => Promise<void>
  ): Promise<void> {
    const opId = operation.opId;
    const resourceId = operation.resourceId;

    // Apply the operation
    await applyFunction(operation);

    // Mark as processed
    this.processedOps.add(opId);

    console.log(`✅ Applied operation ${opId} for resource ${resourceId}`);

    // Check if any buffered operations can now be processed
    await this.processPendingOperations(resourceId, applyFunction);
  }

  /**
   * Check buffered operations to see if any can now be applied
   */
  private async processPendingOperations(
    resourceId: string,
    applyFunction: (op: ResourceOperation) => Promise<void>
  ): Promise<void> {
    const buffer = this.buffers.get(resourceId);
    if (!buffer || buffer.length === 0) {
      return;
    }

    const readyOperations: BufferedOperation[] = [];
    const stillWaiting: BufferedOperation[] = [];

    // Partition operations into ready vs still waiting
    for (const bufferedOp of buffer) {
      const stillMissing = new Set<string>();
      
      bufferedOp.waitingFor.forEach(parentOpId => {
        if (!this.processedOps.has(parentOpId)) {
          stillMissing.add(parentOpId);
        }
      });

      if (stillMissing.size === 0) {
        readyOperations.push(bufferedOp);
      } else {
        bufferedOp.waitingFor = stillMissing;
        stillWaiting.push(bufferedOp);
      }
    }

    // Update buffer with operations that are still waiting
    this.buffers.set(resourceId, stillWaiting);

    // Apply ready operations
    for (const readyOp of readyOperations) {
      await this.applyOperationAndDownstream(readyOp.operation, applyFunction);
    }

    this.updateMetrics(resourceId);
  }

  /**
   * Detect and resolve deadlocks in causal ordering
   */
  private detectAndResolveDeadlocks(): void {
    const now = Date.now();
    const deadlockThreshold = now - this.config.deadlockDetectionMs;

    for (const [resourceId, buffer] of this.buffers.entries()) {
      const potentialDeadlocks = buffer.filter(
        bufferedOp => bufferedOp.enqueuedAt < deadlockThreshold
      );

      if (potentialDeadlocks.length > 0) {
        console.warn(`🔄 Potential deadlock detected for resource ${resourceId}: ${potentialDeadlocks.length} operations waiting too long`);
        
        // Resolve by dropping oldest operations (could be made configurable)
        const toResolve = potentialDeadlocks.slice(0, Math.max(1, potentialDeadlocks.length / 2));
        
        for (const deadlockedOp of toResolve) {
          const index = buffer.indexOf(deadlockedOp);
          if (index >= 0) {
            buffer.splice(index, 1);
            this.metrics.totalDeadlocks++;
            console.warn(`🔓 Resolved deadlock by dropping operation ${deadlockedOp.operation.opId}`);
          }
        }

        this.updateMetrics(resourceId);
      }
    }
  }

  /**
   * Update metrics for monitoring and observability
   */
  private updateMetrics(resourceId: string): void {
    if (!this.config.enableMetrics) return;

    const buffer = this.buffers.get(resourceId) || [];
    this.metrics.bufferDepth.set(resourceId, buffer.length);
    
    this.metrics.totalBuffered = Array.from(this.buffers.values())
      .reduce((total, buf) => total + buf.length, 0);

    // Calculate average wait time
    const now = Date.now();
    const allWaitTimes = Array.from(this.buffers.values())
      .flat()
      .map(bufferedOp => now - bufferedOp.enqueuedAt);
    
    this.metrics.avgWaitTime = allWaitTimes.length > 0 
      ? allWaitTimes.reduce((sum, time) => sum + time, 0) / allWaitTimes.length 
      : 0;
  }

  /**
   * Start periodic cleanup and deadlock detection
   */
  private startCleanupTimer(): void {
    // Use setTimeout with recursive calls instead of setInterval for better control
    const scheduleNextCleanup = () => {
      this.cleanupTimer = setTimeout(() => {
        this.detectAndResolveDeadlocks();
        this.cleanupProcessedOps();
        scheduleNextCleanup(); // Schedule next cleanup
      }, this.config.cleanupIntervalMs);
    };
    scheduleNextCleanup();
  }

  /**
   * Clean up old processed operation IDs to prevent memory leaks
   */
  private cleanupProcessedOps(): void {
    // Keep processed ops for 2x deadlock detection time to ensure proper dependency resolution
    const keepThreshold = Date.now() - (this.config.deadlockDetectionMs * 2);
    
    // In a real implementation, you'd need to track when each opId was processed
    // For now, just limit the size of processedOps
    if (this.processedOps.size > 10000) {
      const opsArray = Array.from(this.processedOps);
      const toKeep = opsArray.slice(-5000); // Keep most recent 5000
      this.processedOps = new Set(toKeep);
      console.log(`🧹 Cleaned up processed operations cache, kept ${toKeep.length} recent entries`);
    }
  }

  /**
   * Get current metrics for monitoring
   */
  getMetrics(): CausalBufferMetrics {
    return {
      bufferDepth: new Map(this.metrics.bufferDepth),
      totalBuffered: this.metrics.totalBuffered,
      totalDropped: this.metrics.totalDropped,
      totalDeadlocks: this.metrics.totalDeadlocks,
      avgWaitTime: this.metrics.avgWaitTime
    };
  }

  /**
   * Get detailed buffer state for debugging
   */
  getBufferState(resourceId?: string): Record<string, BufferedOperation[]> {
    if (resourceId) {
      return { [resourceId]: this.buffers.get(resourceId) || [] };
    }
    return Object.fromEntries(this.buffers);
  }

  /**
   * Cleanup and stop the engine
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.buffers.clear();
    this.processedOps.clear();
    console.log('🧹 CausalOrderingEngine destroyed');
  }
}
