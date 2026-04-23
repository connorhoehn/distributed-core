import { EventEmitter } from 'events';
import { ClusterCompactionBridge } from '../../../../src/persistence/compaction/ClusterCompactionBridge';
import { CompactionCoordinator } from '../../../../src/persistence/compaction/CompactionCoordinator';

// Mock CompactionCoordinator — never instantiate the real one
const mockCoordinator = {
  triggerCompactionCheck: jest.fn().mockResolvedValue(null),
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
} as unknown as CompactionCoordinator;

describe('ClusterCompactionBridge', () => {
  let cluster: EventEmitter;
  let bridge: ClusterCompactionBridge;

  beforeEach(() => {
    jest.useFakeTimers();
    (mockCoordinator.triggerCompactionCheck as jest.Mock).mockClear();
    cluster = new EventEmitter();
    bridge = new ClusterCompactionBridge(cluster, mockCoordinator, { debounceMs: 500 });
  });

  afterEach(() => {
    bridge.detach();
    jest.useRealTimers();
  });

  // ── attach / detach ──────────────────────────────────────────────────────────

  describe('attach() / detach()', () => {
    test('isAttached() returns false before attach()', () => {
      expect(bridge.isAttached()).toBe(false);
    });

    test('isAttached() returns true after attach()', () => {
      bridge.attach();
      expect(bridge.isAttached()).toBe(true);
    });

    test('isAttached() returns false after detach()', () => {
      bridge.attach();
      bridge.detach();
      expect(bridge.isAttached()).toBe(false);
    });

    test('calling attach() twice is idempotent — no duplicate listeners', () => {
      bridge.attach();
      bridge.attach();
      // If listeners were doubled, one event would schedule two timers and produce
      // two triggerCompactionCheck calls; with deduplication there is exactly one.
      cluster.emit('member-joined', { id: 'node-1' });
      jest.runAllTimers();
      expect(mockCoordinator.triggerCompactionCheck).toHaveBeenCalledTimes(1);
    });

    test('calling detach() before attach() is safe — no error thrown', () => {
      expect(() => bridge.detach()).not.toThrow();
    });
  });

  // ── member-joined ────────────────────────────────────────────────────────────

  describe('member-joined event', () => {
    test('emitting member-joined after attach() eventually calls triggerCompactionCheck()', async () => {
      bridge.attach();
      cluster.emit('member-joined', { id: 'node-1' });
      await jest.advanceTimersByTimeAsync(600);
      expect(mockCoordinator.triggerCompactionCheck).toHaveBeenCalledTimes(1);
    });

    test('emitting member-joined before attach() does NOT call triggerCompactionCheck()', async () => {
      cluster.emit('member-joined', { id: 'node-1' });
      await jest.advanceTimersByTimeAsync(600);
      expect(mockCoordinator.triggerCompactionCheck).not.toHaveBeenCalled();
    });

    test('after detach(), emitting member-joined does NOT call triggerCompactionCheck()', async () => {
      bridge.attach();
      bridge.detach();
      cluster.emit('member-joined', { id: 'node-1' });
      await jest.advanceTimersByTimeAsync(600);
      expect(mockCoordinator.triggerCompactionCheck).not.toHaveBeenCalled();
    });
  });

  // ── member-left ──────────────────────────────────────────────────────────────

  describe('member-left event', () => {
    test('emitting member-left after attach() eventually calls triggerCompactionCheck()', async () => {
      bridge.attach();
      cluster.emit('member-left', 'node-1');
      await jest.advanceTimersByTimeAsync(600);
      expect(mockCoordinator.triggerCompactionCheck).toHaveBeenCalledTimes(1);
    });

    test('emitting member-left before attach() does NOT call triggerCompactionCheck()', async () => {
      cluster.emit('member-left', 'node-1');
      await jest.advanceTimersByTimeAsync(600);
      expect(mockCoordinator.triggerCompactionCheck).not.toHaveBeenCalled();
    });

    test('after detach(), emitting member-left does NOT call triggerCompactionCheck()', async () => {
      bridge.attach();
      bridge.detach();
      cluster.emit('member-left', 'node-1');
      await jest.advanceTimersByTimeAsync(600);
      expect(mockCoordinator.triggerCompactionCheck).not.toHaveBeenCalled();
    });
  });

  // ── membership-updated ───────────────────────────────────────────────────────

  describe('membership-updated event', () => {
    test('NOT triggered by default (triggerOnMembershipUpdate defaults to false)', async () => {
      bridge.attach();
      cluster.emit('membership-updated', new Map());
      await jest.advanceTimersByTimeAsync(600);
      expect(mockCoordinator.triggerCompactionCheck).not.toHaveBeenCalled();
    });

    test('IS triggered when triggerOnMembershipUpdate: true is configured', async () => {
      const bridge2 = new ClusterCompactionBridge(cluster, mockCoordinator, {
        debounceMs: 500,
        triggerOnMembershipUpdate: true,
      });
      bridge2.attach();
      cluster.emit('membership-updated', new Map());
      await jest.advanceTimersByTimeAsync(600);
      expect(mockCoordinator.triggerCompactionCheck).toHaveBeenCalledTimes(1);
      bridge2.detach();
    });
  });

  // ── debounce ─────────────────────────────────────────────────────────────────

  describe('debounce', () => {
    test('multiple rapid member-joined events coalesce into a single triggerCompactionCheck()', async () => {
      bridge.attach();
      cluster.emit('member-joined', { id: 'node-1' });
      cluster.emit('member-joined', { id: 'node-2' });
      cluster.emit('member-joined', { id: 'node-3' });
      await jest.advanceTimersByTimeAsync(600);
      expect(mockCoordinator.triggerCompactionCheck).toHaveBeenCalledTimes(1);
    });

    test('after debounce resolves, a new event starts a fresh debounce window', async () => {
      bridge.attach();
      cluster.emit('member-joined', { id: 'node-1' });
      await jest.advanceTimersByTimeAsync(600);
      expect(mockCoordinator.triggerCompactionCheck).toHaveBeenCalledTimes(1);

      // New event after the first window has closed
      cluster.emit('member-joined', { id: 'node-2' });
      await jest.advanceTimersByTimeAsync(600);
      expect(mockCoordinator.triggerCompactionCheck).toHaveBeenCalledTimes(2);
    });
  });

  // ── error handling ───────────────────────────────────────────────────────────

  describe('error handling', () => {
    test('if triggerCompactionCheck() throws, the handler does NOT propagate the error', async () => {
      (mockCoordinator.triggerCompactionCheck as jest.Mock).mockRejectedValueOnce(
        new Error('compaction error')
      );
      bridge.attach();
      cluster.emit('member-joined', { id: 'node-1' });

      // Advance the debounce timer — should not throw even though coordinator throws
      let caughtError: unknown;
      try {
        await jest.advanceTimersByTimeAsync(600);
      } catch (err) {
        caughtError = err;
      }
      expect(caughtError).toBeUndefined();
      expect(mockCoordinator.triggerCompactionCheck).toHaveBeenCalledTimes(1);
    });
  });

  // ── config options ────────────────────────────────────────────────────────────

  describe('config options', () => {
    test('triggerOnMemberJoin: false disables join trigger', async () => {
      const bridge2 = new ClusterCompactionBridge(cluster, mockCoordinator, {
        debounceMs: 500,
        triggerOnMemberJoin: false,
      });
      bridge2.attach();
      cluster.emit('member-joined', { id: 'node-1' });
      await jest.advanceTimersByTimeAsync(600);
      expect(mockCoordinator.triggerCompactionCheck).not.toHaveBeenCalled();
      bridge2.detach();
    });

    test('triggerOnMemberLeave: false disables leave trigger', async () => {
      const bridge2 = new ClusterCompactionBridge(cluster, mockCoordinator, {
        debounceMs: 500,
        triggerOnMemberLeave: false,
      });
      bridge2.attach();
      cluster.emit('member-left', 'node-1');
      await jest.advanceTimersByTimeAsync(600);
      expect(mockCoordinator.triggerCompactionCheck).not.toHaveBeenCalled();
      bridge2.detach();
    });

    test('custom debounceMs is respected', async () => {
      const bridge2 = new ClusterCompactionBridge(cluster, mockCoordinator, { debounceMs: 1000 });
      bridge2.attach();
      cluster.emit('member-joined', { id: 'node-1' });

      // Should not fire before 1000 ms
      await jest.advanceTimersByTimeAsync(800);
      expect(mockCoordinator.triggerCompactionCheck).not.toHaveBeenCalled();

      // Should fire after the full 1000 ms
      await jest.advanceTimersByTimeAsync(300);
      expect(mockCoordinator.triggerCompactionCheck).toHaveBeenCalledTimes(1);
      bridge2.detach();
    });
  });
});
