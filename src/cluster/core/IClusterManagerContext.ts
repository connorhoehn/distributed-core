import { BootstrapConfig } from '../config/BootstrapConfig';
import { KeyManager } from '../../identity/KeyManager';
import { Transport } from '../../transport/Transport';
import { MembershipTable } from '../membership/MembershipTable';
import { FailureDetector } from '../monitoring/FailureDetector';
import { GossipStrategy } from '../gossip/GossipStrategy';
import { ConsistentHashRing } from '../routing/ConsistentHashRing';
import { NodeInfo } from '../types';

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
}

/**
 * Interface for components that need cluster manager context
 */
export interface IRequiresContext {
  setContext(context: IClusterManagerContext): void;
}
