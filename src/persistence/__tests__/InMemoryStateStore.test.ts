import { InMemoryStateStore } from '../memory/InMemoryStateStore';

describe('InMemoryStateStore', () => {
  let store: InMemoryStateStore;

  beforeEach(() => {
    store = new InMemoryStateStore();
  });

  describe('basic operations', () => {
    it('should set and get values', () => {
      store.set('foo', 'bar');
      expect(store.get('foo')).toBe('bar');
    });

    it('should return undefined for non-existent keys', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('should delete values', () => {
      store.set('foo', 'bar');
      store.delete('foo');
      expect(store.get('foo')).toBeUndefined();
    });

    it('should clear all values', () => {
      store.set('foo', 'bar');
      store.set('baz', 'qux');
      store.clear();
      expect(store.get('foo')).toBeUndefined();
      expect(store.get('baz')).toBeUndefined();
    });
  });

  describe('typed operations', () => {
    it('should handle different data types', () => {
      store.set('string', 'hello');
      store.set('number', 42);
      store.set('object', { key: 'value' });
      store.set('array', [1, 2, 3]);

      expect(store.get<string>('string')).toBe('hello');
      expect(store.get<number>('number')).toBe(42);
      expect(store.get<object>('object')).toEqual({ key: 'value' });
      expect(store.get<number[]>('array')).toEqual([1, 2, 3]);
    });
  });

  describe('snapshot', () => {
    it('should return a snapshot of all data', () => {
      store.set('foo', 'bar');
      store.set('num', 123);
      
      const snapshot = store.snapshot();
      
      expect(snapshot).toEqual({
        foo: 'bar',
        num: 123
      });
    });

    it('should return a copy, not reference', () => {
      store.set('foo', 'bar');
      const snapshot = store.snapshot();
      
      snapshot.foo = 'modified';
      expect(store.get('foo')).toBe('bar');
    });

    it('should return empty object when store is empty', () => {
      expect(store.snapshot()).toEqual({});
    });
  });

  describe('edge cases', () => {
    it('should handle null and undefined values', () => {
      store.set('null', null);
      store.set('undefined', undefined);
      
      expect(store.get('null')).toBeNull();
      expect(store.get('undefined')).toBeUndefined();
    });

    it('should overwrite existing values', () => {
      store.set('key', 'original');
      store.set('key', 'updated');
      
      expect(store.get('key')).toBe('updated');
    });
  });
});
