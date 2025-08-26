import { ResourceOperation, VectorClock } from '../../resources/core/ResourceOperation';

export interface BufferedOperation<T = any> {
  operation: ResourceOperation<T>;
  receivedAt: number;
  retryCount: number;
}

export interface CausalOrderingConfig {
  maxBufferSize: number;
  maxWaitTimeMs: number;
  maxRetryCount: number;
  cleanupIntervalMs: number;
}

export class CausalOrderingEngine {
  private readonly buffer = new Map<string, BufferedOperation>();
  private readonly deliveredOperations = new Set<string>();
  private readonly localClock: VectorClock;
  private readonly config: CausalOrderingConfig;
  private isShutdown = false;

  constructor(
    nodeId: string,
    config: Partial<CausalOrderingConfig> = {}
  ) {
    this.config = {
      maxBufferSize: config.maxBufferSize ?? 1000,
      maxWaitTimeMs: config.maxWaitTimeMs ?? 30000,
      maxRetryCount: config.maxRetryCount ?? 5,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 10000
    };

    this.localClock = {
      nodeId,
      vector: new Map([[nodeId, 0]]),
      increment: () => {
        const current = this.localClock.vector.get(nodeId) || 0;
        this.localClock.vector.set(nodeId, current + 1);
        return this.localClock;
      },
      compare: (other: VectorClock) => this.compareVectorClocks(this.localClock, other),
      merge: (other: VectorClock) => this.mergeVectorClocks(this.localClock, other)
    };

    this.startCleanupLoop();
  }

  /**
   * Process an incoming operation with causal ordering
   */
  async processOperation<T>(
    operation: ResourceOperation<T>,
    processor: (op: ResourceOperation<T>) => Promise<void>
  ): Promise<void> {
    // Check if already delivered
    if (this.deliveredOperations.has(operation.opId)) {
      return;
    }

    // Check if operation can be delivered immediately
    if (this.canDeliver(operation)) {
      await this.deliverOperation(operation, processor);
      return;
    }

    // Buffer the operation for later delivery
    this.bufferOperation(operation);

    // Try to deliver any ready operations
    await this.tryDeliverBuffered(processor);
  }

  /**
   * Check if an operation can be delivered based on causal ordering
   */
  private canDeliver<T>(operation: ResourceOperation<T>): boolean {
    // An operation can be delivered if all causally preceding operations
    // have been delivered (vector clock comparison)
    
    for (const [nodeId, timestamp] of operation.vectorClock.vector.entries()) {
      const localTimestamp = this.localClock.vector.get(nodeId) || 0;
      
      // For the sender node, we expect exactly the next timestamp
      if (nodeId === operation.vectorClock.nodeId) {
        if (timestamp !== localTimestamp + 1) {
          return false;
        }
      } else {
        // For other nodes, we need to have seen at least this timestamp
        if (timestamp > localTimestamp) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Buffer an operation for later delivery
   */
  private bufferOperation<T>(operation: ResourceOperation<T>): void {
    // Check buffer size limit
    if (this.buffer.size >= this.config.maxBufferSize) {
      // Remove oldest buffered operation
      const oldest = this.findOldestBufferedOperation();
      if (oldest) {
        this.buffer.delete(oldest);
      }
    }

    const buffered: BufferedOperation<T> = {
      operation,
      receivedAt: Date.now(),
      retryCount: 0
    };

    this.buffer.set(operation.opId, buffered);
  }

  /**
   * Try to deliver all ready buffered operations
   */
  private async tryDeliverBuffered<T>(
    processor: (op: ResourceOperation<T>) => Promise<void>
  ): Promise<void> {
    let delivered = true;
    
    // Keep trying until no more operations can be delivered
    while (delivered && this.buffer.size > 0) {
      delivered = false;
      
      for (const [opId, buffered] of this.buffer.entries()) {
        if (this.canDeliver(buffered.operation)) {
          await this.deliverOperation(buffered.operation, processor);
          this.buffer.delete(opId);
          delivered = true;
          break; // Start over to maintain order
        }
      }
    }
  }

  /**
   * Deliver an operation and update local state
   */
  private async deliverOperation<T>(
    operation: ResourceOperation<T>,
    processor: (op: ResourceOperation<T>) => Promise<void>
  ): Promise<void> {
    try {
      // Process the operation
      await processor(operation);
      
      // Update local vector clock
      this.localClock.merge(operation.vectorClock);
      
      // Mark as delivered
      this.deliveredOperations.add(operation.opId);
      
      // Clean up old delivered operations to prevent memory leak
      this.cleanupDeliveredOperations();
      
    } catch (error) {
      // Re-throw for caller to handle
      throw new Error(`Failed to deliver operation ${operation.opId}: ${error}`);
    }
  }

  /**
   * Compare two vector clocks for causal ordering
   */
  private compareVectorClocks(a: VectorClock, b: VectorClock): number {
    let aLessB = false;
    let bLessA = false;
    
    // Get all node IDs from both clocks
    const allNodes = new Set([
      ...a.vector.keys(),
      ...b.vector.keys()
    ]);
    
    for (const nodeId of allNodes) {
      const aValue = a.vector.get(nodeId) || 0;
      const bValue = b.vector.get(nodeId) || 0;
      
      if (aValue < bValue) {
        aLessB = true;
      } else if (aValue > bValue) {
        bLessA = true;
      }
    }
    
    if (aLessB && !bLessA) return -1; // a < b
    if (bLessA && !aLessB) return 1;  // a > b
    if (!aLessB && !bLessA) return 0; // a == b
    return NaN; // concurrent/incomparable
  }

  /**
   * Merge two vector clocks
   */
  private mergeVectorClocks(a: VectorClock, b: VectorClock): VectorClock {
    const merged = new Map(a.vector);
    
    for (const [nodeId, timestamp] of b.vector.entries()) {
      const currentTimestamp = merged.get(nodeId) || 0;
      merged.set(nodeId, Math.max(currentTimestamp, timestamp));
    }
    
    return {
      nodeId: a.nodeId,
      vector: merged,
      increment: a.increment,
      compare: a.compare,
      merge: a.merge
    };
  }

  /**
   * Find the oldest buffered operation for cleanup
   */
  private findOldestBufferedOperation(): string | null {
    let oldest: { opId: string; receivedAt: number } | null = null;
    
    for (const [opId, buffered] of this.buffer.entries()) {
      if (!oldest || buffered.receivedAt < oldest.receivedAt) {
        oldest = { opId, receivedAt: buffered.receivedAt };
      }
    }
    
    return oldest?.opId || null;
  }

  /**
   * Clean up old delivered operations to prevent memory leaks
   */
  private cleanupDeliveredOperations(): void {
    // Keep only recent delivered operations (last 1000)
    if (this.deliveredOperations.size > 1000) {
      const toKeep = Array.from(this.deliveredOperations).slice(-1000);
      this.deliveredOperations.clear();
      toKeep.forEach(opId => this.deliveredOperations.add(opId));
    }
  }

  /**
   * Start cleanup loop for expired buffered operations
   */
  private startCleanupLoop(): void {
    const cleanup = async () => {
      while (!this.isShutdown) {
        await this.sleep(this.config.cleanupIntervalMs);
        if (!this.isShutdown) {
          this.cleanupExpiredOperations();
        }
      }
    };
    
    cleanup().catch(() => {
      // Ignore cleanup errors
    });
  }

  /**
   * Clean up expired buffered operations
   */
  private cleanupExpiredOperations(): void {
    const now = Date.now();
    const expiredOps: string[] = [];
    
    for (const [opId, buffered] of this.buffer.entries()) {
      if (now - buffered.receivedAt > this.config.maxWaitTimeMs) {
        expiredOps.push(opId);
      }
    }
    
    for (const opId of expiredOps) {
      this.buffer.delete(opId);
    }
  }

  /**
   * Sleep utility for async waiting
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const timer = Date.now() + ms;
      const check = () => {
        if (Date.now() >= timer) {
          resolve();
        } else {
          Promise.resolve().then(check);
        }
      };
      check();
    });
  }

  /**
   * Get the current local vector clock
   */
  getLocalClock(): VectorClock {
    return {
      nodeId: this.localClock.nodeId,
      vector: new Map(this.localClock.vector),
      increment: this.localClock.increment,
      compare: this.localClock.compare,
      merge: this.localClock.merge
    };
  }

  /**
   * Increment local clock for outgoing operations
   */
  incrementClock(): VectorClock {
    return this.localClock.increment();
  }

  /**
   * Get ordering statistics
   */
  getStats() {
    const bufferedByAge = Array.from(this.buffer.values())
      .map(b => Date.now() - b.receivedAt);
    
    return {
      bufferedOperations: this.buffer.size,
      deliveredOperations: this.deliveredOperations.size,
      avgBufferAge: bufferedByAge.length > 0 
        ? bufferedByAge.reduce((a, b) => a + b, 0) / bufferedByAge.length 
        : 0,
      maxBufferAge: bufferedByAge.length > 0 ? Math.max(...bufferedByAge) : 0,
      clockVector: Object.fromEntries(this.localClock.vector)
    };
  }

  /**
   * Shutdown the causal ordering engine
   */
  shutdown(): void {
    this.isShutdown = true;
    this.buffer.clear();
    this.deliveredOperations.clear();
  }
}
