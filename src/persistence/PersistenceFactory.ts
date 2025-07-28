import { IStateStore, IWriteAheadLog, IBroadcastBuffer } from '../types';
import { InMemoryStateStore } from './memory/InMemoryStateStore';
import { InMemoryWriteAheadLog } from './memory/InMemoryWriteAheadLog';
import { InMemoryBroadcastBuffer } from './memory/InMemoryBroadcastBuffer';

export interface PersistenceLayer {
  stateStore: IStateStore;
  wal: IWriteAheadLog;
  buffer: IBroadcastBuffer;
}

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
