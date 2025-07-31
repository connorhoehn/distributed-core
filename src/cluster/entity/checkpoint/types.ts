export interface CheckpointSnapshot {
  lsn: number; // highest LSN included in the snapshot
  entities: Record<string, EntityState>; // entity registry state
  timestamp: number; // when the snapshot was created
  version: string; // snapshot format version
}

export interface EntityState {
  id: string;
  type: string;
  data: any;
  version: number;
  hostNodeId: string;
  lastModified: number;
}

export interface CheckpointConfig {
  checkpointPath?: string; // Different from WAL filePath
  interval?: number; // checkpoint every N milliseconds (0 = disabled)
  lsnThreshold?: number; // checkpoint every N log entries (0 = disabled)
  keepHistory?: number; // number of old checkpoints to keep
  compressionEnabled?: boolean;
}

export interface CheckpointWriter {
  writeSnapshot(lsn: number, entities: Record<string, EntityState>): Promise<void>;
  cleanup(): Promise<void>;
}

export interface CheckpointReader {
  readLatest(): Promise<CheckpointSnapshot | null>;
  readByLSN(lsn: number): Promise<CheckpointSnapshot | null>;
  listSnapshots(): Promise<number[]>; // returns sorted LSNs
}
