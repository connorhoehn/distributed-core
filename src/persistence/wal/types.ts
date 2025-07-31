// Unified WAL types moved from cluster/entity/types.ts

export interface WALEntry {
  logSequenceNumber: number;
  timestamp: number;
  data: EntityUpdate;
  checksum?: string;
}

export interface EntityUpdate {
  entityId: string;
  ownerNodeId?: string;
  version: number;
  timestamp: number;
  operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'TRANSFER';
  metadata?: Record<string, any>;
  previousVersion?: number;
}

export interface WALConfig {
  filePath?: string;
  maxFileSize?: number;
  syncInterval?: number;
  compressionEnabled?: boolean;
  checksumEnabled?: boolean;
}

export interface WALWriter {
  append(update: EntityUpdate): Promise<number>;
  flush(): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface WALReader {
  readFrom(logSequenceNumber: number): AsyncIterableIterator<WALEntry>;
  readAll(): Promise<WALEntry[]>;
  replay(handler: (entry: WALEntry) => Promise<void>): Promise<void>;
  getLastSequenceNumber(): Promise<number>;
  close(): Promise<void>;
}

export interface WALFile {
  append(entry: WALEntry): Promise<void>;
  readEntries(startLSN?: number, endLSN?: number): Promise<WALEntry[]>;
  getLastLSN(): Promise<number>;
  getSize(): Promise<number>;
  truncate(beforeLSN: number): Promise<void>;
  close(): Promise<void>;
}

export interface WALCoordinator {
  createEntry(update: EntityUpdate): WALEntry;
  validateEntry(entry: WALEntry): boolean;
  getCurrentLSN(): number;
}
