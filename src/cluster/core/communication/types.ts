import { MembershipEntry, NodeInfo } from '../../types';

/**
 * Communication and gossip management interface
 */
export interface IClusterCommunication {
  /**
   * Join the cluster via seed nodes
   */
  joinCluster(): Promise<void>;

  /**
   * Start the periodic gossip timer
   */
  startGossipTimer(): void;

  /**
   * Stop the gossip timer
   */
  stopGossipTimer(): void;

  /**
   * Handle incoming gossip messages
   * @param gossipMessage - The gossip message to process
   */
  handleGossipMessage(gossipMessage: any): void;

  /**
   * Handle incoming join messages
   * @param joinMessage - The join message to process
   * @param senderId - ID of the sending node
   */
  handleJoinMessage(joinMessage: any, senderId: string): void;

  /**
   * Send join response to a requesting node
   * @param targetNodeId - ID of the node to send response to
   */
  sendJoinResponse(targetNodeId: string): Promise<void>;

  /**
   * Trigger anti-entropy synchronization cycle
   */
  runAntiEntropyCycle(): void;
}

/**
 * Configuration for communication and gossip
 */
export interface CommunicationConfig {
  /**
   * Gossip interval in milliseconds
   */
  gossipInterval: number;

  /**
   * Number of nodes to gossip with in each round
   */
  gossipFanout: number;

  /**
   * Join timeout in milliseconds
   */
  joinTimeout: number;

  /**
   * Anti-entropy cycle configuration
   */
  antiEntropy: {
    enabled: boolean;
    interval: number;
    forceFullSync: boolean;
  };

  /**
   * Message retry configuration
   */
  retries: {
    maxAttempts: number;
    backoffMs: number;
    maxBackoffMs: number;
  };
}

/**
 * Communication event types
 */
export interface CommunicationEvents {
  'gossip-sent': [{ targetNodes: string[]; messageCount: number }];
  'gossip-received': [{ senderId: string; updates: NodeInfo[] }];
  'join-requested': [{ nodeId: string; isResponse: boolean }];
  'join-completed': [{ nodeId: string; membershipSize: number }];
  'anti-entropy-triggered': [{ timestamp: number; memberCount: number }];
  'communication-error': [{ error: Error; operation: string; targetNode?: string }];
}

/**
 * Gossip target selection strategy
 */
export interface GossipTargetSelection {
  /**
   * Strategy for selecting gossip targets
   */
  strategy: 'random' | 'preferential' | 'zone-aware' | 'load-balanced';

  /**
   * Maximum number of targets per gossip round
   */
  maxTargets: number;

  /**
   * Minimum number of targets (fallback)
   */
  minTargets: number;

  /**
   * Zone preference settings (for zone-aware strategy)
   */
  zonePreference?: {
    preferLocal: boolean;
    crossZoneRatio: number;
  };
}
