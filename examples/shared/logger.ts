/**
 * Simple console logger with timestamps and labels for example applications.
 */
export class Logger {
  private label: string;

  constructor(label: string) {
    this.label = label;
  }

  info(message: string, ...args: any[]): void {
    console.log(`[${this.timestamp()}] [${this.label}] INFO: ${message}`, ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn(`[${this.timestamp()}] [${this.label}] WARN: ${message}`, ...args);
  }

  error(message: string, ...args: any[]): void {
    console.error(`[${this.timestamp()}] [${this.label}] ERROR: ${message}`, ...args);
  }

  debug(message: string, ...args: any[]): void {
    console.debug(`[${this.timestamp()}] [${this.label}] DEBUG: ${message}`, ...args);
  }

  private timestamp(): string {
    return new Date().toISOString();
  }
}

export function createLogger(label: string): Logger {
  return new Logger(label);
}
