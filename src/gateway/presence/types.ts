export interface PresenceEntry {
  clientId: string;
  nodeId: string;
  metadata: Record<string, any>;
  connectedAt: number;
  lastSeen: number;
}

export interface PresenceConfig {
  syncInterval?: number;        // ms, default 5000
  clientTTL?: number;           // ms, auto-untrack after inactivity, default 300000 (5 min)
  enablePeriodicSync?: boolean; // default true
}

export interface PresenceStats {
  localClients: number;
  remoteClients: number;
  totalClients: number;
  nodeCount: number;
  lastSyncTimestamp: number;
}
