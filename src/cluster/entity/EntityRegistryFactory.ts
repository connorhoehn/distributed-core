import { EntityRegistry } from './types';
import { WALConfig } from '../../persistence/wal/types';
import { CheckpointConfig } from '../../persistence/checkpoint/types';
import { WriteAheadLogEntityRegistry } from './WriteAheadLogEntityRegistry';
import { InMemoryEntityRegistry } from './InMemoryEntityRegistry';
import { CrdtEntityRegistry, CrdtRegistryOptions } from './CrdtEntityRegistry';

export type EntityRegistryType = 'memory' | 'wal' | 'crdt';

export interface EntityRegistryFactoryConfig {
  type: EntityRegistryType;
  nodeId: string;
  walConfig?: WALConfig;
  checkpointConfig?: CheckpointConfig;
  logConfig?: { enableTestMode?: boolean };
  /**
   * Tombstone TTL / compaction options for the CRDT registry. Ignored for
   * non-`crdt` types. See {@link CrdtRegistryOptions} for the
   * resurrection-window AP/CP tradeoff documentation.
   */
  crdtOptions?: CrdtRegistryOptions;
}

export class EntityRegistryFactory {
  static create(config: EntityRegistryFactoryConfig): EntityRegistry {
    const { type, nodeId } = config;

    switch (type) {
      case 'memory':
        return new InMemoryEntityRegistry(nodeId, config.logConfig);

      case 'wal':
        return new WriteAheadLogEntityRegistry(nodeId, config.walConfig);

      case 'crdt':
        return new CrdtEntityRegistry(nodeId, config.crdtOptions);

      default:
        throw new Error(`Unknown entity registry type: ${type}`);
    }
  }

  static createMemory(nodeId: string, logConfig?: { enableTestMode?: boolean }): EntityRegistry {
    return new InMemoryEntityRegistry(nodeId, logConfig);
  }

  static createWAL(nodeId: string, walConfig?: WALConfig): EntityRegistry {
    return new WriteAheadLogEntityRegistry(nodeId, walConfig);
  }

  /**
   * Create a CRDT registry with optional tombstone TTL / compaction config.
   *
   * Default behavior preserves "tombstones forever" semantics. Pass a finite
   * `tombstoneTTLMs` to opt in to bounded memory at the cost of an explicit
   * resurrection window (see {@link CrdtRegistryOptions}).
   */
  static createCRDT(nodeId: string, options?: CrdtRegistryOptions): EntityRegistry {
    return new CrdtEntityRegistry(nodeId, options);
  }
}
