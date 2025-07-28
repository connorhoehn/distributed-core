/**
 * Lightweight spy logger for capturing logs during testing
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  level: LogLevel;
  message: string;
  data?: any;
  timestamp: number;
}

export class SpyLogger {
  private logs: LogEntry[] = [];

  info(message: string, data?: any): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: any): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: any): void {
    this.log('error', message, data);
  }

  debug(message: string, data?: any): void {
    this.log('debug', message, data);
  }

  private log(level: LogLevel, message: string, data?: any): void {
    this.logs.push({
      level,
      message,
      data,
      timestamp: Date.now()
    });
  }

  getLogs(): LogEntry[] {
    return this.logs.slice();
  }

  clear(): void {
    this.logs = [];
  }
}

/**
 * Factory function for creating spy loggers
 */
export function spyLogger(): SpyLogger {
  return new SpyLogger();
}
