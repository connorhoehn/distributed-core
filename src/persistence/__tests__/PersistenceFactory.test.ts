import { createPersistenceLayer } from '../PersistenceFactory';
import { InMemoryStateStore } from '../memory/InMemoryStateStore';
import { InMemoryWriteAheadLog } from '../memory/InMemoryWriteAheadLog';
import { InMemoryBroadcastBuffer } from '../memory/InMemoryBroadcastBuffer';

describe('PersistenceFactory', () => {
  describe('createPersistenceLayer', () => {
    it('should create in-memory persistence layer by default', () => {
      const layer = createPersistenceLayer();
      
      expect(layer.stateStore).toBeInstanceOf(InMemoryStateStore);
      expect(layer.wal).toBeInstanceOf(InMemoryWriteAheadLog);
      expect(layer.buffer).toBeInstanceOf(InMemoryBroadcastBuffer);
    });

    it('should create in-memory persistence layer when explicitly requested', () => {
      const layer = createPersistenceLayer('inMemory');
      
      expect(layer.stateStore).toBeInstanceOf(InMemoryStateStore);
      expect(layer.wal).toBeInstanceOf(InMemoryWriteAheadLog);
      expect(layer.buffer).toBeInstanceOf(InMemoryBroadcastBuffer);
    });

    it('should throw error for unsupported persistence type', () => {
      expect(() => createPersistenceLayer('unsupported')).toThrow('Unsupported persistence type: unsupported');
    });

    it('should create independent instances', () => {
      const layer1 = createPersistenceLayer();
      const layer2 = createPersistenceLayer();
      
      expect(layer1.stateStore).not.toBe(layer2.stateStore);
      expect(layer1.wal).not.toBe(layer2.wal);
      expect(layer1.buffer).not.toBe(layer2.buffer);
    });

    it('should create functional persistence components', () => {
      const layer = createPersistenceLayer();
      
      // Test StateStore
      layer.stateStore.set('test', 'value');
      expect(layer.stateStore.get('test')).toBe('value');
      
      // Test WriteAheadLog
      layer.wal.append({ action: 'test' });
      expect(layer.wal.readAll()).toHaveLength(1);
      
      // Test BroadcastBuffer
      layer.buffer.add({ message: 'test' });
      expect(layer.buffer.size()).toBe(1);
    });
  });
});
