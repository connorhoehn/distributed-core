import { createPersistenceLayer } from '../../../src/persistence/PersistenceFactory';
import { InMemoryBroadcastBuffer } from '../../../src/persistence/memory/InMemoryBroadcastBuffer';
import { InMemoryStateStore } from '../../../src/persistence/memory/InMemoryStateStore';
import { InMemoryWriteAheadLog } from '../../../src/persistence/memory/InMemoryWriteAheadLog';

describe('PersistenceFactory', () => {
  describe('createPersistenceLayer', () => {
    test('should create in-memory persistence layer by default', () => {
      const layer = createPersistenceLayer();
      
      expect(layer).toHaveProperty('stateStore');
      expect(layer).toHaveProperty('wal');
      expect(layer).toHaveProperty('buffer');
      
      expect(layer.stateStore).toBeInstanceOf(InMemoryStateStore);
      expect(layer.wal).toBeInstanceOf(InMemoryWriteAheadLog);
      expect(layer.buffer).toBeInstanceOf(InMemoryBroadcastBuffer);
    });

    test('should create functional persistence layer', () => {
      const layer = createPersistenceLayer();
      
      // Test state store
      layer.stateStore.set('key', 'value');
      expect(layer.stateStore.get('key')).toBe('value');
      
      // Test WAL
      layer.wal.append('log entry');
      expect(layer.wal.readAll()).toEqual(['log entry']);
      
      // Test buffer
      layer.buffer.add('message');
      expect(layer.buffer.size()).toBe(1);
      expect(layer.buffer.drain()).toEqual(['message']);
    });
  });
});
