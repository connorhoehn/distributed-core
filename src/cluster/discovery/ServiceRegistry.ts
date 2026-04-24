import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { EntityRegistry, EntityRecord } from '../entity/types';
import { LifecycleAware } from '../../common/LifecycleAware';
import { CoreError } from '../../common/errors';

export interface ServiceEndpoint {
  endpointId: string;
  serviceName: string;
  nodeId: string;
  address: string;
  port: number;
  metadata: Record<string, unknown>;
  registeredAt: number;
}

export type SelectionStrategy = 'round-robin' | 'random' | 'first' | 'local-preferred';

export class UnknownServiceError extends CoreError {
  constructor(serviceName: string) {
    super('service-unknown', `No endpoints registered for service "${serviceName}"`);
  }
}

export interface ServiceRegistryConfig {
  localNodeId: string;
  entityPrefix?: string;
  aliveNodeIds?: () => Set<string>;
}

function toEndpoint(record: EntityRecord): ServiceEndpoint {
  const m = record.metadata as {
    serviceName: string;
    address: string;
    port: number;
    userMetadata: Record<string, unknown>;
  };
  return {
    endpointId: record.entityId,
    serviceName: m.serviceName,
    nodeId: record.ownerNodeId,
    address: m.address,
    port: m.port,
    metadata: m.userMetadata ?? {},
    registeredAt: record.createdAt,
  };
}

export class ServiceRegistry extends EventEmitter implements LifecycleAware {
  private readonly registry: EntityRegistry;
  private readonly localNodeId: string;
  private readonly prefix: string;
  private readonly aliveNodeIds: (() => Set<string>) | undefined;
  private readonly rrIndices: Map<string, number> = new Map();
  private _started = false;

  private readonly onEntityCreated: (record: EntityRecord) => void;
  private readonly onEntityDeleted: (record: EntityRecord) => void;

  constructor(registry: EntityRegistry, config: ServiceRegistryConfig) {
    super();
    this.registry = registry;
    this.localNodeId = config.localNodeId;
    this.prefix = config.entityPrefix ?? 'service:';
    this.aliveNodeIds = config.aliveNodeIds;

    this.onEntityCreated = (record: EntityRecord) => {
      if (!record.entityId.startsWith(this.prefix)) return;
      this.emit('service:registered', toEndpoint(record));
    };

    this.onEntityDeleted = (record: EntityRecord) => {
      if (!record.entityId.startsWith(this.prefix)) return;
      const m = record.metadata as { serviceName: string } | undefined;
      this.emit('service:unregistered', record.entityId, m?.serviceName ?? '');
    };
  }

  isStarted(): boolean {
    return this._started;
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this.registry.on('entity:created', this.onEntityCreated);
    this.registry.on('entity:deleted', this.onEntityDeleted);
  }

  async stop(): Promise<void> {
    if (!this._started) return;
    this._started = false;
    this.registry.off('entity:created', this.onEntityCreated);
    this.registry.off('entity:deleted', this.onEntityDeleted);
  }

  async register(
    serviceName: string,
    address: string,
    port: number,
    metadata: Record<string, unknown> = {},
  ): Promise<ServiceEndpoint> {
    const endpointId = `${this.prefix}${this.localNodeId}-${serviceName}-${randomUUID()}`;
    const record = await this.registry.proposeEntity(endpointId, {
      serviceName,
      address,
      port,
      userMetadata: metadata,
    });
    return toEndpoint(record);
  }

  async unregister(endpointId: string): Promise<boolean> {
    const host = this.registry.getEntityHost(endpointId);
    if (host === null || host !== this.localNodeId) return false;
    try {
      await this.registry.releaseEntity(endpointId);
      return true;
    } catch {
      return false;
    }
  }

  async unregisterAll(serviceName?: string): Promise<number> {
    const local = this.registry.getLocalEntities().filter((r) => {
      if (!r.entityId.startsWith(this.prefix)) return false;
      if (serviceName === undefined) return true;
      const m = r.metadata as { serviceName: string } | undefined;
      return m?.serviceName === serviceName;
    });
    let count = 0;
    for (const record of local) {
      const removed = await this.unregister(record.entityId);
      if (removed) count++;
    }
    return count;
  }

  find(serviceName: string, options?: { includeDead?: boolean }): ServiceEndpoint[] {
    const alive = this.aliveNodeIds?.();
    return this.registry
      .getAllKnownEntities()
      .filter((r) => {
        if (!r.entityId.startsWith(this.prefix)) return false;
        const m = r.metadata as { serviceName: string } | undefined;
        return m?.serviceName === serviceName;
      })
      .filter((r) => {
        if (options?.includeDead) return true;
        if (alive === undefined) return true;
        return alive.has(r.ownerNodeId);
      })
      .map(toEndpoint);
  }

  selectOne(serviceName: string, strategy: SelectionStrategy = 'round-robin'): ServiceEndpoint {
    const endpoints = this.find(serviceName);
    if (endpoints.length === 0) throw new UnknownServiceError(serviceName);

    switch (strategy) {
      case 'random':
        return endpoints[Math.floor(Math.random() * endpoints.length)];

      case 'first':
        return endpoints[0];

      case 'local-preferred': {
        const local = endpoints.filter((e) => e.nodeId === this.localNodeId);
        if (local.length > 0) return local[0];
        const idx = (this.rrIndices.get(serviceName) ?? 0) % endpoints.length;
        this.rrIndices.set(serviceName, idx + 1);
        return endpoints[idx];
      }

      case 'round-robin':
      default: {
        const idx = (this.rrIndices.get(serviceName) ?? 0) % endpoints.length;
        this.rrIndices.set(serviceName, idx + 1);
        return endpoints[idx];
      }
    }
  }

  listServices(): string[] {
    const names = new Set<string>();
    for (const r of this.registry.getAllKnownEntities()) {
      if (!r.entityId.startsWith(this.prefix)) continue;
      const m = r.metadata as { serviceName: string } | undefined;
      if (m?.serviceName) names.add(m.serviceName);
    }
    return Array.from(names);
  }

  getLocalEndpoints(): ServiceEndpoint[] {
    return this.registry
      .getLocalEntities()
      .filter((r) => r.entityId.startsWith(this.prefix))
      .map(toEndpoint);
  }

  getStats(): { services: number; endpoints: number; localEndpoints: number } {
    return {
      services: this.listServices().length,
      endpoints: this.registry.getAllKnownEntities().filter((r) => r.entityId.startsWith(this.prefix)).length,
      localEndpoints: this.getLocalEndpoints().length,
    };
  }
}
