import {
  CoreError,
  NotStartedError,
  AlreadyStartedError,
  ConflictError,
  TimeoutError,
} from '../../../src/common/errors';

describe('CoreError', () => {
  it('sets name, code, and message', () => {
    const err = new CoreError('test-code', 'test message');
    expect(err.name).toBe('CoreError');
    expect(err.code).toBe('test-code');
    expect(err.message).toBe('test message');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof CoreError).toBe(true);
  });
});

describe('NotStartedError', () => {
  it('has code not-started and correct message', () => {
    const err = new NotStartedError('ResourceRouter');
    expect(err instanceof CoreError).toBe(true);
    expect(err instanceof NotStartedError).toBe(true);
    expect(err.code).toBe('not-started');
    expect(err.name).toBe('NotStartedError');
    expect(err.message).toContain('ResourceRouter');
    expect(err.message).toContain('start()');
  });
});

describe('AlreadyStartedError', () => {
  it('has code already-started and correct message', () => {
    const err = new AlreadyStartedError('EventBus');
    expect(err instanceof CoreError).toBe(true);
    expect(err instanceof AlreadyStartedError).toBe(true);
    expect(err.code).toBe('already-started');
    expect(err.name).toBe('AlreadyStartedError');
    expect(err.message).toContain('EventBus');
  });
});

describe('ConflictError', () => {
  it('has code conflict and basic message', () => {
    const err = new ConflictError('my-resource');
    expect(err instanceof CoreError).toBe(true);
    expect(err.code).toBe('conflict');
    expect(err.name).toBe('ConflictError');
    expect(err.message).toContain('my-resource');
  });

  it('includes detail when provided', () => {
    const err = new ConflictError('my-resource', 'already owned');
    expect(err.message).toContain('my-resource');
    expect(err.message).toContain('already owned');
  });
});

describe('TimeoutError (from common/errors)', () => {
  it('has code timeout and correct message', () => {
    const err = new TimeoutError('acquireLock', 5000);
    expect(err instanceof CoreError).toBe(true);
    expect(err instanceof TimeoutError).toBe(true);
    expect(err.code).toBe('timeout');
    expect(err.name).toBe('TimeoutError');
    expect(err.message).toContain('acquireLock');
    expect(err.message).toContain('5000');
  });
});
