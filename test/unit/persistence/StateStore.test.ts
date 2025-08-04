import { StateStore } from '../../../src/persistence/StateStore';

describe('StateStore', () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore();
  });

  describe('Constructor', () => {
    test('should create empty store', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    test('should implement IStateStore interface', () => {
      expect(store).toHaveProperty('get');
      expect(store).toHaveProperty('set');
      expect(store).toHaveProperty('delete');
      expect(store).toHaveProperty('clear');
    });
  });

  describe('Basic Operations', () => {
    test('should store and retrieve string values', () => {
      store.set('key1', 'value1');
      expect(store.get('key1')).toBe('value1');
    });

    test('should store and retrieve number values', () => {
      store.set('numberKey', 42);
      expect(store.get('numberKey')).toBe(42);
    });

    test('should store and retrieve boolean values', () => {
      store.set('boolKey', true);
      expect(store.get('boolKey')).toBe(true);
      
      store.set('boolKey2', false);
      expect(store.get('boolKey2')).toBe(false);
    });

    test('should store and retrieve object values', () => {
      const complexObject = {
        nested: { value: 'test' },
        array: [1, 2, 3],
        number: 42
      };
      
      store.set('objectKey', complexObject);
      expect(store.get('objectKey')).toEqual(complexObject);
    });

    test('should store and retrieve array values', () => {
      const testArray = ['a', 'b', 'c', 1, 2, 3];
      store.set('arrayKey', testArray);
      expect(store.get('arrayKey')).toEqual(testArray);
    });

    test('should store null values', () => {
      store.set('nullKey', null);
      expect(store.get('nullKey')).toBeNull();
    });

    test('should store undefined values', () => {
      store.set('undefinedKey', undefined);
      expect(store.get('undefinedKey')).toBeUndefined();
    });
  });

  describe('Key Management', () => {
    test('should handle different key types', () => {
      store.set('stringKey', 'value1');
      store.set('123', 'value2');
      store.set('key-with-dashes', 'value3');
      store.set('key_with_underscores', 'value4');
      store.set('key.with.dots', 'value5');
      
      expect(store.get('stringKey')).toBe('value1');
      expect(store.get('123')).toBe('value2');
      expect(store.get('key-with-dashes')).toBe('value3');
      expect(store.get('key_with_underscores')).toBe('value4');
      expect(store.get('key.with.dots')).toBe('value5');
    });

    test('should return undefined for non-existent keys', () => {
      expect(store.get('doesNotExist')).toBeUndefined();
      expect(store.get('')).toBeUndefined();
      expect(store.get('null')).toBeUndefined();
    });

    test('should handle empty string as key', () => {
      store.set('', 'empty key value');
      expect(store.get('')).toBe('empty key value');
    });

    test('should be case sensitive with keys', () => {
      store.set('Key', 'uppercase');
      store.set('key', 'lowercase');
      store.set('KEY', 'allcaps');
      
      expect(store.get('Key')).toBe('uppercase');
      expect(store.get('key')).toBe('lowercase');
      expect(store.get('KEY')).toBe('allcaps');
    });
  });

  describe('Value Updates', () => {
    test('should update existing values', () => {
      store.set('key', 'initial');
      expect(store.get('key')).toBe('initial');
      
      store.set('key', 'updated');
      expect(store.get('key')).toBe('updated');
    });

    test('should update with different types', () => {
      store.set('key', 'string');
      expect(store.get('key')).toBe('string');
      
      store.set('key', 42);
      expect(store.get('key')).toBe(42);
      
      store.set('key', { object: true });
      expect(store.get('key')).toEqual({ object: true });
      
      store.set('key', [1, 2, 3]);
      expect(store.get('key')).toEqual([1, 2, 3]);
    });

    test('should preserve references for objects', () => {
      const originalObject = { shared: true };
      store.set('key', originalObject);
      
      const retrieved = store.get('key');
      expect(retrieved).toBe(originalObject);
      
      // Modifying the original should affect the stored value
      originalObject.shared = false;
      expect(store.get('key')).toEqual({ shared: false });
    });
  });

  describe('Deletion Operations', () => {
    test('should delete existing keys', () => {
      store.set('key', 'value');
      expect(store.get('key')).toBe('value');
      
      store.delete('key');
      expect(store.get('key')).toBeUndefined();
    });

    test('should handle deletion of non-existent keys gracefully', () => {
      expect(() => store.delete('nonexistent')).not.toThrow();
      expect(store.get('nonexistent')).toBeUndefined();
    });

    test('should only delete specified key', () => {
      store.set('key1', 'value1');
      store.set('key2', 'value2');
      store.set('key3', 'value3');
      
      store.delete('key2');
      
      expect(store.get('key1')).toBe('value1');
      expect(store.get('key2')).toBeUndefined();
      expect(store.get('key3')).toBe('value3');
    });

    test('should handle multiple deletions', () => {
      store.set('a', 1);
      store.set('b', 2);
      store.set('c', 3);
      
      store.delete('a');
      store.delete('c');
      
      expect(store.get('a')).toBeUndefined();
      expect(store.get('b')).toBe(2);
      expect(store.get('c')).toBeUndefined();
    });
  });

  describe('Clear Operations', () => {
    test('should clear empty store', () => {
      expect(() => store.clear()).not.toThrow();
    });

    test('should clear store with single item', () => {
      store.set('key', 'value');
      expect(store.get('key')).toBe('value');
      
      store.clear();
      expect(store.get('key')).toBeUndefined();
    });

    test('should clear store with multiple items', () => {
      store.set('key1', 'value1');
      store.set('key2', 'value2');
      store.set('key3', 'value3');
      
      store.clear();
      
      expect(store.get('key1')).toBeUndefined();
      expect(store.get('key2')).toBeUndefined();
      expect(store.get('key3')).toBeUndefined();
    });

    test('should allow operations after clear', () => {
      store.set('before', 'clear');
      store.clear();
      
      store.set('after', 'clear');
      expect(store.get('before')).toBeUndefined();
      expect(store.get('after')).toBe('clear');
    });
  });

  describe('Type Safety', () => {
    test('should handle generic types correctly', () => {
      interface TestType {
        id: number;
        name: string;
      }
      
      const testObject: TestType = { id: 1, name: 'test' };
      store.set<TestType>('typed', testObject);
      
      const retrieved = store.get<TestType>('typed');
      expect(retrieved).toEqual(testObject);
      expect(retrieved?.id).toBe(1);
      expect(retrieved?.name).toBe('test');
    });

    test('should maintain type information for primitives', () => {
      store.set<string>('stringVal', 'hello');
      store.set<number>('numberVal', 42);
      store.set<boolean>('boolVal', true);
      
      const str = store.get<string>('stringVal');
      const num = store.get<number>('numberVal');
      const bool = store.get<boolean>('boolVal');
      
      expect(typeof str).toBe('string');
      expect(typeof num).toBe('number');
      expect(typeof bool).toBe('boolean');
    });
  });

  describe('Performance & Memory', () => {
    test('should handle large number of keys', () => {
      const keyCount = 1000;
      
      // Set many values
      for (let i = 0; i < keyCount; i++) {
        store.set(`key-${i}`, `value-${i}`);
      }
      
      // Verify they exist
      for (let i = 0; i < keyCount; i++) {
        expect(store.get(`key-${i}`)).toBe(`value-${i}`);
      }
      
      // Clear and verify cleanup
      store.clear();
      for (let i = 0; i < keyCount; i++) {
        expect(store.get(`key-${i}`)).toBeUndefined();
      }
    });

    test('should handle rapid operations', () => {
      const iterations = 100;
      
      for (let i = 0; i < iterations; i++) {
        store.set('rapid', i);
        expect(store.get('rapid')).toBe(i);
        
        if (i % 2 === 0) {
          store.delete('rapid');
          expect(store.get('rapid')).toBeUndefined();
          store.set('rapid', i);
        }
      }
    });
  });

  describe('Edge Cases', () => {
    test('should handle special characters in keys', () => {
      const specialKeys = [
        'key with spaces',
        'key\nwith\nnewlines',
        'key\twith\ttabs',
        'key"with"quotes',
        "key'with'apostrophes",
        'key\\with\\backslashes',
        'key/with/slashes',
        'key@with#special$chars%'
      ];
      
      specialKeys.forEach((key, index) => {
        store.set(key, `value-${index}`);
        expect(store.get(key)).toBe(`value-${index}`);
      });
    });

    test('should handle circular references in objects', () => {
      const circularObj: any = { name: 'circular' };
      circularObj.self = circularObj;
      
      // This should not throw (though JSON serialization would fail)
      expect(() => store.set('circular', circularObj)).not.toThrow();
      
      const retrieved: any = store.get('circular');
      expect(retrieved?.name).toBe('circular');
      expect(retrieved?.self).toBe(retrieved);
    });

    test('should handle very long keys', () => {
      const longKey = 'a'.repeat(1000);
      store.set(longKey, 'long key value');
      expect(store.get(longKey)).toBe('long key value');
    });
  });
});
