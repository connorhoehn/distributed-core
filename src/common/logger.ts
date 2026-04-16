/**
 * Logging utility for the distributed-core framework
 * Provides configurable logging for different components
 */

export enum LogLevel { DEBUG, INFO, WARN, ERROR, NONE }

/**
 * Structured logger with configurable level and component context.
 * Intended to replace raw console.log/warn/error throughout the codebase.
 */
export class Logger {
  constructor(private context: string, private level: LogLevel = LogLevel.INFO) {}

  debug(msg: string, ...args: any[]) { if (this.level <= LogLevel.DEBUG) console.log(`[DEBUG][${this.context}] ${msg}`, ...args); }
  info(msg: string, ...args: any[]) { if (this.level <= LogLevel.INFO) console.log(`[INFO][${this.context}] ${msg}`, ...args); }
  warn(msg: string, ...args: any[]) { if (this.level <= LogLevel.WARN) console.warn(`[WARN][${this.context}] ${msg}`, ...args); }
  error(msg: string, ...args: any[]) { if (this.level <= LogLevel.ERROR) console.error(`[ERROR][${this.context}] ${msg}`, ...args); }

  static create(context: string, level?: LogLevel): Logger { return new Logger(context, level); }
}

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
