import {
  CoreError,
  NotStartedError,
  AlreadyStartedError,
  ConflictError,
  TimeoutError,
  InvalidTransferTargetError,
  NotOwnedError,
  SessionNotLocalError,
  WalNotConfiguredError,
  RemoteOwnerError,
  LocalResourceError,
  UnroutableResourceError,
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

// ---------------------------------------------------------------------------
// New subclasses — sanity suite
// ---------------------------------------------------------------------------

describe('InvalidTransferTargetError', () => {
  it('is a CoreError with stable code and message containing targetNodeId', () => {
    const err = new InvalidTransferTargetError('node-dead');
    expect(err instanceof CoreError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.code).toBe('invalid-transfer-target');
    expect(err.code).toBeTruthy();
    expect(err.name).toBe('InvalidTransferTargetError');
    expect(err.targetNodeId).toBe('node-dead');
    expect(err.message).toContain('node-dead');
    expect(err.message).toContain('alive membership');
  });
});

describe('NotOwnedError', () => {
  it('is a CoreError with stable code and message containing lockId', () => {
    const err = new NotOwnedError('my-lock');
    expect(err instanceof CoreError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.code).toBe('not-owned');
    expect(err.code).toBeTruthy();
    expect(err.name).toBe('NotOwnedError');
    expect(err.lockId).toBe('my-lock');
    expect(err.message).toContain('my-lock');
  });
});

describe('SessionNotLocalError', () => {
  it('is a CoreError with stable code and message containing sessionId', () => {
    const err = new SessionNotLocalError('sess-123');
    expect(err instanceof CoreError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.code).toBe('session-not-local');
    expect(err.code).toBeTruthy();
    expect(err.name).toBe('SessionNotLocalError');
    expect(err.sessionId).toBe('sess-123');
    expect(err.message).toContain('sess-123');
  });
});

describe('WalNotConfiguredError', () => {
  it('is a CoreError with stable code and message containing operation', () => {
    const err = new WalNotConfiguredError('replay events');
    expect(err instanceof CoreError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.code).toBe('wal-not-configured');
    expect(err.code).toBeTruthy();
    expect(err.name).toBe('WalNotConfiguredError');
    expect(err.message).toContain('replay events');
    expect(err.message).toContain('WAL not configured');
  });
});

describe('RemoteOwnerError', () => {
  it('is a CoreError with stable code and message containing connectionId and remoteNodeId', () => {
    const err = new RemoteOwnerError('conn-abc', 'node-remote');
    expect(err instanceof CoreError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.code).toBe('remote-owner');
    expect(err.code).toBeTruthy();
    expect(err.name).toBe('RemoteOwnerError');
    expect(err.connectionId).toBe('conn-abc');
    expect(err.remoteNodeId).toBe('node-remote');
    expect(err.message).toContain('conn-abc');
    expect(err.message).toContain('node-remote');
  });
});

describe('LocalResourceError', () => {
  it('is a CoreError with stable code and message containing resourceId', () => {
    const err = new LocalResourceError('res-1');
    expect(err instanceof CoreError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.code).toBe('local-resource');
    expect(err.code).toBeTruthy();
    expect(err.name).toBe('LocalResourceError');
    expect(err.resourceId).toBe('res-1');
    expect(err.message).toContain('res-1');
    expect(err.message).toContain('local node');
  });
});

describe('UnroutableResourceError', () => {
  it('is a CoreError with stable code and message containing resourceId', () => {
    const err = new UnroutableResourceError('res-2');
    expect(err instanceof CoreError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.code).toBe('unroutable-resource');
    expect(err.code).toBeTruthy();
    expect(err.name).toBe('UnroutableResourceError');
    expect(err.resourceId).toBe('res-2');
    expect(err.message).toContain('res-2');
  });
});
