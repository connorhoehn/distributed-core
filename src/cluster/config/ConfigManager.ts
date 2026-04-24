import { EventEmitter } from 'events';
import { EntityRegistry, EntityRecord } from '../entity/types';
import { LifecycleAware } from '../../common/LifecycleAware';
import { CoreError } from '../../common/errors';

export type ConfigValidator<T> = (value: unknown) => value is T;

export interface ConfigKeyDefinition<T> {
  key: string;
  defaultValue: T;
  validator: ConfigValidator<T>;
  description?: string;
}

export interface ConfigChangeEvent<T = unknown> {
  key: string;
  oldValue: T | undefined;
  newValue: T;
  sourceNodeId: string;
  timestamp: number;
}

export class ConfigValidationError extends CoreError {
  constructor(key: string, reason: string) {
    super('config-validation', `Invalid value for config key "${key}": ${reason}`);
  }
}

export class UnknownConfigKeyError extends CoreError {
  constructor(key: string) {
    super('config-unknown-key', `Config key "${key}" is not registered`);
  }
}

export interface ConfigManagerConfig {
  localNodeId: string;
  entityPrefix?: string;
}

const DEFAULT_PREFIX = 'config:';

export class ConfigManager extends EventEmitter implements LifecycleAware {
  private readonly registry: EntityRegistry;
  private readonly localNodeId: string;
  private readonly prefix: string;

  private readonly definitions = new Map<string, ConfigKeyDefinition<unknown>>();
  private readonly keyWatchers = new Map<string, Set<(event: ConfigChangeEvent<unknown>) => void>>();
  private readonly allWatchers = new Set<(event: ConfigChangeEvent) => void>();

  private _started = false;

  private readonly _onCreated: (record: EntityRecord) => void;
  private readonly _onUpdated: (record: EntityRecord) => void;
  private readonly _onDeleted: (record: EntityRecord) => void;

  constructor(registry: EntityRegistry, config: ConfigManagerConfig) {
    super();
    this.registry = registry;
    this.localNodeId = config.localNodeId;
    this.prefix = config.entityPrefix ?? DEFAULT_PREFIX;

    this._onCreated = (record: EntityRecord) => this._handleEntityChange(record, 'created');
    this._onUpdated = (record: EntityRecord) => this._handleEntityChange(record, 'updated');
    this._onDeleted = (record: EntityRecord) => this._handleEntityDelete(record);
  }

  isStarted(): boolean {
    return this._started;
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this.registry.on('entity:created', this._onCreated);
    this.registry.on('entity:updated', this._onUpdated);
    this.registry.on('entity:deleted', this._onDeleted);
  }

  async stop(): Promise<void> {
    if (!this._started) return;
    this._started = false;
    this.registry.off('entity:created', this._onCreated);
    this.registry.off('entity:updated', this._onUpdated);
    this.registry.off('entity:deleted', this._onDeleted);
  }

  register<T>(def: ConfigKeyDefinition<T>): void {
    const existing = this.definitions.get(def.key);
    if (existing) {
      if (existing.validator !== def.validator || existing.defaultValue !== def.defaultValue) {
        throw new CoreError(
          'config-duplicate-key',
          `Config key "${def.key}" is already registered with different validator or default`,
        );
      }
      return;
    }
    this.definitions.set(def.key, def as unknown as ConfigKeyDefinition<unknown>);
  }

  get<T>(key: string): T {
    const def = this.definitions.get(key);
    if (!def) throw new UnknownConfigKeyError(key);

    const entityId = this.prefix + key;
    const record = this.registry.getEntity(entityId);
    if (record === null) return def.defaultValue as T;
    return record.metadata?.value as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const def = this.definitions.get(key);
    if (!def) throw new UnknownConfigKeyError(key);

    if (!def.validator(value)) {
      throw new ConfigValidationError(key, 'value failed validator');
    }

    const entityId = this.prefix + key;
    const existing = this.registry.getEntity(entityId);

    if (existing === null) {
      await this.registry.proposeEntity(entityId, { value });
    } else {
      await this.registry.updateEntity(entityId, { value });
    }
  }

  async clear(key: string): Promise<void> {
    const def = this.definitions.get(key);
    if (!def) throw new UnknownConfigKeyError(key);

    const entityId = this.prefix + key;
    const existing = this.registry.getEntity(entityId);
    if (existing !== null) {
      await this.registry.releaseEntity(entityId);
    }
  }

  watch<T>(key: string, handler: (event: ConfigChangeEvent<T>) => void): () => void {
    let watchers = this.keyWatchers.get(key);
    if (!watchers) {
      watchers = new Set();
      this.keyWatchers.set(key, watchers);
    }
    const typedHandler = handler as (event: ConfigChangeEvent<unknown>) => void;
    watchers.add(typedHandler);
    return () => {
      watchers!.delete(typedHandler);
    };
  }

  watchAll(handler: (event: ConfigChangeEvent) => void): () => void {
    this.allWatchers.add(handler);
    return () => {
      this.allWatchers.delete(handler);
    };
  }

  getRegisteredKeys(): string[] {
    return Array.from(this.definitions.keys());
  }

  getSnapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of this.definitions.keys()) {
      result[key] = this.get(key);
    }
    return result;
  }

  private _handleEntityChange(record: EntityRecord, _op: 'created' | 'updated'): void {
    if (!record.entityId.startsWith(this.prefix)) return;
    const key = record.entityId.slice(this.prefix.length);
    const def = this.definitions.get(key);
    if (!def) return;

    const newValue = record.metadata?.value;
    const event: ConfigChangeEvent = {
      key,
      oldValue: undefined,
      newValue,
      sourceNodeId: record.ownerNodeId,
      timestamp: record.lastUpdated,
    };

    this._dispatchChange(event);
  }

  private _handleEntityDelete(record: EntityRecord): void {
    if (!record.entityId.startsWith(this.prefix)) return;
    const key = record.entityId.slice(this.prefix.length);
    const def = this.definitions.get(key);
    if (!def) return;

    const event: ConfigChangeEvent = {
      key,
      oldValue: record.metadata?.value,
      newValue: def.defaultValue,
      sourceNodeId: record.ownerNodeId,
      timestamp: Date.now(),
    };

    this._dispatchChange(event);
  }

  private _dispatchChange(event: ConfigChangeEvent): void {
    this.emit('change', event);

    const watchers = this.keyWatchers.get(event.key);
    if (watchers) {
      for (const handler of watchers) {
        handler(event);
      }
    }

    for (const handler of this.allWatchers) {
      handler(event);
    }
  }
}
