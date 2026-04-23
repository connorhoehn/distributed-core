import { UpdateCoalescer } from '../../../../src/gateway/coalescing/UpdateCoalescer';

describe('UpdateCoalescer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fires onFlush with a single update after the window', async () => {
    const onFlush = jest.fn();
    const coalescer = new UpdateCoalescer<string>({ windowMs: 50, onFlush });

    coalescer.buffer('ch-1', 'update-a');
    expect(onFlush).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(50);
    expect(onFlush).toHaveBeenCalledWith('ch-1', ['update-a']);
  });

  it('batches multiple updates in the same window', async () => {
    const onFlush = jest.fn();
    const coalescer = new UpdateCoalescer<string>({ windowMs: 50, onFlush });

    coalescer.buffer('ch-1', 'a');
    coalescer.buffer('ch-1', 'b');
    coalescer.buffer('ch-1', 'c');

    await jest.advanceTimersByTimeAsync(50);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('ch-1', ['a', 'b', 'c']);
  });

  it('does not open a second window during an active window', async () => {
    const onFlush = jest.fn();
    const coalescer = new UpdateCoalescer<string>({ windowMs: 50, onFlush });

    coalescer.buffer('ch-1', 'a');
    await jest.advanceTimersByTimeAsync(25);

    coalescer.buffer('ch-1', 'b'); // arrives mid-window — same batch
    await jest.advanceTimersByTimeAsync(25);

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('ch-1', ['a', 'b']);
  });

  it('opens a new window for the next update after a flush', async () => {
    const onFlush = jest.fn();
    const coalescer = new UpdateCoalescer<string>({ windowMs: 50, onFlush });

    coalescer.buffer('ch-1', 'first');
    await jest.advanceTimersByTimeAsync(50);
    expect(onFlush).toHaveBeenCalledTimes(1);

    coalescer.buffer('ch-1', 'second');
    await jest.advanceTimersByTimeAsync(50);
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenNthCalledWith(2, 'ch-1', ['second']);
  });

  it('flush() triggers immediate delivery and clears the timer', async () => {
    const onFlush = jest.fn();
    const coalescer = new UpdateCoalescer<string>({ windowMs: 50, onFlush });

    coalescer.buffer('ch-1', 'a');
    coalescer.buffer('ch-1', 'b');
    coalescer.flush('ch-1');

    expect(onFlush).toHaveBeenCalledWith('ch-1', ['a', 'b']);

    // No second call after window would have elapsed
    await jest.advanceTimersByTimeAsync(100);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('flush() on an empty key is a no-op', () => {
    const onFlush = jest.fn();
    const coalescer = new UpdateCoalescer<string>({ windowMs: 50, onFlush });
    expect(() => coalescer.flush('nonexistent')).not.toThrow();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('flushAll() flushes every pending key', async () => {
    const onFlush = jest.fn();
    const coalescer = new UpdateCoalescer<string>({ windowMs: 200, onFlush });

    coalescer.buffer('ch-1', 'a');
    coalescer.buffer('ch-2', 'b');
    coalescer.buffer('ch-3', 'c');

    coalescer.flushAll();

    expect(onFlush).toHaveBeenCalledTimes(3);
    expect(onFlush).toHaveBeenCalledWith('ch-1', ['a']);
    expect(onFlush).toHaveBeenCalledWith('ch-2', ['b']);
    expect(onFlush).toHaveBeenCalledWith('ch-3', ['c']);

    // No timer fires after flushAll
    await jest.advanceTimersByTimeAsync(300);
    expect(onFlush).toHaveBeenCalledTimes(3);
  });

  it('cancel() discards buffered updates without calling onFlush', async () => {
    const onFlush = jest.fn();
    const coalescer = new UpdateCoalescer<string>({ windowMs: 50, onFlush });

    coalescer.buffer('ch-1', 'a');
    coalescer.cancel('ch-1');

    await jest.advanceTimersByTimeAsync(100);
    expect(onFlush).not.toHaveBeenCalled();
    expect(coalescer.pendingCount).toBe(0);
  });

  it('cancelAll() discards all buffers without calling onFlush', async () => {
    const onFlush = jest.fn();
    const coalescer = new UpdateCoalescer<string>({ windowMs: 50, onFlush });

    coalescer.buffer('ch-1', 'a');
    coalescer.buffer('ch-2', 'b');
    coalescer.cancelAll();

    await jest.advanceTimersByTimeAsync(100);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('applies the merge function before handing updates to onFlush', async () => {
    const onFlush = jest.fn();
    const merge = jest.fn((updates: number[]) => [updates.reduce((a, b) => a + b, 0)]);
    const coalescer = new UpdateCoalescer<number>({ windowMs: 50, onFlush, merge });

    coalescer.buffer('ch-1', 1);
    coalescer.buffer('ch-1', 2);
    coalescer.buffer('ch-1', 3);

    await jest.advanceTimersByTimeAsync(50);
    expect(merge).toHaveBeenCalledWith([1, 2, 3]);
    expect(onFlush).toHaveBeenCalledWith('ch-1', [6]);
  });

  it('independent keys do not interfere with each other', async () => {
    const onFlush = jest.fn();
    const coalescer = new UpdateCoalescer<string>({ windowMs: 50, onFlush });

    coalescer.buffer('ch-1', 'a');
    coalescer.buffer('ch-2', 'x');
    coalescer.flush('ch-1');

    expect(onFlush).toHaveBeenCalledWith('ch-1', ['a']);

    await jest.advanceTimersByTimeAsync(50);
    expect(onFlush).toHaveBeenCalledWith('ch-2', ['x']);
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it('pendingCount tracks only keys with buffered updates', () => {
    const coalescer = new UpdateCoalescer<string>({ windowMs: 50, onFlush: jest.fn() });
    expect(coalescer.pendingCount).toBe(0);

    coalescer.buffer('a', 'x');
    coalescer.buffer('b', 'y');
    expect(coalescer.pendingCount).toBe(2);

    coalescer.flush('a');
    expect(coalescer.pendingCount).toBe(1);
  });

  it('pendingUpdatesFor returns count per key', () => {
    const coalescer = new UpdateCoalescer<string>({ windowMs: 50, onFlush: jest.fn() });
    expect(coalescer.pendingUpdatesFor('ch-1')).toBe(0);

    coalescer.buffer('ch-1', 'a');
    coalescer.buffer('ch-1', 'b');
    expect(coalescer.pendingUpdatesFor('ch-1')).toBe(2);
    expect(coalescer.pendingUpdatesFor('ch-2')).toBe(0);
  });
});
