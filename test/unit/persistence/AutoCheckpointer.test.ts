import { AutoCheckpointer, AutoCheckpointerConfig, SnapshotProvider } from '../../../src/persistence/checkpoint/AutoCheckpointer';
import { WALWriterImpl, WALAppendListener } from '../../../src/persistence/wal/WALWriter';
import { CheckpointWriter, EntityState } from '../../../src/persistence/checkpoint/types';

// Minimal mock for WALWriterImpl — only onAppend matters
function createMockWALWriter() {
  const listeners: WALAppendListener[] = [];
  const mock = {
    onAppend: jest.fn((listener: WALAppendListener) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    // Helper to simulate an append from the outside
    simulateAppend(lsn: number) {
      for (const l of listeners) l(lsn);
    },
    listeners,
  };
  return mock as unknown as WALWriterImpl & { simulateAppend: (lsn: number) => void; listeners: WALAppendListener[] };
}

function createMockCheckpointWriter() {
  return {
    writeSnapshot: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<CheckpointWriter>;
}

function createSnapshotProvider(lsn: number = 42): SnapshotProvider {
  return () => ({
    lsn,
    entities: {
      'e1': { id: 'e1', type: 'test', data: {}, version: 1, hostNodeId: 'n1', lastModified: Date.now() },
    },
  });
}

describe('AutoCheckpointer', () => {
  let walWriter: ReturnType<typeof createMockWALWriter>;
  let checkpointWriter: jest.Mocked<CheckpointWriter>;
  let snapshotProvider: SnapshotProvider;

  beforeEach(() => {
    walWriter = createMockWALWriter();
    checkpointWriter = createMockCheckpointWriter();
    snapshotProvider = createSnapshotProvider(100);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('should trigger checkpoint after N writes (lsnThreshold)', async () => {
    const auto = new AutoCheckpointer(walWriter, checkpointWriter, snapshotProvider, {
      lsnThreshold: 5,
    });
    auto.start();

    // 4 appends — should NOT trigger
    for (let i = 1; i <= 4; i++) {
      walWriter.simulateAppend(i);
    }
    // Wait for any microtasks
    await new Promise(r => setTimeout(r, 0));
    expect(checkpointWriter.writeSnapshot).not.toHaveBeenCalled();

    // 5th append — should trigger
    walWriter.simulateAppend(5);
    await new Promise(r => setTimeout(r, 0));
    expect(checkpointWriter.writeSnapshot).toHaveBeenCalledTimes(1);
    expect(checkpointWriter.writeSnapshot).toHaveBeenCalledWith(100, expect.any(Object));

    // Counter resets — need another 5 to trigger again
    for (let i = 6; i <= 9; i++) {
      walWriter.simulateAppend(i);
    }
    await new Promise(r => setTimeout(r, 0));
    expect(checkpointWriter.writeSnapshot).toHaveBeenCalledTimes(1);

    walWriter.simulateAppend(10);
    await new Promise(r => setTimeout(r, 0));
    expect(checkpointWriter.writeSnapshot).toHaveBeenCalledTimes(2);

    auto.stop();
  });

  test('should not trigger checkpoint if threshold is 0 (disabled)', async () => {
    const auto = new AutoCheckpointer(walWriter, checkpointWriter, snapshotProvider, {
      lsnThreshold: 0,
    });
    auto.start();

    for (let i = 1; i <= 20; i++) {
      walWriter.simulateAppend(i);
    }
    await new Promise(r => setTimeout(r, 0));
    expect(checkpointWriter.writeSnapshot).not.toHaveBeenCalled();

    auto.stop();
  });

  test('should trigger checkpoint on time interval', async () => {
    jest.useFakeTimers();

    const auto = new AutoCheckpointer(walWriter, checkpointWriter, snapshotProvider, {
      lsnThreshold: 0,
      intervalMs: 1000,
    });
    auto.start();

    // Simulate some appends so appendsSinceCheckpoint > 0
    // Since lsnThreshold is 0, we won't subscribe to appends —
    // but intervalMs still needs appends to have happened.
    // We need to manually bump the counter via a small threshold trick.
    // Actually: with lsnThreshold=0, no listener is registered, so
    // appendsSinceCheckpoint stays 0 and interval won't trigger.
    // This is by design — interval only fires if there were appends.
    // Let's test with both enabled.
    auto.stop();

    const auto2 = new AutoCheckpointer(walWriter, checkpointWriter, snapshotProvider, {
      lsnThreshold: 9999, // high threshold so it doesn't trigger from appends alone
      intervalMs: 1000,
    });
    auto2.start();

    // Simulate 3 appends (below threshold)
    walWriter.simulateAppend(1);
    walWriter.simulateAppend(2);
    walWriter.simulateAppend(3);

    expect(checkpointWriter.writeSnapshot).not.toHaveBeenCalled();

    // Advance past the interval
    jest.advanceTimersByTime(1001);
    // The interval callback calls triggerCheckpoint which is async
    await Promise.resolve();
    await Promise.resolve();

    expect(checkpointWriter.writeSnapshot).toHaveBeenCalledTimes(1);

    auto2.stop();
  });

  test('stop() unsubscribes from WAL events', () => {
    const auto = new AutoCheckpointer(walWriter, checkpointWriter, snapshotProvider, {
      lsnThreshold: 5,
    });
    auto.start();
    expect(walWriter.listeners.length).toBe(1);

    auto.stop();
    expect(walWriter.listeners.length).toBe(0);
  });

  test('start() is idempotent', () => {
    const auto = new AutoCheckpointer(walWriter, checkpointWriter, snapshotProvider, {
      lsnThreshold: 5,
    });
    auto.start();
    auto.start(); // second call should be a no-op
    expect(walWriter.listeners.length).toBe(1);
    auto.stop();
  });

  test('getAppendsSinceCheckpoint tracks count', async () => {
    const auto = new AutoCheckpointer(walWriter, checkpointWriter, snapshotProvider, {
      lsnThreshold: 10,
    });
    auto.start();

    walWriter.simulateAppend(1);
    walWriter.simulateAppend(2);
    walWriter.simulateAppend(3);

    expect(auto.getAppendsSinceCheckpoint()).toBe(3);

    auto.stop();
  });

  test('triggerCheckpoint can be called manually', async () => {
    const auto = new AutoCheckpointer(walWriter, checkpointWriter, snapshotProvider, {
      lsnThreshold: 0,
    });

    await auto.triggerCheckpoint();
    expect(checkpointWriter.writeSnapshot).toHaveBeenCalledTimes(1);
  });

  test('isRunning reflects lifecycle', () => {
    const auto = new AutoCheckpointer(walWriter, checkpointWriter, snapshotProvider);
    expect(auto.isRunning()).toBe(false);
    auto.start();
    expect(auto.isRunning()).toBe(true);
    auto.stop();
    expect(auto.isRunning()).toBe(false);
  });
});
