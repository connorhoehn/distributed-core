import { EntityRegistry, WALConfig } from './types';
import { WriteAheadLogEntityRegistry } from './WriteAheadLogEntityRegistry';
import { InMemoryEntityRegistry } from './InMemoryEntityRegistry';

export type EntityRegistryType = 'memory' | 'wal' | 'etcd' | 'zookeeper' | 'crdt';

export interface EntityRegistryFactoryConfig {
  type: EntityRegistryType;
  nodeId: string;
  walConfig?: WALConfig;
  logConfig?: { enableTestMode?: boolean };
  // Future: etcdConfig, zkConfig, crdtConfig, etc.
}

export class EntityRegistryFactory {
  static create(config: EntityRegistryFactoryConfig): EntityRegistry {
    const { type, nodeId } = config;

    switch (type) {
      case 'memory':
        return new InMemoryEntityRegistry(nodeId, config.logConfig);
      
      case 'wal':
        return new WriteAheadLogEntityRegistry(nodeId, config.walConfig);
      
      case 'etcd':
        throw new Error('EtcdEntityRegistry not implemented yet');
      
      case 'zookeeper':
        throw new Error('ZookeeperEntityRegistry not implemented yet');
      
      case 'crdt':
        throw new Error('CrdtEntityRegistry not implemented yet');
      
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
