import { EventEmitter } from 'events';
import { EntityRegistry, EntityRecord } from '../cluster/entity/types';
import { EntityUpdate } from '../persistence/wal/types';
import { EvictionTimer } from '../gateway/eviction/EvictionTimer';

export interface ConnectionHandle {
  connectionId: string;
  nodeId: string;
  metadata: Record<string, unknown>;
  registeredAt: number;
  expiresAt?: number;
}

export interface ConnectionRegistryConfig {
  ttlMs?: number;
}

function toHandle(record: EntityRecord, ttlMs?: number): ConnectionHandle {
  return {
    connectionId: record.entityId,
    nodeId: record.ownerNodeId,
    metadata: (record.metadata as Record<string, unknown>) ?? {},
    registeredAt: record.createdAt,
    expiresAt: ttlMs !== undefined ? record.createdAt + ttlMs : undefined,
  };
}

export class ConnectionRegistry extends EventEmitter {
  private readonly registry: EntityRegistry;
  private readonly localNodeId: string;
  private readonly ttlMs: number | undefined;
  private readonly evictionTimer: EvictionTimer<string> | null;
  private readonly onEntityCreated: (record: EntityRecord) => void;
  private readonly onEntityDeleted: (record: EntityRecord) => void;

  constructor(
    registry: EntityRegistry,
    localNodeId: string,
    config?: ConnectionRegistryConfig,
  ) {
    super();
    this.registry = registry;
    this.localNodeId = localNodeId;
    this.ttlMs = config?.ttlMs;
    this.evictionTimer = this.ttlMs !== undefined ? new EvictionTimer<string>(this.ttlMs) : null;

    this.onEntityCreated = (record: EntityRecord) => {
      if (record.ownerNodeId === this.localNodeId) {
        this.emit('connection:registered', toHandle(record, this.ttlMs));
      }
    };

    this.onEntityDeleted = (record: EntityRecord) => {
      this.emit('connection:unregistered', record.entityId);
    };
  }

  async start(): Promise<void> {
    await this.registry.start();
    this.registry.on('entity:created', this.onEntityCreated);
    this.registry.on('entity:deleted', this.onEntityDeleted);
  }

  async stop(): Promise<void> {
    this.evictionTimer?.cancelAll();
    this.registry.off('entity:created', this.onEntityCreated);
    this.registry.off('entity:deleted', this.onEntityDeleted);
    await this.registry.stop();
  }

  async register(connectionId: string, metadata: Record<string, unknown> = {}): Promise<ConnectionHandle> {
    const record = await this.registry.proposeEntity(connectionId, metadata);
    if (this.evictionTimer !== null) {
      this.evictionTimer.schedule(connectionId, async (id) => {
        await this.unregister(id);
        this.emit('connection:expired', id);
      });
    }
    return toHandle(record, this.ttlMs);
  }

  async unregister(connectionId: string): Promise<void> {
    this.evictionTimer?.cancel(connectionId);
    const host = this.registry.getEntityHost(connectionId);
    if (host === null || host !== this.localNodeId) {
      return;
    }
    try {
      await this.registry.releaseEntity(connectionId);
    } catch {
    }
  }

  heartbeat(connectionId: string): void {
    if (this.evictionTimer === null) {
      return;
    }
    if (!this.evictionTimer.isScheduled(connectionId)) {
      return;
    }
    this.evictionTimer.schedule(connectionId, async (id) => {
      await this.unregister(id);
      this.emit('connection:expired', id);
    });
  }

  async applyRemoteUpdate(update: EntityUpdate): Promise<boolean> {
    return this.registry.applyRemoteUpdate(update);
  }

  locate(connectionId: string): string | null {
    return this.registry.getEntityHost(connectionId);
  }

  getLocalConnections(): ConnectionHandle[] {
    return this.registry.getLocalEntities().map((r) => toHandle(r, this.ttlMs));
  }

  getAllConnections(): ConnectionHandle[] {
    return this.registry.getAllKnownEntities().map((r) => toHandle(r, this.ttlMs));
  }

  getStats(): { local: number; total: number; pendingExpiry: number } {
    return {
      local: this.registry.getLocalEntities().length,
      total: this.registry.getAllKnownEntities().length,
      pendingExpiry: this.evictionTimer?.pendingCount ?? 0,
    };
  }
}
