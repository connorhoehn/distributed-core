export interface ChannelConfig {
  maxMembers?: number;         // default 10000
  metadata?: Record<string, any>;
  persistent?: boolean;        // survives if all members leave, default false
}

export interface ChannelInfo {
  id: string;
  ownerNodeId: string;
  members: Set<string>;        // clientIds
  config: ChannelConfig;
  createdAt: number;
  lastActivity: number;
}

export interface ChannelManagerConfig {
  enableAutoCleanup?: boolean;    // default true
  cleanupInterval?: number;       // ms, default 60000
  defaultMaxMembers?: number;     // default 10000
}

export interface ChannelStats {
  totalChannels: number;
  ownedChannels: number;
  totalMembers: number;
  averageMembersPerChannel: number;
}
