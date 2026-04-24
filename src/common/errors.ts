/**
 * Base class for all errors thrown by distributed-core primitives.
 * Consumers can do: `if (err instanceof CoreError) { ... }` for programmatic handling.
 *
 * The `code` field is a stable string identifier safe for use in conditionals.
 * The `name` always matches the subclass name for stack-trace readability.
 */
export class CoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotStartedError extends CoreError {
  constructor(primitive: string) {
    super('not-started', `${primitive} is not started — call start() first`);
  }
}

export class AlreadyStartedError extends CoreError {
  constructor(primitive: string) {
    super('already-started', `${primitive} is already started`);
  }
}

export class ConflictError extends CoreError {
  constructor(resource: string, detail?: string) {
    super('conflict', detail ? `Conflict on "${resource}": ${detail}` : `Conflict on "${resource}"`);
  }
}

export class TimeoutError extends CoreError {
  constructor(operation: string, ms: number) {
    super('timeout', `${operation} timed out after ${ms}ms`);
  }
}
