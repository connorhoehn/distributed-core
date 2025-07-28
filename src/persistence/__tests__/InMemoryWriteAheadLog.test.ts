import { InMemoryWriteAheadLog } from '../memory/InMemoryWriteAheadLog';

describe('InMemoryWriteAheadLog', () => {
  let wal: InMemoryWriteAheadLog;

  beforeEach(() => {
    wal = new InMemoryWriteAheadLog();
  });

  describe('basic operations', () => {
    it('should append entries', () => {
      const entry1 = { action: 'SET', key: 'foo', value: 'bar' };
      const entry2 = { action: 'DELETE', key: 'baz' };

      wal.append(entry1);
      wal.append(entry2);

      const entries = wal.readAll();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual(entry1);
      expect(entries[1]).toEqual(entry2);
    });

    it('should return empty array when no entries', () => {
      expect(wal.readAll()).toEqual([]);
    });

    it('should clear all entries', () => {
      wal.append({ action: 'SET', key: 'foo', value: 'bar' });
      wal.append({ action: 'DELETE', key: 'baz' });
      
      wal.clear();
      
      expect(wal.readAll()).toEqual([]);
    });
  });

  describe('data integrity', () => {
    it('should return a copy of entries, not reference', () => {
      const entry = { action: 'SET', key: 'foo', value: 'bar' };
      wal.append(entry);
      
      const entries = wal.readAll();
      entries[0].action = 'MODIFIED';
      
      const freshEntries = wal.readAll();
      expect(freshEntries[0].action).toBe('SET');
    });

    it('should preserve entry order', () => {
      const entries = [
        { action: 'SET', key: 'a', value: 1 },
        { action: 'SET', key: 'b', value: 2 },
        { action: 'DELETE', key: 'a' },
        { action: 'SET', key: 'c', value: 3 }
      ];

      entries.forEach(entry => wal.append(entry));
      
      const readEntries = wal.readAll();
      expect(readEntries).toEqual(entries);
    });
  });

  describe('different data types', () => {
    it('should handle various entry types', () => {
      const stringEntry = 'simple string';
      const numberEntry = 42;
      const objectEntry = { complex: { nested: 'object' } };
      const arrayEntry = [1, 'two', { three: 3 }];

      wal.append(stringEntry);
      wal.append(numberEntry);
      wal.append(objectEntry);
      wal.append(arrayEntry);

      const entries = wal.readAll();
      expect(entries[0]).toBe(stringEntry);
      expect(entries[1]).toBe(numberEntry);
      expect(entries[2]).toEqual(objectEntry);
      expect(entries[3]).toEqual(arrayEntry);
    });

    it('should handle null and undefined entries', () => {
      wal.append(null);
      wal.append(undefined);
      
      const entries = wal.readAll();
      expect(entries[0]).toBeNull();
      expect(entries[1]).toBeUndefined();
    });
  });

  describe('performance characteristics', () => {
    it('should handle large number of entries', () => {
      const entryCount = 1000;
      
      for (let i = 0; i < entryCount; i++) {
        wal.append({ id: i, data: `entry-${i}` });
      }
      
      const entries = wal.readAll();
      expect(entries).toHaveLength(entryCount);
      expect(entries[0]).toEqual({ id: 0, data: 'entry-0' });
      expect(entries[entryCount - 1]).toEqual({ id: entryCount - 1, data: `entry-${entryCount - 1}` });
    });
  });
});
