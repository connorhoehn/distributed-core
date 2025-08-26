import { ResourceOperation } from '../../resources/core/ResourceOperation';

export interface DeduplicationEntry {
  operationId: string;
  timestamp: number;
  ttlMs: number;
  processed: boolean;
  result?: any;
  error?: Error;
}

export interface DeduplicationConfig {
  defaultTtlMs: number;
  cleanupIntervalMs: number;
  maxEntries: number;
}

export class OperationDeduplicator {
  private readonly cache = new Map<string, DeduplicationEntry>();
  private readonly config: DeduplicationConfig;
  private cleanupTimer?: any;
  private isShutdown = false;

  constructor(config: Partial<DeduplicationConfig> = {}) {
    this.config = {
      defaultTtlMs: config.defaultTtlMs ?? 60000, // 1 minute
      cleanupIntervalMs: config.cleanupIntervalMs ?? 30000, // 30 seconds
      maxEntries: config.maxEntries ?? 10000
    };

    this.startCleanupTimer();
  }

  /**
   * Check if an operation has been seen before
   */
  isDuplicate<T>(operation: ResourceOperation<T>): boolean {
    const entry = this.cache.get(operation.opId);
    if (!entry) {
      return false;
    }

    // Check if entry has expired
    if (this.isExpired(entry)) {
      this.cache.delete(operation.opId);
      return false;
    }

    return true;
  }

  /**
   * Mark an operation as being processed
   */
  markProcessing<T>(operation: ResourceOperation<T>, ttlMs?: number): void {
    const entry: DeduplicationEntry = {
      operationId: operation.opId,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.config.defaultTtlMs,
      processed: false
    };

    this.cache.set(operation.opId, entry);
    this.enforceMaxEntries();
  }

  /**
   * Mark an operation as completed with result
   */
  markCompleted<T>(operation: ResourceOperation<T>, result: any): void {
    const entry = this.cache.get(operation.opId);
    if (entry) {
      entry.processed = true;
      entry.result = result;
    }
  }

  /**
   * Mark an operation as failed with error
   */
  markFailed<T>(operation: ResourceOperation<T>, error: Error): void {
    const entry = this.cache.get(operation.opId);
    if (entry) {
      entry.processed = true;
      entry.error = error;
    }
  }

  /**
   * Get the result of a previously processed operation
   */
  getResult<T>(operation: ResourceOperation<T>): { result?: any; error?: Error } | null {
    const entry = this.cache.get(operation.opId);
    if (!entry || !entry.processed || this.isExpired(entry)) {
      return null;
    }

    return {
      result: entry.result,
      error: entry.error
    };
  }

  /**
   * Process an operation with automatic deduplication
   */
  async processOnce<T, R>(
    operation: ResourceOperation<T>,
    processor: (op: ResourceOperation<T>) => Promise<R>,
    ttlMs?: number
  ): Promise<R> {
    // Check if already processed
    const existing = this.getResult(operation);
    if (existing) {
      if (existing.error) {
        throw existing.error;
      }
      return existing.result;
    }

    // Check if currently being processed
    if (this.isDuplicate(operation)) {
      // Wait for processing to complete
      return this.waitForCompletion(operation);
    }

    // Mark as processing
    this.markProcessing(operation, ttlMs);

    try {
      const result = await processor(operation);
      this.markCompleted(operation, result);
      return result;
    } catch (error) {
      this.markFailed(operation, error as Error);
      throw error;
    }
  }

  /**
   * Wait for an operation to complete processing
   */
  private async waitForCompletion<T>(
    operation: ResourceOperation<T>,
    timeoutMs: number = 30000
  ): Promise<any> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const result = this.getResult(operation);
      if (result) {
        if (result.error) {
          throw result.error;
        }
        return result.result;
      }
      
      // Short wait before checking again
      await this.sleep(100);
    }
    
    throw new Error(`Operation ${operation.opId} timed out waiting for completion`);
  }

  /**
   * Sleep utility for async waiting
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      // Use a simple timer approach
      const timer = Date.now() + ms;
      const check = () => {
        if (Date.now() >= timer) {
          resolve();
        } else {
          // Use setImmediate-like behavior
          Promise.resolve().then(check);
        }
      };
      check();
    });
  }

  /**
   * Check if an entry has expired
   */
  private isExpired(entry: DeduplicationEntry): boolean {
    return Date.now() - entry.timestamp > entry.ttlMs;
  }

  /**
   * Start the cleanup timer to remove expired entries
   */
  private startCleanupTimer(): void {
    const runCleanup = async () => {
      while (!this.isShutdown) {
        await this.sleep(this.config.cleanupIntervalMs);
        if (!this.isShutdown) {
          this.cleanup();
        }
      }
    };
    runCleanup().catch(() => {
      // Ignore cleanup errors
    });
  }

  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttlMs) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.cache.delete(key);
    }
  }

  /**
   * Enforce maximum number of entries by removing oldest
   */
  private enforceMaxEntries(): void {
    if (this.cache.size <= this.config.maxEntries) {
      return;
    }

    // Convert to array and sort by timestamp
    const entries = Array.from(this.cache.entries())
      .sort(([, a], [, b]) => a.timestamp - b.timestamp);

    // Remove oldest entries
    const toRemove = entries.slice(0, this.cache.size - this.config.maxEntries);
    for (const [key] of toRemove) {
      this.cache.delete(key);
    }
  }

  /**
   * Get deduplication statistics
   */
  getStats() {
    const entries = Array.from(this.cache.values());
    const processed = entries.filter(e => e.processed).length;
    const processing = entries.length - processed;
    const expired = entries.filter(e => this.isExpired(e)).length;

    return {
      totalEntries: this.cache.size,
      processed,
      processing,
      expired,
      memoryUsage: this.cache.size * 200 // Rough estimate
    };
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Shutdown the deduplicator
   */
  shutdown(): void {
    this.isShutdown = true;
    this.clear();
  }
}
