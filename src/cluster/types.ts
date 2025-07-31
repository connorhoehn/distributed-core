export type NodeStatus = 'ALIVE' | 'SUSPECT' | 'DEAD';

export interface NodeInfo {
  id: string;
  status: NodeStatus;
  lastSeen: number;
  version: number;
  metadata?: {
    address?: string;
    port?: number;
    role?: string;
    region?: string;
    zone?: string;
    tags?: Record<string, string>;
  };
}

export interface MembershipEntry extends NodeInfo {
  // Additional local tracking fields
  lastUpdated: number;
  suspectTimeout?: number;
}

export interface JoinMessage {
  type: 'JOIN';
  nodeInfo: NodeInfo;
  isResponse: boolean;
  membershipSnapshot?: NodeInfo[];
}

export interface GossipMessage {
  type: 'GOSSIP';
  nodeInfo?: NodeInfo;
  membershipDiff?: NodeInfo[];
}

export interface LeaveMessage {
  type: 'LEAVE';
  nodeInfo: NodeInfo;
  reason?: string;
}

export type ClusterMessage = JoinMessage | GossipMessage | LeaveMessage;

export interface ClusterEvents {
  'member-joined': [NodeInfo];
  'member-left': [string];
  'member-updated': [NodeInfo];
  'membership-updated': [Map<string, MembershipEntry>];
  'started': [];
  'stopped': [];
  'gossip-received': [GossipMessage];
}

/**
 * Distribution strategy for key routing
 */
export type DistributionStrategy = 
  | { type: 'replicas'; count: number }
  | { type: 'zones'; zones: string[]; count: number }
  | { type: 'primary' }
  | { type: 'all' };

/**
 * Cluster health metrics
 */
export interface ClusterHealth {
  totalNodes: number;
  aliveNodes: number;
  suspectNodes: number;
  deadNodes: number;
  healthRatio: number;
  isHealthy: boolean;
  ringCoverage: number;
  partitionCount: number;
}

/**
 * Cluster topology information
 */
export interface ClusterTopology {
  totalAliveNodes: number;
  rings: { nodeId: string; virtualNodes: number }[];
  zones: Record<string, number>;
  regions: Record<string, number>;
  averageLoadBalance: number;
  replicationFactor: number;
}

/**
 * Cluster metadata summary
 */
export interface ClusterMetadata {
  nodeCount: number;
  clusterId: string;
  version: number;
  roles: string[];
  tags: Record<string, string[]>;
  created: number;
}
