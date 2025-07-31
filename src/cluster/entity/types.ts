// Core entity types for distributed entity management
export interface EntityRecord {
  entityId: string;
  ownerNodeId: string;
  version: number;
  createdAt: number;
  lastUpdated: number;
  metadata?: Record<string, any>;
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

export interface EntitySnapshot {
  timestamp: number;
  version: number;
  entities: Record<string, EntityRecord>;
  nodeId: string;
}

// WAL specific types
export interface WALEntry {
  logSequenceNumber: number;
  timestamp: number;
  checksum: string;
  data: EntityUpdate;
}

export interface WALConfig {
  filePath?: string;
  maxFileSize?: number;
  syncInterval?: number;
  compressionEnabled?: boolean;
  checksumEnabled?: boolean;
}

// Entity Registry interface
export interface EntityRegistry {
  // Core operations
  proposeEntity(entityId: string, metadata?: Record<string, any>): Promise<EntityRecord>;
  getEntityHost(entityId: string): string | null;
  getEntity(entityId: string): EntityRecord | null;
  releaseEntity(entityId: string): Promise<void>;
  updateEntity(entityId: string, metadata: Record<string, any>): Promise<EntityRecord>;
  transferEntity(entityId: string, targetNodeId: string): Promise<EntityRecord>;

  // Local state queries
  getLocalEntities(): EntityRecord[];
  getAllKnownEntities(): EntityRecord[];
  getEntitiesByNode(nodeId: string): EntityRecord[];

  // Synchronization
  applyRemoteUpdate(update: EntityUpdate): Promise<boolean>;
  getUpdatesAfter(version: number): EntityUpdate[];
  
  // Snapshotting
  exportSnapshot(): EntitySnapshot;
  importSnapshot(snapshot: EntitySnapshot): Promise<void>;

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
  
  // Events
  on(event: 'entity:created' | 'entity:updated' | 'entity:deleted' | 'entity:transferred', 
     listener: (record: EntityRecord) => void): void;
  off(event: string, listener?: (...args: any[]) => void): void;
}

// WAL specific interfaces
export interface WALWriter {
  append(update: EntityUpdate): Promise<number>;
  flush(): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface WALReader {
  readFrom(logSequenceNumber: number): AsyncIterableIterator<WALEntry>;
  readAll(): Promise<WALEntry[]>;
  getLastSequenceNumber(): Promise<number>;
  replay(handler: (entry: WALEntry) => Promise<void>): Promise<void>;
}

export interface WALFile {
  append(entry: WALEntry): Promise<void>;
  readEntries(startLSN?: number, endLSN?: number): Promise<WALEntry[]>;
  truncate(beforeLSN: number): Promise<void>;
  getSize(): Promise<number>;
  getLastLSN(): Promise<number>;
  close(): Promise<void>;
}

export interface WALCoordinator {
  getCurrentLSN(): number;
  getNextLSN(): number;
  calculateChecksum(data: any): string;
  validateEntry(entry: WALEntry): boolean;
  createEntry(update: EntityUpdate): WALEntry;
}
