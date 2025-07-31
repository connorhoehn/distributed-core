import { EventEmitter } from 'eventemitter3';
import { 
  EntityRegistry, 
  EntityRecord, 
  EntityUpdate, 
  EntitySnapshot 
} from './types';
import { FrameworkLogger } from '../../common/logger';

export class InMemoryEntityRegistry extends EventEmitter implements EntityRegistry {
  private entities: Map<string, EntityRecord> = new Map();
  private nodeId: string;
  private isRunning: boolean = false;
  private globalVersion: number = 0;
  private logger: FrameworkLogger;

  constructor(nodeId: string, logConfig?: { enableTestMode?: boolean }) {
    super();
    this.nodeId = nodeId;
    this.logger = new FrameworkLogger({ 
      enableFrameworkLogs: true,
      enableTestMode: logConfig?.enableTestMode // Let it auto-detect if not specified
    });
  }

  async start(): Promise<void> {
    this.isRunning = true;
    this.logger.framework(`[InMemoryEntityRegistry] Started for node ${this.nodeId}`);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.logger.framework(`[InMemoryEntityRegistry] Stopped for node ${this.nodeId}`);
  }

  async proposeEntity(entityId: string, metadata?: Record<string, any>): Promise<EntityRecord> {
    this.ensureRunning();

    if (this.entities.has(entityId)) {
      throw new Error(`Entity ${entityId} already exists`);
    }

    const now = Date.now();
    const record: EntityRecord = {
      entityId,
      ownerNodeId: this.nodeId,
      version: 1,
      createdAt: now,
      lastUpdated: now,
      metadata: metadata || {}
    };

    this.entities.set(entityId, record);
    this.globalVersion++;

    this.emit('entity:created', record);
    return record;
  }

  getEntityHost(entityId: string): string | null {
    const entity = this.entities.get(entityId);
    return entity ? entity.ownerNodeId : null;
  }

  getEntity(entityId: string): EntityRecord | null {
    return this.entities.get(entityId) || null;
  }

  async releaseEntity(entityId: string): Promise<void> {
    this.ensureRunning();

    const entity = this.entities.get(entityId);
    if (!entity) {
      throw new Error(`Entity ${entityId} not found`);
    }

    if (entity.ownerNodeId !== this.nodeId) {
      throw new Error(`Cannot release entity ${entityId} - not owned by this node`);
    }

    this.entities.delete(entityId);
    this.globalVersion++;

    this.emit('entity:deleted', entity);
  }

  async updateEntity(entityId: string, metadata: Record<string, any>): Promise<EntityRecord> {
    this.ensureRunning();

    const entity = this.entities.get(entityId);
    if (!entity) {
      throw new Error(`Entity ${entityId} not found`);
    }

    if (entity.ownerNodeId !== this.nodeId) {
      throw new Error(`Cannot update entity ${entityId} - not owned by this node`);
    }

    const updatedEntity: EntityRecord = {
      ...entity,
      version: entity.version + 1,
      lastUpdated: Date.now(),
      metadata: { ...entity.metadata, ...metadata }
    };

    this.entities.set(entityId, updatedEntity);
    this.globalVersion++;

    this.emit('entity:updated', updatedEntity);
    return updatedEntity;
  }

  async transferEntity(entityId: string, targetNodeId: string): Promise<EntityRecord> {
    this.ensureRunning();

    const entity = this.entities.get(entityId);
    if (!entity) {
      throw new Error(`Entity ${entityId} not found`);
    }

    if (entity.ownerNodeId !== this.nodeId) {
      throw new Error(`Cannot transfer entity ${entityId} - not owned by this node`);
    }

    const transferredEntity: EntityRecord = {
      ...entity,
      ownerNodeId: targetNodeId,
      version: entity.version + 1,
      lastUpdated: Date.now()
    };

    this.entities.set(entityId, transferredEntity);
    this.globalVersion++;

    this.emit('entity:transferred', transferredEntity);
    return transferredEntity;
  }

  getLocalEntities(): EntityRecord[] {
    return Array.from(this.entities.values())
      .filter(entity => entity.ownerNodeId === this.nodeId);
  }

  getAllKnownEntities(): EntityRecord[] {
    return Array.from(this.entities.values());
  }

  getEntitiesByNode(nodeId: string): EntityRecord[] {
    return Array.from(this.entities.values())
      .filter(entity => entity.ownerNodeId === nodeId);
  }

  async applyRemoteUpdate(update: EntityUpdate): Promise<boolean> {
    try {
      const { entityId, operation } = update;

      switch (operation) {
        case 'CREATE':
          if (!this.entities.has(entityId)) {
            const record: EntityRecord = {
              entityId: update.entityId,
              ownerNodeId: update.ownerNodeId!,
              version: update.version,
              createdAt: update.timestamp,
              lastUpdated: update.timestamp,
              metadata: update.metadata || {}
            };
            this.entities.set(entityId, record);
          }
          break;

        case 'UPDATE':
          const existing = this.entities.get(entityId);
          if (existing && update.version > existing.version) {
            const updated: EntityRecord = {
              ...existing,
              version: update.version,
              lastUpdated: update.timestamp,
              metadata: { ...existing.metadata, ...update.metadata }
            };
            this.entities.set(entityId, updated);
          }
          break;

        case 'DELETE':
          this.entities.delete(entityId);
          break;

        case 'TRANSFER':
          const entity = this.entities.get(entityId);
          if (entity && update.version > entity.version) {
            const transferred: EntityRecord = {
              ...entity,
              ownerNodeId: update.ownerNodeId!,
              version: update.version,
              lastUpdated: update.timestamp
            };
            this.entities.set(entityId, transferred);
          }
          break;
      }

      this.globalVersion = Math.max(this.globalVersion, update.version);
      return true;
    } catch (error) {
      console.error(`[InMemoryEntityRegistry] Failed to apply remote update for ${update.entityId}:`, error);
      return false;
    }
  }

  getUpdatesAfter(version: number): EntityUpdate[] {
    // In-memory implementation doesn't persist update history
    return [];
  }

  exportSnapshot(): EntitySnapshot {
    return {
      timestamp: Date.now(),
      version: this.globalVersion,
      entities: Object.fromEntries(this.entities),
      nodeId: this.nodeId
    };
  }

  async importSnapshot(snapshot: EntitySnapshot): Promise<void> {
    this.ensureRunning();

    // Clear current state
    this.entities.clear();
    
    // Import entities from snapshot
    for (const [entityId, record] of Object.entries(snapshot.entities)) {
      this.entities.set(entityId, record);
    }
    
    this.globalVersion = snapshot.version;
    
    // console.log(`[InMemoryEntityRegistry] Imported snapshot with ${Object.keys(snapshot.entities).length} entities`);
  }

  private ensureRunning(): void {
    if (!this.isRunning) {
      throw new Error('EntityRegistry is not running. Call start() first.');
    }
  }
}
