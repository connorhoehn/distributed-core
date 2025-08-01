import { EventEmitter } from 'events';

export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open'
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  successThreshold?: number;
  timeout?: number;
  resetTimeout?: number;
  halfOpenMaxCalls?: number;
  enableLogging?: boolean;
  name?: string;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  totalCalls: number;
  lastFailureTime?: number;
  stateChangedAt: number;
  halfOpenCalls: number;
}

export interface CallResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  duration: number;
}

/**
 * Circuit breaker implementation for preventing cascade failures
 * Supports configurable thresholds, half-open state testing, and exponential backoff
 */
export class CircuitBreaker<T = any> extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private totalCalls: number = 0;
  private lastFailureTime?: number;
  private stateChangedAt: number = Date.now();
  private halfOpenCalls: number = 0;
  private resetTimer?: NodeJS.Timeout;
  
  private readonly options: Required<CircuitBreakerOptions>;

  constructor(options: CircuitBreakerOptions = {}) {
    super();
    
    this.options = {
      failureThreshold: options.failureThreshold || 5,
      successThreshold: options.successThreshold || 3,
      timeout: options.timeout || 60000, // 1 minute
      resetTimeout: options.resetTimeout || 60000, // 1 minute
      halfOpenMaxCalls: options.halfOpenMaxCalls || 3,
      enableLogging: options.enableLogging !== false,
      name: options.name || 'circuit-breaker'
    };

    this.log(`Circuit breaker '${this.options.name}' initialized`);
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<R = T>(fn: () => Promise<R>): Promise<R> {
    if (this.state === CircuitState.OPEN) {
      const error = new Error(`Circuit breaker '${this.options.name}' is OPEN`);
      this.emit('call-rejected', { reason: 'circuit-open', error });
      throw error;
    }

    if (this.state === CircuitState.HALF_OPEN && this.halfOpenCalls >= this.options.halfOpenMaxCalls) {
      const error = new Error(`Circuit breaker '${this.options.name}' half-open limit exceeded`);
      this.emit('call-rejected', { reason: 'half-open-limit', error });
      throw error;
    }

    const startTime = Date.now();
    this.totalCalls++;
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenCalls++;
    }

    try {
      this.emit('call-started', { state: this.state, totalCalls: this.totalCalls });
      
      const result = await this.executeWithTimeout(fn);
      const duration = Math.max(1, Date.now() - startTime); // Ensure at least 1ms
      
      this.onSuccess(duration);
      this.emit('call-success', { result, duration, state: this.state });
      
      return result;
      
    } catch (error) {
      const duration = Math.max(1, Date.now() - startTime); // Ensure at least 1ms
      
      this.onFailure(error as Error, duration);
      this.emit('call-failure', { error, duration, state: this.state });
      
      throw error;
    }
  }

  /**
   * Execute function with timeout protection
   */
  private async executeWithTimeout<R>(fn: () => Promise<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Circuit breaker '${this.options.name}' call timeout`));
      }, this.options.timeout);

      fn()
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Handle successful call
   */
  private onSuccess(duration: number): void {
    this.successes++;
    
    if (this.state === CircuitState.HALF_OPEN) {
      if (this.successes >= this.options.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
        this.resetCounters();
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Reset failure count on successful call
      this.failures = Math.max(0, this.failures - 1);
    }

    this.emit('success', { duration, state: this.state, successCount: this.successes });
  }

  /**
   * Handle failed call
   */
  private onFailure(error: Error, duration: number): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.CLOSED) {
      if (this.failures >= this.options.failureThreshold) {
        this.transitionTo(CircuitState.OPEN);
        this.scheduleReset();
      }
    } else if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open state transitions back to open
      this.transitionTo(CircuitState.OPEN);
      this.scheduleReset();
    }

    this.emit('failure', { error, duration, state: this.state, failureCount: this.failures });
  }

  /**
   * Transition to new state
   */
  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;

    const previousState = this.state;
    this.state = newState;
    this.stateChangedAt = Date.now();

    this.log(`State transition: ${previousState} -> ${newState}`);
    this.emit('state-change', { 
      previousState, 
      newState, 
      timestamp: this.stateChangedAt,
      stats: this.getStats()
    });

    // Reset half-open call counter when leaving half-open state
    if (previousState === CircuitState.HALF_OPEN) {
      this.halfOpenCalls = 0;
    }
  }

  /**
   * Schedule reset from OPEN to HALF_OPEN
   */
  private scheduleReset(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }

    this.resetTimer = setTimeout(() => {
      if (this.state === CircuitState.OPEN) {
        this.transitionTo(CircuitState.HALF_OPEN);
        this.resetCounters();
      }
    }, this.options.resetTimeout);

    this.resetTimer.unref();
  }

  /**
   * Reset counters
   */
  private resetCounters(): void {
    this.failures = 0;
    this.successes = 0;
    this.halfOpenCalls = 0;
    this.lastFailureTime = undefined;
  }

  /**
   * Force circuit to CLOSED state
   */
  reset(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }

    this.transitionTo(CircuitState.CLOSED);
    this.resetCounters();
    
    this.emit('manual-reset', { timestamp: Date.now() });
    this.log('Manual reset performed');
  }

  /**
   * Force circuit to OPEN state
   */
  forceOpen(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }

    this.transitionTo(CircuitState.OPEN);
    
    this.emit('forced-open', { timestamp: Date.now() });
    this.log('Forced to OPEN state');
  }

  /**
   * Get current circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalCalls: this.totalCalls,
      lastFailureTime: this.lastFailureTime,
      stateChangedAt: this.stateChangedAt,
      halfOpenCalls: this.halfOpenCalls
    };
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Check if circuit is allowing calls
   */
  isCallAllowed(): boolean {
    if (this.state === CircuitState.OPEN) {
      return false;
    }
    
    if (this.state === CircuitState.HALF_OPEN) {
      return this.halfOpenCalls < this.options.halfOpenMaxCalls;
    }
    
    return true; // CLOSED state
  }

  /**
   * Get failure rate (0.0 to 1.0)
   */
  getFailureRate(): number {
    if (this.totalCalls === 0) return 0;
    return this.failures / this.totalCalls;
  }

  /**
   * Get success rate (0.0 to 1.0)
   */
  getSuccessRate(): number {
    if (this.totalCalls === 0) return 0;
    return 1 - this.getFailureRate();
  }

  /**
   * Get time since last state change (milliseconds)
   */
  getTimeSinceStateChange(): number {
    return Date.now() - this.stateChangedAt;
  }

  /**
   * Get time until next reset attempt (milliseconds, only for OPEN state)
   */
  getTimeUntilReset(): number {
    if (this.state !== CircuitState.OPEN || !this.lastFailureTime) {
      return 0;
    }
    
    const timeSinceFailure = Date.now() - this.lastFailureTime;
    return Math.max(0, this.options.resetTimeout - timeSinceFailure);
  }

  /**
   * Create a health check result
   */
  getHealthCheck(): {
    healthy: boolean;
    state: CircuitState;
    details: {
      failureRate: number;
      totalCalls: number;
      timeSinceStateChange: number;
      timeUntilReset?: number;
    };
  } {
    return {
      healthy: this.state === CircuitState.CLOSED,
      state: this.state,
      details: {
        failureRate: this.getFailureRate(),
        totalCalls: this.totalCalls,
        timeSinceStateChange: this.getTimeSinceStateChange(),
        ...(this.state === CircuitState.OPEN && { timeUntilReset: this.getTimeUntilReset() })
      }
    };
  }

  /**
   * Update circuit breaker options
   */
  updateOptions(newOptions: Partial<CircuitBreakerOptions>): void {
    Object.assign(this.options, newOptions);
    this.emit('options-updated', { options: this.options });
    this.log('Options updated');
  }

  /**
   * Log message if logging is enabled
   */
  private log(message: string): void {
    if (this.options.enableLogging) {
      console.log(`[CircuitBreaker:${this.options.name}] ${message}`);
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }

    this.removeAllListeners();
    this.emit('destroyed', { name: this.options.name });
    this.log('Circuit breaker destroyed');
  }
}

/**
 * Circuit breaker manager for managing multiple circuit breakers
 */
export class CircuitBreakerManager extends EventEmitter {
  private breakers = new Map<string, CircuitBreaker>();

  /**
   * Create or get circuit breaker
   */
  getBreaker<T = any>(name: string, options?: CircuitBreakerOptions): CircuitBreaker<T> {
    if (!this.breakers.has(name)) {
      const breaker = new CircuitBreaker<T>({ ...options, name });
      
      // Forward events with breaker name
      breaker.on('state-change', (data) => this.emit('breaker-state-change', { name, ...data }));
      breaker.on('call-failure', (data) => this.emit('breaker-call-failure', { name, ...data }));
      breaker.on('call-success', (data) => this.emit('breaker-call-success', { name, ...data }));
      
      this.breakers.set(name, breaker);
      this.emit('breaker-created', { name, options });
    }

    return this.breakers.get(name) as CircuitBreaker<T>;
  }

  /**
   * Remove circuit breaker
   */
  removeBreaker(name: string): boolean {
    const breaker = this.breakers.get(name);
    if (breaker) {
      breaker.destroy();
      this.breakers.delete(name);
      this.emit('breaker-removed', { name });
      return true;
    }
    return false;
  }

  /**
   * Get all breaker names
   */
  getBreakerNames(): string[] {
    return Array.from(this.breakers.keys());
  }

  /**
   * Get all breaker stats
   */
  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers) {
      stats[name] = breaker.getStats();
    }
    return stats;
  }

  /**
   * Get health check for all breakers
   */
  getHealthCheck(): Record<string, ReturnType<CircuitBreaker['getHealthCheck']>> {
    const health: Record<string, ReturnType<CircuitBreaker['getHealthCheck']>> = {};
    for (const [name, breaker] of this.breakers) {
      health[name] = breaker.getHealthCheck();
    }
    return health;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const [name, breaker] of this.breakers) {
      breaker.reset();
    }
    this.emit('all-breakers-reset');
  }

  /**
   * Destroy all circuit breakers
   */
  destroy(): void {
    for (const [name, breaker] of this.breakers) {
      breaker.destroy();
    }
    this.breakers.clear();
    this.removeAllListeners();
    this.emit('manager-destroyed');
  }
}
