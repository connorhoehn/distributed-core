import { EvictionTimer } from '../../../../src/gateway/eviction/EvictionTimer';

describe('EvictionTimer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('calls the callback after the configured delay', async () => {
    const timer = new EvictionTimer<string>(500);
    const cb = jest.fn();

    timer.schedule('ch-1', cb);
    expect(cb).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(500);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('ch-1');
  });

  it('removes the key from pending after firing', async () => {
    const timer = new EvictionTimer<string>(100);
    timer.schedule('ch-1', jest.fn());
    expect(timer.pendingCount).toBe(1);

    await jest.advanceTimersByTimeAsync(100);
    expect(timer.pendingCount).toBe(0);
  });

  it('cancel prevents the callback from firing', async () => {
    const timer = new EvictionTimer<string>(500);
    const cb = jest.fn();

    timer.schedule('ch-1', cb);
    timer.cancel('ch-1');

    await jest.advanceTimersByTimeAsync(600);
    expect(cb).not.toHaveBeenCalled();
    expect(timer.pendingCount).toBe(0);
  });

  it('cancel is a no-op for keys that are not scheduled', () => {
    const timer = new EvictionTimer<string>(100);
    expect(() => timer.cancel('nonexistent')).not.toThrow();
  });

  it('re-scheduling a key resets the timer', async () => {
    const timer = new EvictionTimer<string>(500);
    const cb = jest.fn();

    timer.schedule('ch-1', cb);
    await jest.advanceTimersByTimeAsync(300);

    // Reschedule — clock should restart from 0
    timer.schedule('ch-1', cb);
    await jest.advanceTimersByTimeAsync(300);
    expect(cb).not.toHaveBeenCalled(); // 300ms into new window

    await jest.advanceTimersByTimeAsync(200);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('re-scheduling replaces the callback', async () => {
    const timer = new EvictionTimer<string>(200);
    const first = jest.fn();
    const second = jest.fn();

    timer.schedule('ch-1', first);
    timer.schedule('ch-1', second);

    await jest.advanceTimersByTimeAsync(200);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('cancelAll clears every pending timer', async () => {
    const timer = new EvictionTimer<string>(500);
    const cbs = [jest.fn(), jest.fn(), jest.fn()];

    timer.schedule('a', cbs[0]);
    timer.schedule('b', cbs[1]);
    timer.schedule('c', cbs[2]);
    expect(timer.pendingCount).toBe(3);

    timer.cancelAll();
    expect(timer.pendingCount).toBe(0);

    await jest.advanceTimersByTimeAsync(600);
    cbs.forEach((cb) => expect(cb).not.toHaveBeenCalled());
  });

  it('isScheduled returns true only while timer is pending', async () => {
    const timer = new EvictionTimer<string>(200);
    timer.schedule('ch-1', jest.fn());

    expect(timer.isScheduled('ch-1')).toBe(true);
    expect(timer.isScheduled('ch-2')).toBe(false);

    await jest.advanceTimersByTimeAsync(200);
    expect(timer.isScheduled('ch-1')).toBe(false);
  });

  it('pendingCount tracks multiple independent keys', () => {
    const timer = new EvictionTimer<string>(1000);
    expect(timer.pendingCount).toBe(0);

    timer.schedule('a', jest.fn());
    timer.schedule('b', jest.fn());
    expect(timer.pendingCount).toBe(2);

    timer.cancel('a');
    expect(timer.pendingCount).toBe(1);
  });

  it('supports async callbacks', async () => {
    const timer = new EvictionTimer<string>(100);
    let resolved = false;
    const asyncCb = async (_key: string) => {
      await Promise.resolve();
      resolved = true;
    };

    timer.schedule('ch-1', asyncCb);
    await jest.advanceTimersByTimeAsync(100);
    // Flush microtasks
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it('works with numeric keys', async () => {
    const timer = new EvictionTimer<number>(100);
    const cb = jest.fn();
    timer.schedule(42, cb);
    await jest.advanceTimersByTimeAsync(100);
    expect(cb).toHaveBeenCalledWith(42);
  });
});
