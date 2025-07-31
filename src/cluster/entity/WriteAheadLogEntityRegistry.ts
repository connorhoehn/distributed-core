import { EventEmitter } from 'eventemitter3';
import { 
  EntityRegistry, 
  EntityRecord, 
  EntityUpdate, 
  EntitySnapshot, 
  WALConfig,
  WALWriter,
  WALReader
} from './types';
import { WALWriterImpl } from './WAL/WALWriter';
import { WALReaderImpl } from './WAL/WALReader';

export class WriteAheadLogEntityRegistry extends EventEmitter implements EntityRegistry {
  private entities: Map<string, EntityRecord> = new Map();
  private walWriter: WALWriter;
  private walReader: WALReader;
  private nodeId: string;
  private isRunning: boolean = false;
  private globalVersion: number = 0;

  constructor(nodeId: string, config: WALConfig = {}) {
    super();
    this.nodeId = nodeId;
    this.walWriter = new WALWriterImpl(config);
    this.walReader = new WALReaderImpl(config.filePath || './data/entity.wal');
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    // Initialize WAL components
    await (this.walWriter as WALWriterImpl).initialize();
    await (this.walReader as WALReaderImpl).initialize();

    // Replay WAL to restore state
    await this.replayWAL();

    this.isRunning = true;
    // console.log(`[EntityRegistry] Started for node ${this.nodeId}`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    await this.walWriter.close();
    await (this.walReader as WALReaderImpl).close();
    
    this.isRunning = false;
    // console.log(`[EntityRegistry] Stopped for node ${this.nodeId}`);
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

    const update: EntityUpdate = {
      entityId,
      ownerNodeId: this.nodeId,
      version: 1,
      timestamp: now,
      operation: 'CREATE',
      metadata
    };

    // Write to WAL first
    await this.walWriter.append(update);
    
    // Apply to local state
    await this.applyUpdate(update);

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

    const update: EntityUpdate = {
      entityId,
      version: entity.version + 1,
      timestamp: Date.now(),
      operation: 'DELETE',
      previousVersion: entity.version
    };

    // Write to WAL first
    await this.walWriter.append(update);
    
    // Apply to local state
    await this.applyUpdate(update);

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

    const update: EntityUpdate = {
      entityId,
      ownerNodeId: this.nodeId,
      version: entity.version + 1,
      timestamp: Date.now(),
      operation: 'UPDATE',
      metadata,
      previousVersion: entity.version
    };

    // Write to WAL first
    await this.walWriter.append(update);
    
    // Apply to local state
    await this.applyUpdate(update);

    const updatedEntity = this.entities.get(entityId)!;
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

    const update: EntityUpdate = {
      entityId,
      ownerNodeId: targetNodeId,
      version: entity.version + 1,
      timestamp: Date.now(),
      operation: 'TRANSFER',
      metadata: entity.metadata,
      previousVersion: entity.version
    };

    // Write to WAL first
    await this.walWriter.append(update);
    
    // Apply to local state
    await this.applyUpdate(update);

    const transferredEntity = this.entities.get(entityId)!;
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
      // Write to WAL first for durability
      await this.walWriter.append(update);
      
      // Apply to local state
      await this.applyUpdate(update);
      
      return true;
    } catch (error) {
      console.error(`[EntityRegistry] Failed to apply remote update for ${update.entityId}:`, error);
      return false;
    }
  }

  getUpdatesAfter(version: number): EntityUpdate[] {
    // This would typically be implemented by reading from WAL
    // For now, return empty array as we'd need to store updates separately
    // or read from WAL file directly
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
    
    // console.log(`[EntityRegistry] Imported snapshot with ${Object.keys(snapshot.entities).length} entities`);
  }

  private async replayWAL(): Promise<void> {
    // console.log('[EntityRegistry] Starting WAL replay...');
    
    await this.walReader.replay(async (entry) => {
      await this.applyUpdate(entry.data);
    });
    
    // console.log(`[EntityRegistry] WAL replay completed. Loaded ${this.entities.size} entities`);
  }

  private async applyUpdate(update: EntityUpdate): Promise<void> {
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

      default:
        console.warn(`[EntityRegistry] Unknown operation: ${operation}`);
    }

    // Update global version
    this.globalVersion = Math.max(this.globalVersion, update.version);
  }

  private ensureRunning(): void {
    if (!this.isRunning) {
      throw new Error('EntityRegistry is not running. Call start() first.');
    }
  }

  // Additional utility methods
  async getCurrentLSN(): Promise<number> {
    return (this.walWriter as WALWriterImpl).getCurrentLSN();
  }

  async getWALEntryCount(): Promise<number> {
    return await (this.walReader as WALReaderImpl).getEntryCount();
  }

  async truncateWALBefore(lsn: number): Promise<void> {
    await (this.walWriter as WALWriterImpl).truncateBefore(lsn);
  }
}
