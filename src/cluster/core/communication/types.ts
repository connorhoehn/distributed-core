import { GossipMessage, JoinMessage, MembershipEntry } from '../../types';

/**
 * Communication configuration for cluster gossip and join operations
 */
export interface CommunicationConfig {
  gossipInterval: number;
  gossipFanout: number;
  joinTimeout: number;
  antiEntropy: {
    enabled: boolean;
    interval: number;
    forceFullSync: boolean;
  };
  retries: {
    maxAttempts: number;
    backoffMs: number;
    maxBackoffMs: number;
  };
}

/**
 * Gossip target selection strategy configuration
 */
export interface GossipTargetSelection {
  strategy: 'random' | 'preferential' | 'zone-aware' | 'load-balanced';
  maxTargets: number;
  minTargets: number;
}

/**
 * Interface for cluster communication operations
 */
export interface IClusterCommunication {
  joinCluster(): Promise<void>;
  startGossipTimer(): void;
  stopGossipTimer(): void;
  handleGossipMessage(gossipMessage: GossipMessage): void;
  handleJoinMessage(joinMessage: JoinMessage, senderId: string): void;
  sendJoinResponse(targetNodeId: string): Promise<void>;
  runAntiEntropyCycle(): void;
  getConfig(): CommunicationConfig;
  updateConfig(newConfig: Partial<CommunicationConfig>): void;
  updateGossipStrategy(selection: Partial<GossipTargetSelection>): void;
  isGossipTimerRunning(): boolean;
}
