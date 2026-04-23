import { BackpressureController } from '../../../../src/gateway/backpressure/BackpressureController';
import { RateLimiter } from '../../../../src/common/RateLimiter';

describe('BackpressureController', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('enqueue returns { accepted: true, dropped: 0 } under normal conditions', () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 10,
      strategy: 'reject',
    });

    const result = ctrl.enqueue('key1', 'item1');
    expect(result).toEqual({ accepted: true, dropped: 0 });
    expect(ctrl.getQueueDepth('key1')).toBe(1);
  });

  it('flush calls onFlush with queued items and clears the queue', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 10,
      strategy: 'reject',
    });

    ctrl.enqueue('key1', 'a');
    ctrl.enqueue('key1', 'b');
    await ctrl.flush('key1');

    expect(onFlush).toHaveBeenCalledWith('key1', ['a', 'b']);
    expect(ctrl.getQueueDepth('key1')).toBe(0);
  });

  it('flushAll flushes all keys', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 10,
      strategy: 'reject',
    });

    ctrl.enqueue('key1', 'a');
    ctrl.enqueue('key2', 'b');
    await ctrl.flushAll();

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenCalledWith('key1', ['a']);
    expect(onFlush).toHaveBeenCalledWith('key2', ['b']);
    expect(ctrl.getQueueDepth('key1')).toBe(0);
    expect(ctrl.getQueueDepth('key2')).toBe(0);
  });

  it('drain empties all queues', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 10,
      strategy: 'reject',
    });

    ctrl.enqueue('key1', 'x');
    ctrl.enqueue('key2', 'y');
    await ctrl.drain();

    expect(ctrl.getQueueDepth('key1')).toBe(0);
    expect(ctrl.getQueueDepth('key2')).toBe(0);
  });

  it("strategy 'drop-oldest' drops oldest item and accepts the new one when full", () => {
    const onDrop = jest.fn();
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 2,
      strategy: 'drop-oldest',
      onDrop,
    });

    ctrl.enqueue('k', 'first');
    ctrl.enqueue('k', 'second');
    const result = ctrl.enqueue('k', 'third');

    expect(result).toEqual({ accepted: true, dropped: 1 });
    expect(onDrop).toHaveBeenCalledWith('k', 'first');
    expect(ctrl.getQueueDepth('k')).toBe(2);
  });

  it("strategy 'drop-newest' rejects the new item when full", () => {
    const onDrop = jest.fn();
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 2,
      strategy: 'drop-newest',
      onDrop,
    });

    ctrl.enqueue('k', 'first');
    ctrl.enqueue('k', 'second');
    const result = ctrl.enqueue('k', 'third');

    expect(result).toEqual({ accepted: false, dropped: 1 });
    expect(onDrop).toHaveBeenCalledWith('k', 'third');
    expect(ctrl.getQueueDepth('k')).toBe(2);
  });

  it("strategy 'reject' returns accepted:false with no drop when full", () => {
    const onDrop = jest.fn();
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 2,
      strategy: 'reject',
      onDrop,
    });

    ctrl.enqueue('k', 'first');
    ctrl.enqueue('k', 'second');
    const result = ctrl.enqueue('k', 'third');

    expect(result).toEqual({ accepted: false, dropped: 0 });
    expect(onDrop).not.toHaveBeenCalled();
    expect(ctrl.getQueueDepth('k')).toBe(2);
  });

  it('onDrop callback is called for every dropped item', () => {
    const onDrop = jest.fn();
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 1,
      strategy: 'drop-oldest',
      onDrop,
    });

    ctrl.enqueue('k', 'a');
    ctrl.enqueue('k', 'b');
    ctrl.enqueue('k', 'c');

    expect(onDrop).toHaveBeenCalledTimes(2);
    expect(onDrop).toHaveBeenNthCalledWith(1, 'k', 'a');
    expect(onDrop).toHaveBeenNthCalledWith(2, 'k', 'b');
  });

  it('RateLimiter integration — rejected by limiter returns { accepted: false, dropped: 0 }', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 10,
      strategy: 'reject',
      rateLimiter: limiter,
    });

    const first = ctrl.enqueue('k', 'allowed');
    expect(first).toEqual({ accepted: true, dropped: 0 });

    const second = ctrl.enqueue('k', 'blocked');
    expect(second).toEqual({ accepted: false, dropped: 0 });
    expect(ctrl.getQueueDepth('k')).toBe(1);
  });

  it('auto-flush timer fires and calls onFlush', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 10,
      strategy: 'reject',
      flushIntervalMs: 100,
    });

    ctrl.enqueue('k', 'item');
    ctrl.start();

    await jest.advanceTimersByTimeAsync(100);

    expect(onFlush).toHaveBeenCalledWith('k', ['item']);
    ctrl.stop();
  });

  it('stop() clears the auto-flush timer', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 10,
      strategy: 'reject',
      flushIntervalMs: 100,
    });

    ctrl.enqueue('k', 'item');
    ctrl.start();
    ctrl.stop();

    await jest.advanceTimersByTimeAsync(200);

    expect(onFlush).not.toHaveBeenCalled();
  });

  it('getStats returns correct totalEnqueued, totalFlushed, totalDropped', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 2,
      strategy: 'drop-oldest',
    });

    ctrl.enqueue('k', 'a');
    ctrl.enqueue('k', 'b');
    ctrl.enqueue('k', 'c');
    await ctrl.flush('k');

    const stats = ctrl.getStats();
    expect(stats.totalEnqueued).toBe(3);
    expect(stats.totalFlushed).toBe(2);
    expect(stats.totalDropped).toBe(1);
  });

  it('getQueueDepth reflects current queue state', () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 10,
      strategy: 'reject',
    });

    expect(ctrl.getQueueDepth('k')).toBe(0);
    ctrl.enqueue('k', 'x');
    expect(ctrl.getQueueDepth('k')).toBe(1);
    ctrl.enqueue('k', 'y');
    expect(ctrl.getQueueDepth('k')).toBe(2);
  });

  it('onFlush error causes items to be re-queued', async () => {
    let callCount = 0;
    const onFlush = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('flush failed');
    });

    const ctrl = new BackpressureController<string>(onFlush, {
      maxQueueSize: 10,
      strategy: 'reject',
    });

    ctrl.enqueue('k', 'a');
    ctrl.enqueue('k', 'b');

    await expect(ctrl.flush('k')).rejects.toThrow('flush failed');
    expect(ctrl.getQueueDepth('k')).toBe(2);

    await ctrl.flush('k');
    expect(ctrl.getQueueDepth('k')).toBe(0);
  });
});
