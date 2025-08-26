export interface WALEntry {
  logSequenceNumber: number;
  timestamp: number;
  checksum: string;
  data: EntityUpdate;
}

export interface WALFile {
  path: string;
  size: number;
  entries: number;
}

export interface WALReader {
  read(): Promise<WALEntry[]>;
}

export interface WALWriter {
  write(entry: WALEntry): Promise<void>;
}

export interface WALCoordinator {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface EntityUpdate {
  entityId: string;
  changes: any;
  timestamp: number;
}

export interface WALConfig {
  maxFileSize?: number;
  retentionDays?: number;
}

export interface CheckpointReader {
  read(): Promise<CheckpointSnapshot>;
}

export interface CheckpointWriter {
  write(data: CheckpointSnapshot): Promise<void>;
}

export interface CheckpointSnapshot {
  entities: Record<string, EntityState>;
  timestamp: number;
  version: string;
}

export interface CheckpointConfig {
  interval?: number;
  retention?: number;
  checkpointPath?: string;
  lsnThreshold?: number;
  keepHistory?: number;
  compressionEnabled?: boolean;
}

export interface EntityState {
  id: string;
  state: any;
  version: number;
}

export interface CompactionStrategy {
  compact(): Promise<CompactionResult>;
}

export interface CompactionResult {
  success: boolean;
  segmentsProcessed: number;
}

export type CompactionStrategyType = 'leveled' | 'size-tiered' | 'time-based' | 'vacuum';