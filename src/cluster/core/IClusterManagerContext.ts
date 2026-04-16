import { BootstrapConfig } from '../../config/BootstrapConfig';
import { KeyManager } from '../../identity/KeyManager';
import { Transport } from '../../transport/Transport';
import { MembershipTable } from '../membership/MembershipTable';
import { FailureDetector } from '../../monitoring/FailureDetector';
import { GossipStrategy } from '../../gossip/GossipStrategy';
import { ConsistentHashRing } from '../../routing/ConsistentHashRing';
import { NodeInfo } from '../types';
import { Message } from '../../types';

/**
 * Interface for the communication subsystem exposed to lifecycle and other modules.
 * Provides gossip, join, and message-handling capabilities without leaking the
 * full ClusterCommunication implementation.
 */
export interface IClusterCommunicationContext {
  /** Join the cluster via configured seed nodes */
  joinCluster(): Promise<void>;
  /** Start the periodic gossip timer */
  startGossipTimer(): void;
  /** Stop the periodic gossip timer */
  stopGossipTimer(): void;
  /** Handle an incoming transport message */
  handleMessage(message: Message): void;
  /** Run an anti-entropy synchronization cycle */
  runAntiEntropyCycle(): void;
}

/**
 * Interface defining the public API that ClusterManager exposes to its modules
 * This allows modular components to access necessary functionality without breaking encapsulation
 */
export interface IClusterManagerContext {
  // Configuration access
  readonly config: BootstrapConfig;

  // Node identity
  readonly localNodeId: string;

  // Core components
  readonly keyManager: KeyManager;
  readonly transport: Transport;
  readonly membership: MembershipTable;
  readonly failureDetector: FailureDetector;
  readonly gossipStrategy: GossipStrategy;
  readonly hashRing: ConsistentHashRing;

  // Communication subsystem
  readonly communication: IClusterCommunicationContext;

  // Recent updates tracking
  recentUpdates: NodeInfo[];

  // Methods for managing state
  getLocalNodeInfo(): NodeInfo;
  addToRecentUpdates(nodeInfo: NodeInfo): void;
  incrementVersion(): void;

  // Utility methods
  isBootstrapped(): boolean;
  getClusterSize(): number;
  rebuildHashRing(): void;

  // Workload migration and rebalancing (stubs emitting events are acceptable)
  migrateWorkloads(nodeId: string): Promise<void>;
}

/**
 * Interface for components that need cluster manager context
 */
export interface IRequiresContext {
  setContext(context: IClusterManagerContext): void;
}
