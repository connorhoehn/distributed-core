/**
 * Service interfaces for phase-based node lifecycle
 * 
 * These ports define the boundaries between startup phases and ensure
 * proper separation of concerns across the distributed system layers.
 */

import { Transport } from '../transport/Transport';
import { Message } from '../types';
import { SeedNodeInfo } from '../config/BootstrapConfig';

/**
 * Lifecycle phase interface
 */
export interface Phase {
  readonly name: string;
  run(): Promise<void>;
  stop?(): Promise<void>;
}

/**
 * Network service - manages cluster and client transport lifecycle
 * Phase 2: Network Bind
 */
export interface INetworkService extends Phase {
  bindCluster(): Promise<void>;
  bindClient(): Promise<void>;
  getClusterTransport(): Transport;
  getClientTransport(): Transport;
  onClusterMessage(handler: (message: Message) => void): void;
  onClientMessage(handler: (connectionId: string, message: any) => void): void;
}

/**
 * Communication service - high-level cluster communication facade
 * Phase 3: Gossip & Membership
 */
export interface ICommunicationService extends Phase {
  join(seeds: SeedNodeInfo[], timeoutMs: number): Promise<void>;
  startGossip(): void;
  stopGossip(): void;
  sendCustomMessage(type: string, payload: any, targets?: string[]): Promise<void>;
  onCustomMessage(handler: (type: string, payload: any, sender: string) => void): void;
  handleIncoming(message: Message): void;
}

/**
 * Seed registry interface for managing bootstrap nodes
 */
export interface ISeedRegistry {
  getBootstrapSeeds(): SeedNodeInfo[];
  startHealthMonitoring(): void;
  stopHealthMonitoring(): void;
  markSuccess(id: string): void;
  markFailure(id: string, err?: Error): void;
}

/**
 * State synchronization service - coordinates WAL, delta-sync, anti-entropy
 * Phase 4: State Sync
 */
export interface IStateSyncService extends Phase {
  catchUpFromWAL(): Promise<void>;
  deltaSync(): Promise<void>;
  scheduleAntiEntropy(): void;
  runAntiEntropyCycle(): Promise<void>;
}

/**
 * Client connection service - manages client-facing connections and message routing
 * Phase 6: Client Port
 */
export interface IClientConnectionService extends Phase {
  registerResourceHandlers(): void;
  onResourceMessage(handler: (connectionId: string, resourceId: string, operation: any) => void): void;
}

/**
 * Node lifecycle coordinator - orchestrates all startup phases
 */
export interface INodeLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
  getPhases(): readonly Phase[];
  getCurrentPhase(): Phase | null;
}
