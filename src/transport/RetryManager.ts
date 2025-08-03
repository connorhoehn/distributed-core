import { EventEmitter } from 'events';

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
  jitter?: boolean;
  jitterRange?: number;
  timeout?: number;
  retryCondition?: (error: Error, attempt: number) => boolean;
  enableLogging?: boolean;
  name?: string;
}

export interface RetryAttempt {
  attempt: number;
  delay: number;
  error?: Error;
  timestamp: number;
  totalElapsed: number;
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: RetryAttempt[];
  totalTime: number;
  finalAttempt: number;
}

export interface DeadLetterMessage<T> {
  id: string;
  operation: string;
  payload: T;
  attempts: RetryAttempt[];
  firstAttempt: number;
  lastAttempt: number;
  finalError: Error;
}

/**
 * Configurable retry policies for different operation types
 */
export enum RetryPolicy {
  EXPONENTIAL = 'exponential',
  LINEAR = 'linear',
  FIXED = 'fixed',
  FIBONACCI = 'fibonacci'
}

/**
 * Enhanced retry manager with exponential backoff, jitter, and dead letter queue
 */
export class RetryManager extends EventEmitter {
  private deadLetterQueue = new Map<string, DeadLetterMessage<any>>();
  private activeRetries = new Map<string, RetryAttempt[]>();
  private idempotencyCache = new Map<string, any>();
  private readonly options: Required<RetryOptions>;

  constructor(options: RetryOptions = {}) {
    super();
    
    this.options = {
      maxRetries: options.maxRetries || 3,
      baseDelay: options.baseDelay || 1000,
      maxDelay: options.maxDelay || 30000,
      backoffFactor: options.backoffFactor || 2,
      jitter: options.jitter !== false,
      jitterRange: options.jitterRange || 0.1,
      timeout: options.timeout || 60000,
      retryCondition: options.retryCondition || this.defaultRetryCondition,
      enableLogging: options.enableLogging !== false,
      name: options.name || 'retry-manager'
    };

    this.log('Retry manager initialized');
  }

  /**
   * Execute operation with retry logic
   */
  async execute<T>(
    operation: () => Promise<T>,
    operationId?: string,
    customOptions?: Partial<RetryOptions>
  ): Promise<T> {
    const opts = { ...this.options, ...customOptions };
    const id = operationId || this.generateOperationId();
    const startTime = Date.now();
    const attempts: RetryAttempt[] = [];

    // Check idempotency cache
    if (operationId && this.idempotencyCache.has(operationId)) {
      this.emit('cache-hit', { operationId });
      return this.idempotencyCache.get(operationId);
    }

    this.activeRetries.set(id, attempts);

    try {
      const result = await this.executeWithRetries(operation, opts, id, attempts, startTime);
      
      // Cache successful result for idempotency
      if (operationId) {
        this.idempotencyCache.set(operationId, result);
        // Clean up cache after some time
        const cleanupTimer = setTimeout(() => this.idempotencyCache.delete(operationId), 300000); // 5 minutes
        cleanupTimer.unref(); // Prevent Jest hanging
      }

      this.activeRetries.delete(id);
      
      this.emit('operation-success', {
        operationId: id,
        result,
        attempts: attempts.length,
        totalTime: Date.now() - startTime
      });

      return result;

    } catch (error) {
      this.activeRetries.delete(id);
      
      // Add to dead letter queue
      const deadLetter: DeadLetterMessage<any> = {
        id,
        operation: operation.name || 'anonymous',
        payload: null, // Can't serialize function
        attempts,
        firstAttempt: startTime,
        lastAttempt: Date.now(),
        finalError: error as Error
      };
      
      this.deadLetterQueue.set(id, deadLetter);
      
      this.emit('operation-failed', {
        operationId: id,
        error,
        attempts: attempts.length,
        totalTime: Date.now() - startTime,
        deadLetter
      });

      throw error;
    }
  }

  /**
   * Execute operation with retries
   */
  private async executeWithRetries<T>(
    operation: () => Promise<T>,
    options: Required<RetryOptions>,
    operationId: string,
    attempts: RetryAttempt[],
    startTime: number
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= options.maxRetries + 1; attempt++) {
      const attemptStart = Date.now();
      const totalElapsed = attemptStart - startTime;

      // Check total timeout
      if (totalElapsed >= options.timeout) {
        throw new Error(`Operation timeout after ${totalElapsed}ms`);
      }

      const attemptInfo: RetryAttempt = {
        attempt,
        delay: 0,
        timestamp: attemptStart,
        totalElapsed
      };

      try {
        this.emit('attempt-start', { operationId, attempt, totalElapsed });
        
        const result = await operation();
        
        attemptInfo.delay = Date.now() - attemptStart;
        attempts.push(attemptInfo);
        
        this.emit('attempt-success', { operationId, attempt, result });
        return result;

      } catch (error) {
        lastError = error as Error;
        attemptInfo.error = lastError;
        attemptInfo.delay = Date.now() - attemptStart;
        attempts.push(attemptInfo);

        this.emit('attempt-failure', { 
          operationId, 
          attempt, 
          error: lastError, 
          willRetry: attempt <= options.maxRetries 
        });

        // Check if we should retry
        if (attempt > options.maxRetries || !options.retryCondition(lastError, attempt)) {
          break;
        }

        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt, options);
        
        this.log(`Attempt ${attempt} failed, retrying in ${delay}ms`);
        this.emit('retry-scheduled', { operationId, attempt, delay, error: lastError });
        
        await this.sleep(delay);
      }
    }

    throw lastError || new Error('Operation failed with unknown error');
  }

  /**
   * Calculate delay with backoff and jitter
   */
  private calculateDelay(attempt: number, options: Required<RetryOptions>): number {
    let delay = options.baseDelay * Math.pow(options.backoffFactor, attempt - 1);
    
    // Apply maximum delay cap
    delay = Math.min(delay, options.maxDelay);
    
    // Apply jitter if enabled
    if (options.jitter) {
      const jitterAmount = delay * options.jitterRange;
      const jitter = (Math.random() - 0.5) * 2 * jitterAmount;
      delay = Math.max(0, delay + jitter);
    }
    
    return Math.round(delay);
  }

  /**
   * Calculate delay using different policies
   */
  calculateDelayByPolicy(attempt: number, policy: RetryPolicy, baseDelay: number = 1000): number {
    switch (policy) {
      case RetryPolicy.EXPONENTIAL:
        return baseDelay * Math.pow(2, attempt - 1);
      
      case RetryPolicy.LINEAR:
        return baseDelay * attempt;
      
      case RetryPolicy.FIXED:
        return baseDelay;
      
      case RetryPolicy.FIBONACCI:
        return baseDelay * this.fibonacci(attempt);
      
      default:
        return baseDelay;
    }
  }

  /**
   * Fibonacci sequence generator
   */
  private fibonacci(n: number): number {
    if (n <= 1) return 1;
    if (n === 2) return 1;
    
    let a = 1, b = 1;
    for (let i = 3; i <= n; i++) {
      const temp = a + b;
      a = b;
      b = temp;
    }
    return b;
  }

  /**
   * Default retry condition - retries on most errors except certain types
   */
  private defaultRetryCondition(error: Error, attempt: number): boolean {
    // Don't retry on certain error types
    if (error.name === 'SyntaxError' || error.name === 'TypeError') {
      return false;
    }

    // Don't retry on HTTP 4xx errors (client errors)
    if (error.message.includes('400') || error.message.includes('401') || 
        error.message.includes('403') || error.message.includes('404')) {
      return false;
    }

    return true;
  }

  /**
   * Execute with custom retry policy
   */
  async executeWithPolicy<T>(
    operation: () => Promise<T>,
    policy: RetryPolicy,
    maxRetries: number = 3,
    baseDelay: number = 1000,
    operationId?: string
  ): Promise<T> {
    const customOptions: Partial<RetryOptions> = {
      maxRetries,
      baseDelay,
      retryCondition: (error, attempt) => {
        const delay = this.calculateDelayByPolicy(attempt + 1, policy, baseDelay);
        return delay <= this.options.maxDelay && this.defaultRetryCondition(error, attempt);
      }
    };

    return this.execute(operation, operationId, customOptions);
  }

  /**
   * Batch retry operations
   */
  async executeBatch<T>(
    operations: Array<() => Promise<T>>,
    batchId?: string,
    concurrency: number = 5
  ): Promise<Array<RetryResult<T>>> {
    const id = batchId || this.generateOperationId();
    const results: Array<RetryResult<T>> = [];
    
    this.emit('batch-start', { batchId: id, operationCount: operations.length });

    // Process operations in chunks with limited concurrency
    for (let i = 0; i < operations.length; i += concurrency) {
      const chunk = operations.slice(i, i + concurrency);
      const chunkPromises = chunk.map(async (operation, index) => {
        const operationId = `${id}-${i + index}`;
        const startTime = Date.now();
        
        try {
          const result = await this.execute(operation, operationId);
          return {
            success: true,
            result,
            attempts: this.activeRetries.get(operationId) || [],
            totalTime: Date.now() - startTime,
            finalAttempt: 1
          } as RetryResult<T>;
        } catch (error) {
          return {
            success: false,
            error: error as Error,
            attempts: this.activeRetries.get(operationId) || [],
            totalTime: Date.now() - startTime,
            finalAttempt: this.options.maxRetries + 1
          } as RetryResult<T>;
        }
      });

      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults);
    }

    this.emit('batch-complete', { 
      batchId: id, 
      totalOperations: operations.length,
      successCount: results.filter(r => r.success).length,
      failureCount: results.filter(r => !r.success).length
    });

    return results;
  }

  /**
   * Get dead letter queue contents
   */
  getDeadLetterQueue(): DeadLetterMessage<any>[] {
    return Array.from(this.deadLetterQueue.values());
  }

  /**
   * Reprocess dead letter message
   */
  async reprocessDeadLetter<T>(messageId: string, operation: () => Promise<T>): Promise<T> {
    const deadLetter = this.deadLetterQueue.get(messageId);
    if (!deadLetter) {
      throw new Error(`Dead letter message not found: ${messageId}`);
    }

    this.deadLetterQueue.delete(messageId);
    this.emit('dead-letter-reprocessing', { messageId, deadLetter });

    try {
      const result = await this.execute(operation, `reprocess-${messageId}`);
      this.emit('dead-letter-success', { messageId, result });
      return result;
    } catch (error) {
      // Put it back in dead letter queue if it fails again
      this.deadLetterQueue.set(messageId, {
        ...deadLetter,
        lastAttempt: Date.now()
      });
      this.emit('dead-letter-failed', { messageId, error });
      throw error;
    }
  }

  /**
   * Clear dead letter queue
   */
  clearDeadLetterQueue(): void {
    const count = this.deadLetterQueue.size;
    this.deadLetterQueue.clear();
    this.emit('dead-letter-cleared', { count });
  }

  /**
   * Get active retry operations
   */
  getActiveRetries(): Array<{ operationId: string; attempts: RetryAttempt[] }> {
    return Array.from(this.activeRetries.entries()).map(([id, attempts]) => ({
      operationId: id,
      attempts
    }));
  }

  /**
   * Get retry statistics
   */
  getStats(): {
    activeRetries: number;
    deadLetterCount: number;
    idempotencyCacheSize: number;
    totalProcessed: number;
  } {
    return {
      activeRetries: this.activeRetries.size,
      deadLetterCount: this.deadLetterQueue.size,
      idempotencyCacheSize: this.idempotencyCache.size,
      totalProcessed: this.deadLetterQueue.size + this.idempotencyCache.size
    };
  }

  /**
   * Generate unique operation ID
   */
  private generateOperationId(): string {
    return `op-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      timer.unref(); // Prevent Jest hanging
    });
  }

  /**
   * Log message if logging is enabled
   */
  private log(message: string): void {
    if (this.options.enableLogging) {
      console.log(`[RetryManager:${this.options.name}] ${message}`);
    }
  }

  /**
   * Update retry options
   */
  updateOptions(newOptions: Partial<RetryOptions>): void {
    Object.assign(this.options, newOptions);
    this.emit('options-updated', { options: this.options });
    this.log('Options updated');
  }

  /**
   * Clear all caches and state
   */
  clear(): void {
    this.deadLetterQueue.clear();
    this.activeRetries.clear();
    this.idempotencyCache.clear();
    this.emit('cleared');
    this.log('All state cleared');
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.clear();
    this.removeAllListeners();
    this.emit('destroyed');
    this.log('Retry manager destroyed');
  }
}
