import { IStateStore, IWriteAheadLog, IBroadcastBuffer } from '../types';
import { InMemoryStateStore } from './memory/InMemoryStateStore';
import { InMemoryWriteAheadLog } from './memory/InMemoryWriteAheadLog';
import { InMemoryBroadcastBuffer } from './memory/InMemoryBroadcastBuffer';
import { WALWriterImpl } from './wal/WALWriter';
import { WALReaderImpl } from './wal/WALReader';
import { CheckpointWriterImpl } from './checkpoint/CheckpointWriter';
import { CheckpointReaderImpl } from './checkpoint/CheckpointReader';
import { WALConfig } from './wal/types';
import { CheckpointConfig } from './checkpoint/types';

export interface PersistenceLayer {
  stateStore: IStateStore;
  wal: IWriteAheadLog;
  buffer: IBroadcastBuffer;
}

export interface StateStoreConfig {
  type: 'memory' | 'file' | 'wal';
  filePath?: string;
  walConfig?: WALConfig;
  checkpointConfig?: CheckpointConfig;
}

/**
 * Unified factory for creating persistence components
 */
export class UnifiedPersistenceFactory {
  /**
   * Create a WAL writer with specified configuration
   */
  static createWALWriter(config: WALConfig = {}): WALWriterImpl {
    return new WALWriterImpl(config);
  }

  /**
   * Create a WAL reader for specified file path
   */
  static createWALReader(filePath: string): WALReaderImpl {
    return new WALReaderImpl(filePath);
  }

  /**
   * Create a checkpoint writer with specified configuration
   */
  static createCheckpointWriter(config: CheckpointConfig = {}): CheckpointWriterImpl {
    return new CheckpointWriterImpl(config);
  }

  /**
   * Create a checkpoint reader with specified configuration
   */
  static createCheckpointReader(config: CheckpointConfig = {}): CheckpointReaderImpl {
    return new CheckpointReaderImpl(config);
  }

  /**
   * Create a complete WAL-based persistence setup
   */
  static createWALPersistence(walConfig: WALConfig = {}, checkpointConfig: CheckpointConfig = {}) {
    const walWriter = UnifiedPersistenceFactory.createWALWriter(walConfig);
    const walReader = UnifiedPersistenceFactory.createWALReader(walConfig.filePath || './data/default.wal');
    const checkpointWriter = UnifiedPersistenceFactory.createCheckpointWriter(checkpointConfig);
    const checkpointReader = UnifiedPersistenceFactory.createCheckpointReader(checkpointConfig);

    return {
      walWriter,
      walReader,
      checkpointWriter,
      checkpointReader
    };
  }
}

// Keep the original function for backward compatibility
export function createPersistenceLayer(type = 'inMemory'): PersistenceLayer {
  if (type === 'inMemory') {
    return {
      stateStore: new InMemoryStateStore(),
      wal: new InMemoryWriteAheadLog(),
      buffer: new InMemoryBroadcastBuffer(),
    };
  }

  throw new Error(`Unsupported persistence type: ${type}`);
}
