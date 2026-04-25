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

/**
 * Thrown when a resource transfer is requested to a node that is not currently
 * in the alive membership set (e.g., it has left or failed).
 */
export class InvalidTransferTargetError extends CoreError {
  constructor(public readonly targetNodeId: string) {
    super(
      'invalid-transfer-target',
      `Cannot transfer to node "${targetNodeId}": not in alive membership`,
    );
  }
}

/**
 * Thrown when an operation (e.g., extend) is attempted on a lock that this
 * node does not currently hold.
 */
export class NotOwnedError extends CoreError {
  constructor(public readonly lockId: string) {
    super('not-owned', `Cannot extend lock "${lockId}": lock is not held`);
  }
}

/**
 * Thrown when an operation targets a session (or channel) that is not owned
 * by the local node. The caller must redirect the request to the owning node.
 */
export class SessionNotLocalError extends CoreError {
  constructor(public readonly sessionId: string) {
    super('session-not-local', `Session "${sessionId}" is not owned by this node`);
  }
}

/**
 * Thrown when a WAL-dependent operation (replay, compact) is called on an
 * EventBus that was not configured with a WAL file path.
 */
export class WalNotConfiguredError extends CoreError {
  constructor(operation: string) {
    super('wal-not-configured', `WAL not configured: cannot ${operation}`);
  }
}

/**
 * Thrown by `ClusterLeaderElection.guard()` (and equivalents) when the leader's
 * fencing token changes during a guarded operation — i.e., a new leader was
 * elected (or the original leader was deposed and re-elected) while the guarded
 * function was still running. The caller must abort any side-effects.
 */
export class StaleLeaderError extends CoreError {
  constructor(
    public readonly groupId: string,
    public readonly heldEpoch: bigint,
    public readonly observedEpoch: bigint | null,
  ) {
    super(
      'stale-leader',
      observedEpoch === null
        ? `Stale leader for group "${groupId}": held epoch ${heldEpoch.toString()} but lock is no longer held`
        : `Stale leader for group "${groupId}": held epoch ${heldEpoch.toString()} but observed epoch ${observedEpoch.toString()}`,
    );
  }
}

/**
 * Thrown by ConnectionRegistry when a reconnect is attempted for a connection
 * currently owned by a remote node rather than the local node.
 */
export class RemoteOwnerError extends CoreError {
  constructor(public readonly connectionId: string, public readonly remoteNodeId: string) {
    super(
      'remote-owner',
      `Cannot reconnect '${connectionId}': owned by remote node '${remoteNodeId}'.`,
    );
  }
}

/**
 * Thrown by ForwardingRouter when the target resource is owned by the local node.
 * Callers should handle the request directly instead of forwarding.
 * Kept for API compatibility; now extends CoreError.
 */
export class LocalResourceError extends CoreError {
  constructor(public readonly resourceId: string) {
    super(
      'local-resource',
      `Resource "${resourceId}" is owned by the local node — caller should handle it directly`,
    );
    this.name = 'LocalResourceError';
  }
}

/**
 * Thrown by ForwardingRouter when no route can be found for the given resource.
 * Kept for API compatibility; now extends CoreError.
 */
export class UnroutableResourceError extends CoreError {
  constructor(public readonly resourceId: string) {
    super('unroutable-resource', `No route found for resource "${resourceId}"`);
    this.name = 'UnroutableResourceError';
  }
}
