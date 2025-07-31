import { EventEmitter } from 'eventemitter3';
import { 
  EntityRegistry, 
  EntityRecord, 
  EntitySnapshot
} from './types';
import { EntityUpdate, WALConfig, WALWriter, WALReader } from '../../persistence/wal/types';
import { WALWriterImpl } from '../../persistence/wal/WALWriter';
import { WALReaderImpl } from '../../persistence/wal/WALReader';
import { CheckpointWriterImpl } from '../../persistence/checkpoint/CheckpointWriter';
import { CheckpointReaderImpl } from '../../persistence/checkpoint/CheckpointReader';
import { CheckpointConfig, EntityState } from '../../persistence/checkpoint/types';

export class WriteAheadLogEntityRegistry extends EventEmitter implements EntityRegistry {
  private entities: Map<string, EntityRecord> = new Map();
  private walWriter: WALWriter;
  private walReader: WALReader;
  private checkpointWriter: CheckpointWriterImpl;
  private checkpointReader: CheckpointReaderImpl;
  private nodeId: string;
  private isRunning: boolean = false;
  private globalVersion: number = 0;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private lastCheckpointLSN: number = 0;
  private config: WALConfig & CheckpointConfig;

  constructor(nodeId: string, config: WALConfig & CheckpointConfig = {}) {
    super();
    this.nodeId = nodeId;
    this.config = {
      // WAL defaults
      filePath: config.filePath || './data/entity.wal',
      maxFileSize: config.maxFileSize || 100 * 1024 * 1024,
      syncInterval: config.syncInterval !== undefined ? config.syncInterval : 1000,
      compressionEnabled: config.compressionEnabled || false,
      checksumEnabled: config.checksumEnabled || true,
      // Checkpoint defaults
      checkpointPath: config.checkpointPath || './data/checkpoints',
      interval: config.interval !== undefined ? config.interval : 60000, // 1 minute
      lsnThreshold: config.lsnThreshold !== undefined ? config.lsnThreshold : 1000,
      keepHistory: config.keepHistory || 5,
      ...config
    };
    
    this.walWriter = new WALWriterImpl(this.config);
    this.walReader = new WALReaderImpl(this.config.filePath!);
    this.checkpointWriter = new CheckpointWriterImpl(this.config);
    this.checkpointReader = new CheckpointReaderImpl(this.config);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    // Initialize WAL components
    await (this.walWriter as WALWriterImpl).initialize();
    await (this.walReader as WALReaderImpl).initialize();

    // Try to restore from checkpoint first
    await this.restoreFromCheckpoint();

    // Replay WAL entries after checkpoint
    await this.replayWAL();

    // Setup periodic checkpointing
    this.setupCheckpointTimer();

    this.isRunning = true;
    // console.log(`[EntityRegistry] Started for node ${this.nodeId}`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    // Stop checkpoint timer
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }

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

    // Check if we need to create a checkpoint
    await this.checkNeedsCheckpoint();

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

    // Check if we need to create a checkpoint
    await this.checkNeedsCheckpoint();

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

    // Check if we need to create a checkpoint
    await this.checkNeedsCheckpoint();

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

    // Check if we need to create a checkpoint
    await this.checkNeedsCheckpoint();

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
    
    // Start replay from after the last checkpoint
    const startLSN = this.lastCheckpointLSN + 1;
    
    await this.walReader.replay(async (entry) => {
      // Only replay entries after the checkpoint
      if (entry.logSequenceNumber >= startLSN) {
        await this.applyUpdate(entry.data);
      }
    });
    
    // console.log(`[EntityRegistry] WAL replay completed from LSN ${startLSN}. Loaded ${this.entities.size} entities`);
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

  // Checkpoint-related methods
  private async restoreFromCheckpoint(): Promise<void> {
    const snapshot = await this.checkpointReader.readLatest();
    if (snapshot) {
      // Restore entities from snapshot
      this.entities.clear();
      for (const [entityId, entityState] of Object.entries(snapshot.entities)) {
        const record: EntityRecord = {
          entityId: entityState.id,
          ownerNodeId: entityState.hostNodeId,
          version: entityState.version,
          createdAt: entityState.lastModified,
          lastUpdated: entityState.lastModified,
          metadata: entityState.data || {}
        };
        this.entities.set(entityId, record);
      }
      
      this.lastCheckpointLSN = snapshot.lsn;
      this.globalVersion = Math.max(...Object.values(snapshot.entities).map(e => e.version), 0);
      
      // console.log(`[EntityRegistry] Restored from checkpoint at LSN ${snapshot.lsn}, ${this.entities.size} entities`);
    }
  }

  private setupCheckpointTimer(): void {
    if (this.config.interval && this.config.interval > 0) {
      this.checkpointTimer = setInterval(async () => {
        try {
          await this.createCheckpoint();
        } catch (error) {
          console.error('[EntityRegistry] Checkpoint failed:', error);
        }
      }, this.config.interval);
      
      // Prevent timer from keeping process alive
      this.checkpointTimer.unref();
    }
  }

  async createCheckpoint(): Promise<void> {
    const currentLSN = await this.getCurrentLSN();
    
    // Check if we should create a checkpoint based on LSN threshold
    if (this.config.lsnThreshold && this.config.lsnThreshold > 0) {
      const lsnDiff = currentLSN - this.lastCheckpointLSN;
      if (lsnDiff < this.config.lsnThreshold) {
        return; // Not enough new entries
      }
    }

    // Convert entities to checkpoint format
    const entities: Record<string, EntityState> = {};
    for (const [entityId, record] of this.entities) {
      entities[entityId] = {
        id: record.entityId,
        type: 'entity', // Could be extended for different entity types
        data: record.metadata,
        version: record.version,
        hostNodeId: record.ownerNodeId,
        lastModified: record.lastUpdated
      };
    }

    await this.checkpointWriter.writeSnapshot(currentLSN, entities);
    this.lastCheckpointLSN = currentLSN;
    
    this.emit('checkpoint:created', { lsn: currentLSN, entityCount: this.entities.size });
    
    // Optionally truncate WAL after successful checkpoint
    // await this.truncateWALBefore(currentLSN);
  }

  async forceCheckpoint(): Promise<void> {
    await this.createCheckpoint();
  }

  // Check if we need to create checkpoint after each write
  private async checkNeedsCheckpoint(): Promise<void> {
    if (this.config.lsnThreshold && this.config.lsnThreshold > 0) {
      const currentLSN = await this.getCurrentLSN();
      if (currentLSN % this.config.lsnThreshold === 0) {
        await this.createCheckpoint();
      }
    }
  }
}
