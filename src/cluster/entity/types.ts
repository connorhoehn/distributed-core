// Core entity types for distributed entity management
// Import and re-export WAL types from unified persistence layer
import { EntityUpdate } from '../../persistence/wal/types';

export { EntityUpdate };

export interface EntityRecord {
  entityId: string;
  ownerNodeId: string;
  version: number;
  createdAt: number;
  lastUpdated: number;
  metadata?: Record<string, any>;
}

export interface EntitySnapshot {
  timestamp: number;
  version: number;
  entities: Record<string, EntityRecord>;
  nodeId: string;
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
// Note: WAL interfaces moved to src/persistence/wal/types.ts
