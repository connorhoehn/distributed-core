/**
 * Logging utility for the distributed-core framework
 * Provides configurable logging for different components
 */

export interface LoggingConfig {
  enableFrameworkLogs?: boolean;
  enableCoordinatorLogs?: boolean;
  enableClusterLogs?: boolean;
  enableTestMode?: boolean;
}

export class FrameworkLogger {
  constructor(private config: LoggingConfig = {}) {
    // Auto-detect test mode if not explicitly set
    if (this.config.enableTestMode === undefined) {
      this.config.enableTestMode = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
    }
  }

  /**
   * Log framework-level messages
   */
  framework(message: string, ...args: any[]): void {
    if (this.config.enableFrameworkLogs && !this.config.enableTestMode) {
      console.log(`[FRAMEWORK] ${message}`, ...args);
    }
  }

  /**
   * Log coordinator-specific messages
   */
  coordinator(message: string, ...args: any[]): void {
    if (this.config.enableCoordinatorLogs && !this.config.enableTestMode) {
      console.log(`[COORDINATOR] ${message}`, ...args);
    }
  }

  /**
   * Log cluster-related messages
   */
  cluster(message: string, ...args: any[]): void {
    if (this.config.enableClusterLogs && !this.config.enableTestMode) {
      console.log(`[CLUSTER] ${message}`, ...args);
    }
  }

  /**
   * Log error messages (always shown unless in test mode)
   */
  error(message: string, ...args: any[]): void {
    if (!this.config.enableTestMode) {
      console.error(`[ERROR] ${message}`, ...args);
    }
  }

  /**
   * Log warning messages (always shown unless in test mode)
   */
  warn(message: string, ...args: any[]): void {
    if (!this.config.enableTestMode) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  }

  /**
   * Log debug messages (only in development)
   */
  debug(message: string, ...args: any[]): void {
    if (process.env.NODE_ENV === 'development' && !this.config.enableTestMode) {
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  }
}

/**
 * Create a logger instance with the given configuration
 */
export function createLogger(config: LoggingConfig = {}): FrameworkLogger {
  return new FrameworkLogger(config);
}

/**
 * Default logger instance for simple usage
 */
export const defaultLogger = new FrameworkLogger({
  enableFrameworkLogs: true,
  enableCoordinatorLogs: true,
  enableClusterLogs: true,
  enableTestMode: false
});
