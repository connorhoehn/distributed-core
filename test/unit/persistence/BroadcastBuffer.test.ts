import { BroadcastBuffer } from '../../../src/persistence/BroadcastBuffer';

describe('BroadcastBuffer', () => {
  let buffer: BroadcastBuffer;

  beforeEach(() => {
    buffer = new BroadcastBuffer();
  });

  describe('Constructor', () => {
    test('should create empty buffer', () => {
      expect(buffer.size()).toBe(0);
    });

    test('should implement IBroadcastBuffer interface', () => {
      expect(buffer).toHaveProperty('add');
      expect(buffer).toHaveProperty('drain');
      expect(buffer).toHaveProperty('size');
    });
  });

  describe('Message Management', () => {
    test('should add single message', () => {
      const message = { id: '1', data: 'test' };
      buffer.add(message);
      
      expect(buffer.size()).toBe(1);
    });

    test('should add multiple messages', () => {
      const messages = [
        { id: '1', data: 'test1' },
        { id: '2', data: 'test2' },
        { id: '3', data: 'test3' }
      ];
      
      messages.forEach(msg => buffer.add(msg));
      
      expect(buffer.size()).toBe(3);
    });

    test('should handle different message types', () => {
      const stringMsg = 'simple string';
      const objectMsg = { complex: { nested: true }, array: [1, 2, 3] };
      const numberMsg = 42;
      const nullMsg = null;
      
      buffer.add(stringMsg);
      buffer.add(objectMsg);
      buffer.add(numberMsg);
      buffer.add(nullMsg);
      
      expect(buffer.size()).toBe(4);
    });

    test('should preserve message order', () => {
      const messages = ['first', 'second', 'third'];
      messages.forEach(msg => buffer.add(msg));
      
      const drained = buffer.drain();
      expect(drained).toEqual(['first', 'second', 'third']);
    });
  });

  describe('Buffer Draining', () => {
    test('should drain empty buffer', () => {
      const drained = buffer.drain();
      
      expect(drained).toEqual([]);
      expect(buffer.size()).toBe(0);
    });

    test('should drain single message', () => {
      const message = { id: '1', data: 'test' };
      buffer.add(message);
      
      const drained = buffer.drain();
      
      expect(drained).toEqual([message]);
      expect(buffer.size()).toBe(0);
    });

    test('should drain multiple messages', () => {
      const messages = [
        { id: '1', data: 'test1' },
        { id: '2', data: 'test2' },
        { id: '3', data: 'test3' }
      ];
      
      messages.forEach(msg => buffer.add(msg));
      const drained = buffer.drain();
      
      expect(drained).toEqual(messages);
      expect(buffer.size()).toBe(0);
    });

    test('should return copy of messages (not reference)', () => {
      const message = { id: '1', data: 'test' };
      buffer.add(message);
      
      const drained = buffer.drain();
      
      // Modify the drained array
      drained.push({ id: '2', data: 'modified' });
      
      // Original buffer should remain empty
      expect(buffer.size()).toBe(0);
    });

    test('should allow multiple drains', () => {
      // First drain
      buffer.add('message1');
      let drained = buffer.drain();
      expect(drained).toEqual(['message1']);
      expect(buffer.size()).toBe(0);
      
      // Second drain
      buffer.add('message2');
      drained = buffer.drain();
      expect(drained).toEqual(['message2']);
      expect(buffer.size()).toBe(0);
    });
  });

  describe('Buffer State Management', () => {
    test('should maintain accurate size after operations', () => {
      expect(buffer.size()).toBe(0);
      
      buffer.add('msg1');
      expect(buffer.size()).toBe(1);
      
      buffer.add('msg2');
      expect(buffer.size()).toBe(2);
      
      buffer.drain();
      expect(buffer.size()).toBe(0);
      
      buffer.add('msg3');
      expect(buffer.size()).toBe(1);
    });

    test('should handle empty operations gracefully', () => {
      // Multiple drains on empty buffer
      expect(buffer.drain()).toEqual([]);
      expect(buffer.drain()).toEqual([]);
      expect(buffer.size()).toBe(0);
    });

    test('should handle large number of messages', () => {
      const messageCount = 1000;
      const messages: string[] = [];
      
      // Add many messages
      for (let i = 0; i < messageCount; i++) {
        const msg = `message-${i}`;
        messages.push(msg);
        buffer.add(msg);
      }
      
      expect(buffer.size()).toBe(messageCount);
      
      const drained = buffer.drain();
      expect(drained).toEqual(messages);
      expect(buffer.size()).toBe(0);
    });
  });

  describe('Memory Management', () => {
    test('should clear internal buffer after drain', () => {
      buffer.add('test1');
      buffer.add('test2');
      
      expect(buffer.size()).toBe(2);
      
      const drained = buffer.drain();
      
      // Buffer should be reset
      expect(buffer.size()).toBe(0);
      expect(drained.length).toBe(2);
    });

    test('should handle rapid add/drain cycles', () => {
      for (let cycle = 0; cycle < 100; cycle++) {
        buffer.add(`cycle-${cycle}`);
        const drained = buffer.drain();
        
        expect(drained).toEqual([`cycle-${cycle}`]);
        expect(buffer.size()).toBe(0);
      }
    });
  });

  describe('Edge Cases', () => {
    test('should handle undefined messages', () => {
      buffer.add(undefined);
      
      expect(buffer.size()).toBe(1);
      
      const drained = buffer.drain();
      expect(drained).toEqual([undefined]);
    });

    test('should handle complex nested objects', () => {
      const complexMessage = {
        metadata: {
          timestamp: Date.now(),
          source: 'test-node',
          version: '1.0.0'
        },
        payload: {
          data: [1, 2, 3, 4, 5],
          nested: {
            deep: {
              value: 'buried treasure'
            }
          }
        },
        functions: {
          toString: () => 'custom string'
        }
      };
      
      buffer.add(complexMessage);
      const drained = buffer.drain();
      
      expect(drained[0]).toEqual(complexMessage);
    });

    test('should preserve message references correctly', () => {
      const sharedObject = { shared: true };
      const message1 = { id: 1, ref: sharedObject };
      const message2 = { id: 2, ref: sharedObject };
      
      buffer.add(message1);
      buffer.add(message2);
      
      const drained = buffer.drain();
      
      // Both messages should reference the same object
      expect(drained[0].ref).toBe(drained[1].ref);
      expect(drained[0].ref.shared).toBe(true);
    });
  });
});
