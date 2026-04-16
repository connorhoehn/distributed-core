import { DeliveryTracker, DeliveryReceipt } from '../../../src/resources/distribution/DeliveryTracker';

describe('DeliveryTracker', () => {
  let tracker: DeliveryTracker;

  beforeEach(() => {
    jest.useFakeTimers();
    tracker = new DeliveryTracker({ defaultTimeoutMs: 5000 });
  });

  afterEach(() => {
    tracker.destroy();
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------
  // 1. trackDelivery resolves when all targets ACK
  // ---------------------------------------------------------------
  describe('trackDelivery resolves when all targets ACK', () => {
    test('resolves with all receipts marked as acked', async () => {
      const promise = tracker.trackDelivery('op-1', ['node-a', 'node-b', 'node-c']);

      tracker.receiveAck('op-1', 'node-a');
      tracker.receiveAck('op-1', 'node-b');
      tracker.receiveAck('op-1', 'node-c');

      const receipts = await promise;
      expect(receipts).toHaveLength(3);
      for (const r of receipts) {
        expect(r.status).toBe('acked');
        expect(r.opId).toBe('op-1');
      }
      expect(receipts.map(r => r.nodeId).sort()).toEqual(['node-a', 'node-b', 'node-c']);
    });

    test('resolves immediately when target list is empty', async () => {
      const receipts = await tracker.trackDelivery('op-empty', []);
      expect(receipts).toEqual([]);
    });

    test('resolves for a single-target delivery', async () => {
      const promise = tracker.trackDelivery('op-single', ['node-x']);
      tracker.receiveAck('op-single', 'node-x');
      const receipts = await promise;
      expect(receipts).toHaveLength(1);
      expect(receipts[0].status).toBe('acked');
    });

    test('emits delivery:complete event when all ACKs received', async () => {
      const completeSpy = jest.fn();
      tracker.on('delivery:complete', completeSpy);

      const promise = tracker.trackDelivery('op-evt', ['node-a']);
      tracker.receiveAck('op-evt', 'node-a');
      await promise;

      expect(completeSpy).toHaveBeenCalledTimes(1);
      expect(completeSpy).toHaveBeenCalledWith('op-evt', expect.any(Array));
    });

    test('emits delivery:ack event for each ACK', async () => {
      const ackSpy = jest.fn();
      tracker.on('delivery:ack', ackSpy);

      const promise = tracker.trackDelivery('op-ack-evt', ['node-a', 'node-b']);
      tracker.receiveAck('op-ack-evt', 'node-a');
      tracker.receiveAck('op-ack-evt', 'node-b');
      await promise;

      expect(ackSpy).toHaveBeenCalledTimes(2);
      expect(ackSpy).toHaveBeenCalledWith('op-ack-evt', 'node-a');
      expect(ackSpy).toHaveBeenCalledWith('op-ack-evt', 'node-b');
    });
  });

  // ---------------------------------------------------------------
  // 2. trackDelivery resolves with partial ACKs and timeouts after deadline
  // ---------------------------------------------------------------
  describe('partial ACKs with timeout', () => {
    test('resolves with mix of acked and timeout statuses', async () => {
      const promise = tracker.trackDelivery('op-partial', ['node-a', 'node-b', 'node-c'], 1000);

      tracker.receiveAck('op-partial', 'node-a');
      // node-b and node-c never respond

      jest.advanceTimersByTime(1000);

      const receipts = await promise;
      expect(receipts).toHaveLength(3);

      const acked = receipts.filter(r => r.status === 'acked');
      const timedOut = receipts.filter(r => r.status === 'timeout');
      expect(acked).toHaveLength(1);
      expect(acked[0].nodeId).toBe('node-a');
      expect(timedOut).toHaveLength(2);
      expect(timedOut.map(r => r.nodeId).sort()).toEqual(['node-b', 'node-c']);
    });

    test('emits delivery:timeout event on partial completion', async () => {
      const timeoutSpy = jest.fn();
      tracker.on('delivery:timeout', timeoutSpy);

      const promise = tracker.trackDelivery('op-to', ['node-a', 'node-b'], 500);
      tracker.receiveAck('op-to', 'node-a');

      jest.advanceTimersByTime(500);
      const receipts = await promise;

      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(timeoutSpy).toHaveBeenCalledWith('op-to', receipts);
    });

    test('does not emit delivery:complete when timeout fires first', async () => {
      const completeSpy = jest.fn();
      tracker.on('delivery:complete', completeSpy);

      const promise = tracker.trackDelivery('op-nc', ['node-a'], 500);
      jest.advanceTimersByTime(500);
      await promise;

      expect(completeSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // 3. receiveNack marks receipt as failed
  // ---------------------------------------------------------------
  describe('receiveNack marks receipt as failed', () => {
    test('receipt has failed status and reason', async () => {
      const promise = tracker.trackDelivery('op-nack', ['node-a']);
      tracker.receiveNack('op-nack', 'node-a', 'resource conflict');

      const receipts = await promise;
      expect(receipts).toHaveLength(1);
      expect(receipts[0].status).toBe('failed');
      expect(receipts[0].reason).toBe('resource conflict');
    });

    test('emits delivery:nack event', async () => {
      const nackSpy = jest.fn();
      tracker.on('delivery:nack', nackSpy);

      const promise = tracker.trackDelivery('op-nack2', ['node-a']);
      tracker.receiveNack('op-nack2', 'node-a', 'disk full');
      await promise;

      expect(nackSpy).toHaveBeenCalledWith('op-nack2', 'node-a', 'disk full');
    });

    test('mix of ACKs and NACKs resolves when all respond', async () => {
      const promise = tracker.trackDelivery('op-mix', ['node-a', 'node-b', 'node-c']);

      tracker.receiveAck('op-mix', 'node-a');
      tracker.receiveNack('op-mix', 'node-b', 'error');
      tracker.receiveAck('op-mix', 'node-c');

      const receipts = await promise;
      expect(receipts).toHaveLength(3);

      const byNode = Object.fromEntries(receipts.map(r => [r.nodeId, r]));
      expect(byNode['node-a'].status).toBe('acked');
      expect(byNode['node-b'].status).toBe('failed');
      expect(byNode['node-b'].reason).toBe('error');
      expect(byNode['node-c'].status).toBe('acked');
    });

    test('NACK counts toward completion same as ACK', async () => {
      const completeSpy = jest.fn();
      tracker.on('delivery:complete', completeSpy);

      const promise = tracker.trackDelivery('op-nack-complete', ['node-a']);
      tracker.receiveNack('op-nack-complete', 'node-a', 'rejected');
      await promise;

      expect(completeSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------
  // 4. Timeout fires if no ACK received within timeoutMs
  // ---------------------------------------------------------------
  describe('timeout fires if no ACK received', () => {
    test('all receipts marked timeout when none respond', async () => {
      const promise = tracker.trackDelivery('op-timeout', ['node-a', 'node-b'], 2000);

      jest.advanceTimersByTime(2000);

      const receipts = await promise;
      expect(receipts).toHaveLength(2);
      for (const r of receipts) {
        expect(r.status).toBe('timeout');
      }
    });

    test('uses default timeout when no timeoutMs provided', async () => {
      const promise = tracker.trackDelivery('op-def-to', ['node-a']);

      // Default is 5000ms; advance 4999 -- should not resolve yet
      jest.advanceTimersByTime(4999);
      expect(tracker.pendingCount).toBe(1);

      jest.advanceTimersByTime(1);
      const receipts = await promise;
      expect(receipts[0].status).toBe('timeout');
    });

    test('custom timeoutMs overrides default', async () => {
      const promise = tracker.trackDelivery('op-custom-to', ['node-a'], 100);

      jest.advanceTimersByTime(100);

      const receipts = await promise;
      expect(receipts[0].status).toBe('timeout');
    });

    test('timeout does not fire after all ACKs received', async () => {
      const timeoutSpy = jest.fn();
      tracker.on('delivery:timeout', timeoutSpy);

      const promise = tracker.trackDelivery('op-no-to', ['node-a'], 500);
      tracker.receiveAck('op-no-to', 'node-a');
      await promise;

      // Timer would fire here if it wasn't cleared
      jest.advanceTimersByTime(500);
      expect(timeoutSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // 5. Duplicate ACKs are ignored
  // ---------------------------------------------------------------
  describe('duplicate ACKs are ignored', () => {
    test('second ACK for same node is silently ignored', async () => {
      const ackSpy = jest.fn();
      tracker.on('delivery:ack', ackSpy);

      const promise = tracker.trackDelivery('op-dup', ['node-a']);
      tracker.receiveAck('op-dup', 'node-a');
      tracker.receiveAck('op-dup', 'node-a'); // duplicate -- opId already removed

      const receipts = await promise;
      expect(receipts).toHaveLength(1);
      expect(receipts[0].status).toBe('acked');
      expect(ackSpy).toHaveBeenCalledTimes(1);
    });

    test('duplicate ACK does not double-count toward completion', async () => {
      const promise = tracker.trackDelivery('op-dup2', ['node-a', 'node-b']);

      tracker.receiveAck('op-dup2', 'node-a');
      tracker.receiveAck('op-dup2', 'node-a'); // duplicate, should be ignored

      // Only node-a acked, node-b still pending
      expect(tracker.pendingCount).toBe(1);

      tracker.receiveAck('op-dup2', 'node-b');
      const receipts = await promise;
      expect(receipts.filter(r => r.status === 'acked')).toHaveLength(2);
    });

    test('ACK after NACK for same node is ignored', async () => {
      const promise = tracker.trackDelivery('op-nack-then-ack', ['node-a']);
      tracker.receiveNack('op-nack-then-ack', 'node-a', 'failed');
      tracker.receiveAck('op-nack-then-ack', 'node-a'); // ignored, already resolved

      const receipts = await promise;
      expect(receipts[0].status).toBe('failed');
    });

    test('NACK after ACK for same node is ignored', async () => {
      const promise = tracker.trackDelivery('op-ack-then-nack', ['node-a', 'node-b']);
      tracker.receiveAck('op-ack-then-nack', 'node-a');
      tracker.receiveNack('op-ack-then-nack', 'node-a', 'late error'); // ignored
      tracker.receiveAck('op-ack-then-nack', 'node-b');

      const receipts = await promise;
      const nodeA = receipts.find(r => r.nodeId === 'node-a')!;
      expect(nodeA.status).toBe('acked');
    });
  });

  // ---------------------------------------------------------------
  // 6. ACK for unknown opId is ignored (no crash)
  // ---------------------------------------------------------------
  describe('ACK for unknown opId is ignored', () => {
    test('receiveAck with unknown opId does not throw', () => {
      expect(() => tracker.receiveAck('nonexistent-op', 'node-a')).not.toThrow();
    });

    test('receiveNack with unknown opId does not throw', () => {
      expect(() => tracker.receiveNack('nonexistent-op', 'node-a', 'reason')).not.toThrow();
    });

    test('ACK for unknown nodeId within valid opId is ignored', async () => {
      const promise = tracker.trackDelivery('op-unknown-node', ['node-a']);
      tracker.receiveAck('op-unknown-node', 'node-z'); // not a target
      tracker.receiveAck('op-unknown-node', 'node-a');

      const receipts = await promise;
      expect(receipts).toHaveLength(1);
      expect(receipts[0].nodeId).toBe('node-a');
      expect(receipts[0].status).toBe('acked');
    });

    test('ACK arriving after timeout for same opId is ignored', async () => {
      const promise = tracker.trackDelivery('op-late-ack', ['node-a'], 100);
      jest.advanceTimersByTime(100);
      const receipts = await promise;

      // Late ACK after promise resolved
      expect(() => tracker.receiveAck('op-late-ack', 'node-a')).not.toThrow();
      expect(receipts[0].status).toBe('timeout');
    });
  });

  // ---------------------------------------------------------------
  // 7. pendingCount tracks in-flight deliveries
  // ---------------------------------------------------------------
  describe('pendingCount tracks in-flight deliveries', () => {
    test('starts at zero', () => {
      expect(tracker.pendingCount).toBe(0);
    });

    test('increments for each tracked operation', () => {
      tracker.trackDelivery('op-a', ['node-1']);
      tracker.trackDelivery('op-b', ['node-2']);
      tracker.trackDelivery('op-c', ['node-3']);
      expect(tracker.pendingCount).toBe(3);
    });

    test('decrements when operation completes via ACKs', async () => {
      const p1 = tracker.trackDelivery('op-p1', ['node-a']);
      tracker.trackDelivery('op-p2', ['node-b']);
      expect(tracker.pendingCount).toBe(2);

      tracker.receiveAck('op-p1', 'node-a');
      await p1;
      expect(tracker.pendingCount).toBe(1);
    });

    test('decrements when operation completes via timeout', async () => {
      tracker.trackDelivery('op-to1', ['node-a'], 100);
      tracker.trackDelivery('op-to2', ['node-b'], 200);
      expect(tracker.pendingCount).toBe(2);

      jest.advanceTimersByTime(100);
      expect(tracker.pendingCount).toBe(1);

      jest.advanceTimersByTime(100);
      expect(tracker.pendingCount).toBe(0);
    });

    test('returns zero after all operations complete', async () => {
      const p = tracker.trackDelivery('op-final', ['node-a']);
      tracker.receiveAck('op-final', 'node-a');
      await p;
      expect(tracker.pendingCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // 8. destroy() cleans up all pending timers and rejects outstanding promises
  // ---------------------------------------------------------------
  describe('destroy() cleans up resources', () => {
    test('clears all pending entries', () => {
      tracker.trackDelivery('op-d1', ['node-a']);
      tracker.trackDelivery('op-d2', ['node-b']);
      expect(tracker.pendingCount).toBe(2);

      tracker.destroy();
      expect(tracker.pendingCount).toBe(0);
    });

    test('pending timers do not fire after destroy', () => {
      const timeoutSpy = jest.fn();
      tracker.on('delivery:timeout', timeoutSpy);

      tracker.trackDelivery('op-timer', ['node-a'], 500);
      tracker.destroy();

      jest.advanceTimersByTime(1000);
      expect(timeoutSpy).not.toHaveBeenCalled();
    });

    test('removes all event listeners', () => {
      tracker.on('delivery:ack', jest.fn());
      tracker.on('delivery:nack', jest.fn());
      tracker.on('delivery:complete', jest.fn());
      tracker.on('delivery:timeout', jest.fn());

      tracker.destroy();
      expect(tracker.listenerCount('delivery:ack')).toBe(0);
      expect(tracker.listenerCount('delivery:nack')).toBe(0);
      expect(tracker.listenerCount('delivery:complete')).toBe(0);
      expect(tracker.listenerCount('delivery:timeout')).toBe(0);
    });

    test('ACKs after destroy do not throw', () => {
      tracker.trackDelivery('op-post-destroy', ['node-a']);
      tracker.destroy();

      expect(() => tracker.receiveAck('op-post-destroy', 'node-a')).not.toThrow();
    });

    test('NACKs after destroy do not throw', () => {
      tracker.trackDelivery('op-post-destroy2', ['node-a']);
      tracker.destroy();

      expect(() => tracker.receiveNack('op-post-destroy2', 'node-a', 'reason')).not.toThrow();
    });

    test('can be called multiple times without error', () => {
      expect(() => {
        tracker.destroy();
        tracker.destroy();
      }).not.toThrow();
    });

    test('cancel() removes individual operation', async () => {
      tracker.trackDelivery('op-cancel', ['node-a'], 500);
      expect(tracker.pendingCount).toBe(1);

      tracker.cancel('op-cancel');
      expect(tracker.pendingCount).toBe(0);

      // Timer should not fire
      const timeoutSpy = jest.fn();
      tracker.on('delivery:timeout', timeoutSpy);
      jest.advanceTimersByTime(500);
      expect(timeoutSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // Additional edge cases
  // ---------------------------------------------------------------
  describe('edge cases', () => {
    test('multiple concurrent operations are tracked independently', async () => {
      const p1 = tracker.trackDelivery('op-1', ['node-a', 'node-b']);
      const p2 = tracker.trackDelivery('op-2', ['node-c']);

      tracker.receiveAck('op-2', 'node-c');
      const r2 = await p2;
      expect(r2).toHaveLength(1);
      expect(r2[0].status).toBe('acked');
      expect(tracker.pendingCount).toBe(1);

      tracker.receiveAck('op-1', 'node-a');
      tracker.receiveAck('op-1', 'node-b');
      const r1 = await p1;
      expect(r1).toHaveLength(2);
      expect(r1.every(r => r.status === 'acked')).toBe(true);
    });

    test('receipts contain correct opId', async () => {
      const promise = tracker.trackDelivery('my-op-id', ['node-x']);
      tracker.receiveAck('my-op-id', 'node-x');
      const receipts = await promise;
      expect(receipts[0].opId).toBe('my-op-id');
    });

    test('receipts have timestamp populated', async () => {
      const before = Date.now();
      const promise = tracker.trackDelivery('op-ts', ['node-a']);
      tracker.receiveAck('op-ts', 'node-a');
      const receipts = await promise;
      expect(receipts[0].timestamp).toBeGreaterThanOrEqual(before);
    });

    test('constructor uses default timeout when no options provided', async () => {
      const defaultTracker = new DeliveryTracker();
      const promise = defaultTracker.trackDelivery('op-def', ['node-a']);

      // Default timeout is 5000ms
      jest.advanceTimersByTime(4999);
      expect(defaultTracker.pendingCount).toBe(1);

      jest.advanceTimersByTime(1);
      const receipts = await promise;
      expect(receipts[0].status).toBe('timeout');
      defaultTracker.destroy();
    });
  });
});
