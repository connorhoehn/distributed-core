import { WriteAheadLog } from '../../../src/persistence/WriteAheadLog';

describe('WriteAheadLog', () => {
  let wal: WriteAheadLog;

  beforeEach(() => {
    wal = new WriteAheadLog();
  });

  describe('Constructor', () => {
    test('should create empty log', () => {
      const entries = wal.readAll();
      expect(entries).toEqual([]);
    });

    test('should implement IWriteAheadLog interface', () => {
      expect(wal).toHaveProperty('append');
      expect(wal).toHaveProperty('readAll');
      expect(wal).toHaveProperty('clear');
    });
  });

  describe('Append Operations', () => {
    test('should append string entries', () => {
      wal.append('first entry');
      wal.append('second entry');
      
      const entries = wal.readAll();
      expect(entries).toEqual(['first entry', 'second entry']);
    });

    test('should append object entries', () => {
      const entry1 = { id: 1, data: 'test' };
      const entry2 = { id: 2, data: 'another' };
      
      wal.append(entry1);
      wal.append(entry2);
      
      const entries = wal.readAll();
      expect(entries).toEqual([entry1, entry2]);
    });

    test('should append array entries', () => {
      const entry1 = [1, 2, 3];
      const entry2 = ['a', 'b', 'c'];
      
      wal.append(entry1);
      wal.append(entry2);
      
      const entries = wal.readAll();
      expect(entries).toEqual([entry1, entry2]);
    });

    test('should append primitive type entries', () => {
      wal.append(42);
      wal.append(true);
      wal.append(null);
      wal.append(undefined);
      
      const entries = wal.readAll();
      expect(entries).toEqual([42, true, null, undefined]);
    });

    test('should maintain order of appended entries', () => {
      const testEntries = ['first', 'second', 'third', 'fourth', 'fifth'];
      
      testEntries.forEach(entry => wal.append(entry));
      
      const entries = wal.readAll();
      expect(entries).toEqual(testEntries);
    });

    test('should handle rapid sequential appends', () => {
      const count = 100;
      const expectedEntries = [];
      
      for (let i = 0; i < count; i++) {
        const entry = `entry-${i}`;
        wal.append(entry);
        expectedEntries.push(entry);
      }
      
      const entries = wal.readAll();
      expect(entries).toEqual(expectedEntries);
      expect(entries.length).toBe(count);
    });
  });

  describe('Read Operations', () => {
    test('should read empty log', () => {
      const entries = wal.readAll();
      expect(entries).toEqual([]);
      expect(entries.length).toBe(0);
    });

    test('should read single entry', () => {
      wal.append('single entry');
      
      const entries = wal.readAll();
      expect(entries).toEqual(['single entry']);
      expect(entries.length).toBe(1);
    });

    test('should read multiple entries', () => {
      wal.append('entry1');
      wal.append('entry2');
      wal.append('entry3');
      
      const entries = wal.readAll();
      expect(entries).toEqual(['entry1', 'entry2', 'entry3']);
      expect(entries.length).toBe(3);
    });

    test('should return new array on each readAll call', () => {
      wal.append('test');
      
      const entries1 = wal.readAll();
      const entries2 = wal.readAll();
      
      expect(entries1).toEqual(entries2);
      expect(entries1).not.toBe(entries2); // Different array instances
    });

    test('should not affect internal state when modifying returned array', () => {
      wal.append('original');
      
      const entries = wal.readAll();
      entries.push('modified');
      entries[0] = 'changed';
      
      const freshEntries = wal.readAll();
      expect(freshEntries).toEqual(['original']);
    });
  });

  describe('Clear Operations', () => {
    test('should clear empty log', () => {
      wal.clear();
      const entries = wal.readAll();
      expect(entries).toEqual([]);
    });

    test('should clear log with single entry', () => {
      wal.append('entry');
      expect(wal.readAll()).toEqual(['entry']);
      
      wal.clear();
      const entries = wal.readAll();
      expect(entries).toEqual([]);
    });

    test('should clear log with multiple entries', () => {
      wal.append('entry1');
      wal.append('entry2');
      wal.append('entry3');
      expect(wal.readAll().length).toBe(3);
      
      wal.clear();
      const entries = wal.readAll();
      expect(entries).toEqual([]);
    });

    test('should allow operations after clear', () => {
      wal.append('before clear');
      wal.clear();
      
      wal.append('after clear');
      const entries = wal.readAll();
      expect(entries).toEqual(['after clear']);
    });

    test('should handle multiple clear operations', () => {
      wal.append('entry');
      wal.clear();
      wal.clear(); // Second clear should not cause issues
      
      const entries = wal.readAll();
      expect(entries).toEqual([]);
    });
  });

  describe('Mixed Operations', () => {
    test('should handle append-read-append cycles', () => {
      wal.append('first');
      expect(wal.readAll()).toEqual(['first']);
      
      wal.append('second');
      expect(wal.readAll()).toEqual(['first', 'second']);
      
      wal.append('third');
      expect(wal.readAll()).toEqual(['first', 'second', 'third']);
    });

    test('should handle append-clear-append cycles', () => {
      wal.append('before1');
      wal.append('before2');
      expect(wal.readAll().length).toBe(2);
      
      wal.clear();
      expect(wal.readAll()).toEqual([]);
      
      wal.append('after1');
      wal.append('after2');
      expect(wal.readAll()).toEqual(['after1', 'after2']);
    });

    test('should handle interleaved operations', () => {
      wal.append('1');
      expect(wal.readAll()).toEqual(['1']);
      
      wal.append('2');
      wal.append('3');
      expect(wal.readAll()).toEqual(['1', '2', '3']);
      
      wal.clear();
      expect(wal.readAll()).toEqual([]);
      
      wal.append('new1');
      expect(wal.readAll()).toEqual(['new1']);
    });
  });

  describe('Type Safety', () => {
    test('should handle generic types correctly', () => {
      interface LogEntry {
        timestamp: number;
        action: string;
        data: any;
      }
      
      const entry1: LogEntry = { timestamp: 1, action: 'create', data: { id: 1 } };
      const entry2: LogEntry = { timestamp: 2, action: 'update', data: { id: 1, name: 'test' } };
      
      wal.append(entry1);
      wal.append(entry2);
      
      const entries = wal.readAll();
      expect(entries).toEqual([entry1, entry2]);
      expect((entries[0] as LogEntry).timestamp).toBe(1);
      expect((entries[1] as LogEntry).action).toBe('update');
    });

    test('should maintain type information for primitives', () => {
      wal.append('string entry');
      wal.append(42);
      wal.append(true);
      
      const entries = wal.readAll();
      expect(typeof entries[0]).toBe('string');
      expect(typeof entries[1]).toBe('number');
      expect(typeof entries[2]).toBe('boolean');
    });
  });

  describe('Performance & Memory', () => {
    test('should handle large number of entries', () => {
      const entryCount = 1000;
      const expectedEntries = [];
      
      for (let i = 0; i < entryCount; i++) {
        const entry = { id: i, data: `data-${i}` };
        wal.append(entry);
        expectedEntries.push(entry);
      }
      
      const entries = wal.readAll();
      expect(entries.length).toBe(entryCount);
      expect(entries).toEqual(expectedEntries);
      
      // Clear and verify memory is released
      wal.clear();
      expect(wal.readAll().length).toBe(0);
    });

    test('should handle rapid append/clear cycles', () => {
      const cycles = 10;
      const entriesPerCycle = 50;
      
      for (let cycle = 0; cycle < cycles; cycle++) {
        // Append entries
        for (let i = 0; i < entriesPerCycle; i++) {
          wal.append(`cycle-${cycle}-entry-${i}`);
        }
        
        expect(wal.readAll().length).toBe(entriesPerCycle);
        
        // Clear for next cycle
        wal.clear();
        expect(wal.readAll().length).toBe(0);
      }
    });
  });

  describe('Edge Cases', () => {
    test('should handle complex nested objects', () => {
      const complexEntry = {
        level1: {
          level2: {
            level3: {
              data: 'deeply nested',
              array: [1, 2, { nested: true }]
            }
          }
        },
        metadata: {
          created: new Date(),
          tags: ['tag1', 'tag2']
        }
      };
      
      wal.append(complexEntry);
      const entries = wal.readAll();
      expect(entries[0]).toEqual(complexEntry);
    });

    test('should handle circular references', () => {
      const circularEntry: any = { name: 'circular' };
      circularEntry.self = circularEntry;
      
      expect(() => wal.append(circularEntry)).not.toThrow();
      
      const entries = wal.readAll();
      expect(entries[0].name).toBe('circular');
      expect(entries[0].self).toBe(entries[0]);
    });

    test('should preserve object references', () => {
      const sharedObject = { shared: true };
      const entry1 = { id: 1, ref: sharedObject };
      const entry2 = { id: 2, ref: sharedObject };
      
      wal.append(entry1);
      wal.append(entry2);
      
      const entries = wal.readAll();
      expect(entries[0].ref).toBe(entries[1].ref);
      
      // Modifying shared object should affect both entries
      sharedObject.shared = false;
      expect(entries[0].ref.shared).toBe(false);
      expect(entries[1].ref.shared).toBe(false);
    });

    test('should handle very large individual entries', () => {
      const largeString = 'x'.repeat(10000);
      const largeArray = new Array(1000).fill(0).map((_, i) => ({ index: i, data: `item-${i}` }));
      
      wal.append(largeString);
      wal.append(largeArray);
      
      const entries = wal.readAll();
      expect(entries[0]).toBe(largeString);
      expect(entries[1]).toEqual(largeArray);
      expect(entries[1].length).toBe(1000);
    });

    test('should handle empty and falsy values', () => {
      wal.append('');
      wal.append(0);
      wal.append(false);
      wal.append(null);
      wal.append(undefined);
      wal.append([]);
      wal.append({});
      
      const entries = wal.readAll();
      expect(entries).toEqual(['', 0, false, null, undefined, [], {}]);
    });
  });
});
