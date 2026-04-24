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

  /**
   * Optional per-endpoint health check. Runs on `healthCheckIntervalMs`
   * for every LOCAL endpoint and marks unhealthy endpoints as filtered
   * out of find()/selectOne() until the next successful check.
   * Caller is responsible for TCP probes, HTTP pings, or whatever
   * liveness semantic applies.
   * Default: undefined (no health checks — all endpoints are healthy).
   */
  healthCheck?: (endpoint: ServiceEndpoint) => Promise<boolean>;

  /**
   * How often to run health checks. Default: 30_000 (30s). Only used
   * when `healthCheck` is provided.
   */
  healthCheckIntervalMs?: number;
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

/**
 * Manages service endpoint discovery within a distributed cluster.
 *
 * Events:
 *   'service:registered'         (endpoint: ServiceEndpoint) — new endpoint registered
 *   'service:unregistered'       (endpointId: string, serviceName: string) — endpoint removed
 *   'service:unhealthy'          (endpointId: string, serviceName: string) — endpoint first fails health check
 *   'service:healthy'            (endpointId: string, serviceName: string) — endpoint recovers after failure
 *   'service:healthcheck-error'  (endpointId: string, serviceName: string, error: unknown) — health check threw
 */
export class ServiceRegistry extends EventEmitter implements LifecycleAware {
  private readonly registry: EntityRegistry;
  private readonly localNodeId: string;
  private readonly prefix: string;
  private readonly aliveNodeIds: (() => Set<string>) | undefined;
  private readonly rrIndices: Map<string, number> = new Map();
  private _started = false;

  private readonly healthCheck: ((endpoint: ServiceEndpoint) => Promise<boolean>) | undefined;
  private readonly healthCheckIntervalMs: number;
  private healthCheckTimer: ReturnType<typeof setInterval> | undefined;
  /** endpointIds currently known to be unhealthy */
  private readonly unhealthyEndpoints: Map<string, boolean> = new Map();

  private readonly onEntityCreated: (record: EntityRecord) => void;
  private readonly onEntityDeleted: (record: EntityRecord) => void;

  constructor(registry: EntityRegistry, config: ServiceRegistryConfig) {
    super();
    this.registry = registry;
    this.localNodeId = config.localNodeId;
    this.prefix = config.entityPrefix ?? 'service:';
    this.aliveNodeIds = config.aliveNodeIds;
    this.healthCheck = config.healthCheck;
    this.healthCheckIntervalMs = config.healthCheckIntervalMs ?? 30_000;

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

    if (this.healthCheck !== undefined) {
      const timer = setInterval(() => {
        void this.runHealthChecks();
      }, this.healthCheckIntervalMs);
      timer.unref();
      this.healthCheckTimer = timer;
    }
  }

  async stop(): Promise<void> {
    if (!this._started) return;
    this._started = false;
    this.registry.off('entity:created', this.onEntityCreated);
    this.registry.off('entity:deleted', this.onEntityDeleted);

    if (this.healthCheckTimer !== undefined) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  private async runHealthChecks(): Promise<void> {
    const localEndpoints = this.getLocalEndpoints();
    await Promise.all(
      localEndpoints.map(async (endpoint) => {
        const { endpointId, serviceName } = endpoint;
        let healthy: boolean;
        try {
          healthy = await this.healthCheck!(endpoint);
        } catch (err) {
          this.emit('service:healthcheck-error', endpointId, serviceName, err);
          healthy = false;
        }

        const wasUnhealthy = this.unhealthyEndpoints.has(endpointId);
        if (!healthy) {
          if (!wasUnhealthy) {
            this.unhealthyEndpoints.set(endpointId, true);
            this.emit('service:unhealthy', endpointId, serviceName);
          }
        } else {
          if (wasUnhealthy) {
            this.unhealthyEndpoints.delete(endpointId);
            this.emit('service:healthy', endpointId, serviceName);
          }
        }
      }),
    );
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
      .filter((r) => !this.unhealthyEndpoints.has(r.entityId))
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
