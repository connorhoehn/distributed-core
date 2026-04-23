import { EntityRegistry } from './types';
import { WALConfig } from '../../persistence/wal/types';
import { CheckpointConfig } from '../../persistence/checkpoint/types';
import { WriteAheadLogEntityRegistry } from './WriteAheadLogEntityRegistry';
import { InMemoryEntityRegistry } from './InMemoryEntityRegistry';
import { CrdtEntityRegistry } from './CrdtEntityRegistry';

export type EntityRegistryType = 'memory' | 'wal' | 'crdt';

export interface EntityRegistryFactoryConfig {
  type: EntityRegistryType;
  nodeId: string;
  walConfig?: WALConfig;
  checkpointConfig?: CheckpointConfig;
  logConfig?: { enableTestMode?: boolean };
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
        return new CrdtEntityRegistry(nodeId);
      
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
}
