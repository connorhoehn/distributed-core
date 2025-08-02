/**
 * Type definitions for the distributed core library
 */

export interface NodeId {
  id: string;
  address: string;
  port: number;
}

export interface NodeInfo {
  id: NodeId;
  metadata: Record<string, any>;
  lastSeen: number;
  status: NodeStatus;
  version: number;
}

export enum NodeStatus {
  ALIVE = 'alive',
  SUSPECTED = 'suspected',
  DEAD = 'dead',
  LEAVING = 'leaving'
}

export interface GossipMessageData {
  type: MessageType;
  payload: any;
  sender: NodeId;
  timestamp: number;
  version: number;
}

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

export interface TransportConfig {
  maxRetries: number;
  timeout: number;
  bufferSize: number;
  encryption?: EncryptionConfig;
}

export interface EncryptionConfig {
  algorithm: string;
  keySize: number;
  enabled: boolean;
}

export interface ClusterConfig {
  bootstrapNodes: NodeId[];
  gossipInterval: number;
  failureTimeout: number;
  maxGossipTargets: number;
}

export interface MetricsData {
  timestamp: number;
  nodeId: string;
  metrics: Record<string, number | string>;
}

export interface PersistenceConfig {
  storePath: string;
  walEnabled: boolean;
  syncInterval: number;
}

export interface Message {
  id: string;
  type: MessageType;
  data: any;
  sender: NodeId;
  timestamp: number;
  headers?: Record<string, string>;
}

export interface GossipData {
  nodes: NodeInfo[];
  version: number;
  timestamp: number;
  checksum?: string;
}

export type EventCallback<T = any> = (data: T) => void;

export interface EventEmitter {
  on(event: string, callback: EventCallback): void;
  off(event: string, callback: EventCallback): void;
  emit(event: string, data?: any): void;
}

// Persistence Layer Interfaces
export interface IStateStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
  snapshot(): Record<string, unknown>;
}

export interface IWriteAheadLog {
  append(entry: any): void;
  readAll(): any[];
  clear(): void;
}

export interface IBroadcastBuffer {
  add(message: any): void;
  drain(): any[];
  size(): number;
}
