import { InMemoryBroadcastBuffer } from '../memory/InMemoryBroadcastBuffer';

describe('InMemoryBroadcastBuffer', () => {
  let buffer: InMemoryBroadcastBuffer;

  beforeEach(() => {
    buffer = new InMemoryBroadcastBuffer();
  });

  describe('basic operations', () => {
    it('should add and drain messages', () => {
      const message1 = { type: 'gossip', data: 'hello' };
      const message2 = { type: 'sync', data: 'world' };

      buffer.add(message1);
      buffer.add(message2);

      const drained = buffer.drain();
      expect(drained).toHaveLength(2);
      expect(drained[0]).toEqual(message1);
      expect(drained[1]).toEqual(message2);
    });

    it('should return empty array when buffer is empty', () => {
      expect(buffer.drain()).toEqual([]);
    });

    it('should clear buffer after drain', () => {
      buffer.add({ type: 'test', data: 'message' });
      expect(buffer.size()).toBe(1);
      
      buffer.drain();
      expect(buffer.size()).toBe(0);
      expect(buffer.drain()).toEqual([]);
    });

    it('should track buffer size correctly', () => {
      expect(buffer.size()).toBe(0);
      
      buffer.add({ type: 'msg1' });
      expect(buffer.size()).toBe(1);
      
      buffer.add({ type: 'msg2' });
      expect(buffer.size()).toBe(2);
      
      buffer.drain();
      expect(buffer.size()).toBe(0);
    });
  });

  describe('message ordering', () => {
    it('should preserve message order (FIFO)', () => {
      const messages = [
        { id: 1, data: 'first' },
        { id: 2, data: 'second' },
        { id: 3, data: 'third' }
      ];

      messages.forEach(msg => buffer.add(msg));
      
      const drained = buffer.drain();
      expect(drained).toEqual(messages);
    });

    it('should handle multiple drain operations', () => {
      buffer.add({ id: 1 });
      buffer.add({ id: 2 });
      
      const firstDrain = buffer.drain();
      expect(firstDrain).toEqual([{ id: 1 }, { id: 2 }]);
      
      buffer.add({ id: 3 });
      const secondDrain = buffer.drain();
      expect(secondDrain).toEqual([{ id: 3 }]);
    });
  });

  describe('data integrity', () => {
    it('should return a copy of messages, not reference', () => {
      const message = { mutable: 'original' };
      buffer.add(message);
      
      const drained = buffer.drain();
      drained[0].mutable = 'modified';
      
      buffer.add(message);
      const secondDrain = buffer.drain();
      expect(secondDrain[0].mutable).toBe('original');
    });
  });

  describe('different message types', () => {
    it('should handle various message types', () => {
      const stringMsg = 'simple string';
      const numberMsg = 42;
      const objectMsg = { complex: { nested: 'data' } };
      const arrayMsg = [1, 'two', { three: 3 }];

      buffer.add(stringMsg);
      buffer.add(numberMsg);
      buffer.add(objectMsg);
      buffer.add(arrayMsg);

      const messages = buffer.drain();
      expect(messages[0]).toBe(stringMsg);
      expect(messages[1]).toBe(numberMsg);
      expect(messages[2]).toEqual(objectMsg);
      expect(messages[3]).toEqual(arrayMsg);
    });

    it('should handle null and undefined messages', () => {
      buffer.add(null);
      buffer.add(undefined);
      
      const messages = buffer.drain();
      expect(messages[0]).toBeNull();
      expect(messages[1]).toBeUndefined();
    });
  });

  describe('performance characteristics', () => {
    it('should handle large number of messages', () => {
      const messageCount = 1000;
      
      for (let i = 0; i < messageCount; i++) {
        buffer.add({ id: i, payload: `message-${i}` });
      }
      
      expect(buffer.size()).toBe(messageCount);
      
      const messages = buffer.drain();
      expect(messages).toHaveLength(messageCount);
      expect(messages[0]).toEqual({ id: 0, payload: 'message-0' });
      expect(messages[messageCount - 1]).toEqual({ id: messageCount - 1, payload: `message-${messageCount - 1}` });
      
      expect(buffer.size()).toBe(0);
    });

    it('should efficiently handle rapid add/drain cycles', () => {
      for (let cycle = 0; cycle < 100; cycle++) {
        buffer.add({ cycle, data: `cycle-${cycle}` });
        const drained = buffer.drain();
        expect(drained).toHaveLength(1);
        expect(drained[0].cycle).toBe(cycle);
      }
      
      expect(buffer.size()).toBe(0);
    });
  });
});
