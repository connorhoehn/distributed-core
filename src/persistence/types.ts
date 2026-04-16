export interface WALEntry {
  logSequenceNumber: number;
  timestamp: number;
  checksum: string;
  data: EntityUpdate;
}

export interface WALFile {
  path?: string;
  size?: number;
  entries?: number;
  append(entry: WALEntry): Promise<void>;
  readEntries(startLSN?: number, endLSN?: number): Promise<WALEntry[]>;
  getSize(): Promise<number>;
  getLastLSN(): Promise<number>;
  truncate(beforeLSN: number): Promise<void>;
  close(): Promise<void>;
}

export interface WALReader {
  read?(): Promise<WALEntry[]>;
  readAll(): Promise<WALEntry[]>;
  readFrom(logSequenceNumber: number): AsyncIterableIterator<WALEntry>;
  readRange(startLSN: number, endLSN: number): Promise<WALEntry[]>;
  replay(handler: (entry: WALEntry) => Promise<void>): Promise<void>;
  getLastSequenceNumber(): Promise<number>;
  getEntryCount(): Promise<number>;
  close(): Promise<void>;
}

export interface WALWriter {
  write?(entry: WALEntry): Promise<void>;
  append(update: EntityUpdate): Promise<number>;
  flush(): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
  truncateBefore(lsn: number): Promise<void>;
  getCurrentLSN(): number;
}

export interface WALCoordinator {
  start(): Promise<void>;
  stop(): Promise<void>;
  getCurrentLSN(): number;
  getNextLSN(): number;
  calculateChecksum(data: any): string;
  validateEntry(entry: WALEntry): boolean;
  createEntry(update: EntityUpdate): WALEntry;
  resetLSN(lsn: number): void;
}

export interface EntityUpdate {
  entityId: string;
  changes?: any;
  timestamp: number;
  version: number;
  operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'TRANSFER' | string;
  ownerNodeId?: string;
  metadata?: Record<string, any>;
  previousVersion?: number;
}

export interface WALConfig {
  filePath?: string;
  maxFileSize?: number;
  retentionDays?: number;
  syncInterval?: number;
  compressionEnabled?: boolean;
  checksumEnabled?: boolean;
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
  lsn?: number;
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
  hostNodeId?: string;
  createdAt?: number;
  lastModified?: number;
  metadata?: Record<string, any>;
}

export interface CompactionStrategy {
  compact(): Promise<CompactionResult>;
}

export interface CompactionResult {
  success: boolean;
  segmentsProcessed: number;
}

export type CompactionStrategyType = 'leveled' | 'size-tiered' | 'time-based' | 'vacuum-based';
