/**
 * Core type definitions for the distributed-core library.
 *
 * This file contains only COMMON / cross-cutting types that are not owned
 * by any single module.  Domain-specific types live in their own modules:
 *   - Cluster types        -> src/cluster/types.ts
 *   - Coordinator types    -> src/coordinators/types.ts
 *   - Messaging types      -> src/messaging/types.ts
 *   - Persistence types    -> src/persistence/types.ts
 *   - Connection types     -> src/connections/types.ts
 *   - Resource types       -> src/resources/types.ts
 */

// ---------------------------------------------------------------------------
// Node identity
// ---------------------------------------------------------------------------

export interface NodeId {
  id: string;
  address: string;
  port: number;
}

// ---------------------------------------------------------------------------
// Message primitives
// ---------------------------------------------------------------------------

export enum MessageType {
  PING = 'ping',
  PONG = 'pong',
  JOIN = 'join',
  GOSSIP = 'gossip',
  MEMBERSHIP_UPDATE = 'membership_update',
  STATE_SYNC = 'state_sync',
  FAILURE_DETECTION = 'failure_detection',
  CLUSTER_STATE_REQUEST = 'cluster_state_request',
  CLUSTER_STATE_RESPONSE = 'cluster_state_response',
  CUSTOM = 'custom'
}

export interface Message {
  id: string;
  type: MessageType;
  // TODO: Replace `any` with a proper generic or discriminated union once
  // all consumers use typed access patterns instead of raw property access.
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  sender: NodeId;
  timestamp: number;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Transport configuration
// ---------------------------------------------------------------------------

export interface EncryptionConfig {
  algorithm: string;
  keySize: number;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Persistence layer interfaces
// ---------------------------------------------------------------------------

export interface IStateStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
  snapshot(): Record<string, unknown>;
}

export interface IWriteAheadLog {
  append(entry: unknown): void;
  readAll(): unknown[];
  clear(): void;
}

export interface IBroadcastBuffer {
  add(message: unknown): void;
  drain(): unknown[];
  size(): number;
}
