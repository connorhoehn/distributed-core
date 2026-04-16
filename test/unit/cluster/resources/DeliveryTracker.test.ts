import { DeliveryTracker, DeliveryReceipt } from '../../../../src/resources/distribution/DeliveryTracker';

describe('DeliveryTracker', () => {
  let tracker: DeliveryTracker;

  beforeEach(() => {
    tracker = new DeliveryTracker({ defaultTimeoutMs: 200 });
  });

  afterEach(() => {
    tracker.destroy();
  });

  describe('trackDelivery', () => {
    test('should resolve immediately when no targets', async () => {
      const receipts = await tracker.trackDelivery('op-1', []);
      expect(receipts).toEqual([]);
    });

    test('should create pending receipts for all target nodes', () => {
      // Don't await -- we just want to see the pending count
      tracker.trackDelivery('op-1', ['node-a', 'node-b']);
      expect(tracker.pendingCount).toBe(1);
    });
  });

  describe('receiveAck', () => {
    test('should resolve when all targets ACK', async () => {
      const promise = tracker.trackDelivery('op-1', ['node-a', 'node-b']);

      tracker.receiveAck('op-1', 'node-a');
      tracker.receiveAck('op-1', 'node-b');

      const receipts = await promise;
      expect(receipts).toHaveLength(2);
      expect(receipts[0].status).toBe('acked');
      expect(receipts[1].status).toBe('acked');
      expect(tracker.pendingCount).toBe(0);
    });

    test('should ignore duplicate ACKs for the same node', async () => {
      const promise = tracker.trackDelivery('op-1', ['node-a']);

      tracker.receiveAck('op-1', 'node-a');
      tracker.receiveAck('op-1', 'node-a'); // duplicate -- should be ignored

      const receipts = await promise;
      expect(receipts).toHaveLength(1);
      expect(receipts[0].status).toBe('acked');
    });

    test('should ignore ACKs for unknown opIds', () => {
      // Should not throw
      tracker.receiveAck('unknown-op', 'node-a');
      expect(tracker.pendingCount).toBe(0);
    });

    test('should emit delivery:ack event', async () => {
      const ackEvents: string[] = [];
      tracker.on('delivery:ack', (opId: string, nodeId: string) => {
        ackEvents.push(`${opId}:${nodeId}`);
      });

      const promise = tracker.trackDelivery('op-1', ['node-a']);
      tracker.receiveAck('op-1', 'node-a');
      await promise;

      expect(ackEvents).toEqual(['op-1:node-a']);
    });

    test('should emit delivery:complete when all targets respond', async () => {
      const completeEvents: string[] = [];
      tracker.on('delivery:complete', (opId: string) => {
        completeEvents.push(opId);
      });

      const promise = tracker.trackDelivery('op-1', ['node-a', 'node-b']);
      tracker.receiveAck('op-1', 'node-a');
      tracker.receiveAck('op-1', 'node-b');
      await promise;

      expect(completeEvents).toEqual(['op-1']);
    });
  });

  describe('receiveNack', () => {
    test('should mark receipt as failed with reason', async () => {
      const promise = tracker.trackDelivery('op-1', ['node-a']);

      tracker.receiveNack('op-1', 'node-a', 'resource not found');

      const receipts = await promise;
      expect(receipts).toHaveLength(1);
      expect(receipts[0].status).toBe('failed');
      expect(receipts[0].reason).toBe('resource not found');
    });

    test('should resolve with mix of acks and nacks', async () => {
      const promise = tracker.trackDelivery('op-1', ['node-a', 'node-b']);

      tracker.receiveAck('op-1', 'node-a');
      tracker.receiveNack('op-1', 'node-b', 'processing error');

      const receipts = await promise;
      expect(receipts).toHaveLength(2);

      const acked = receipts.find(r => r.nodeId === 'node-a')!;
      const failed = receipts.find(r => r.nodeId === 'node-b')!;

      expect(acked.status).toBe('acked');
      expect(failed.status).toBe('failed');
      expect(failed.reason).toBe('processing error');
    });

    test('should emit delivery:nack event', async () => {
      const nackEvents: string[] = [];
      tracker.on('delivery:nack', (opId: string, nodeId: string, reason: string) => {
        nackEvents.push(`${opId}:${nodeId}:${reason}`);
      });

      const promise = tracker.trackDelivery('op-1', ['node-a']);
      tracker.receiveNack('op-1', 'node-a', 'err');
      await promise;

      expect(nackEvents).toEqual(['op-1:node-a:err']);
    });
  });

  describe('timeout', () => {
    test('should mark unresponsive nodes as timeout', async () => {
      const receipts = await tracker.trackDelivery('op-1', ['node-a', 'node-b'], 50);

      // Neither node responds -- wait for timeout
      expect(receipts).toHaveLength(2);
      expect(receipts[0].status).toBe('timeout');
      expect(receipts[1].status).toBe('timeout');
      expect(tracker.pendingCount).toBe(0);
    });

    test('should keep already-acked receipts on timeout', async () => {
      const promise = tracker.trackDelivery('op-1', ['node-a', 'node-b'], 50);

      // ACK node-a immediately, let node-b timeout
      tracker.receiveAck('op-1', 'node-a');

      const receipts = await promise;
      const nodeA = receipts.find(r => r.nodeId === 'node-a')!;
      const nodeB = receipts.find(r => r.nodeId === 'node-b')!;

      expect(nodeA.status).toBe('acked');
      expect(nodeB.status).toBe('timeout');
    });

    test('should emit delivery:timeout event', async () => {
      const timeoutEvents: string[] = [];
      tracker.on('delivery:timeout', (opId: string) => {
        timeoutEvents.push(opId);
      });

      await tracker.trackDelivery('op-1', ['node-a'], 50);

      expect(timeoutEvents).toEqual(['op-1']);
    });

    test('should use default timeout when none specified', () => {
      const customTracker = new DeliveryTracker({ defaultTimeoutMs: 100 });
      // Just ensure it doesn't throw -- the timeout will fire at 100ms
      const promise = customTracker.trackDelivery('op-1', ['node-a']);
      customTracker.receiveAck('op-1', 'node-a');
      customTracker.destroy();
      return promise;
    });
  });

  describe('cancel', () => {
    test('should remove tracking for an operation', () => {
      tracker.trackDelivery('op-1', ['node-a']);
      expect(tracker.pendingCount).toBe(1);

      tracker.cancel('op-1');
      expect(tracker.pendingCount).toBe(0);
    });

    test('should be safe to cancel unknown opId', () => {
      tracker.cancel('nonexistent');
      expect(tracker.pendingCount).toBe(0);
    });
  });

  describe('destroy', () => {
    test('should clear all pending trackers', () => {
      tracker.trackDelivery('op-1', ['node-a']);
      tracker.trackDelivery('op-2', ['node-b']);
      expect(tracker.pendingCount).toBe(2);

      tracker.destroy();
      expect(tracker.pendingCount).toBe(0);
    });
  });

  describe('multiple operations', () => {
    test('should track multiple operations independently', async () => {
      const promise1 = tracker.trackDelivery('op-1', ['node-a']);
      const promise2 = tracker.trackDelivery('op-2', ['node-b']);

      tracker.receiveAck('op-1', 'node-a');
      tracker.receiveAck('op-2', 'node-b');

      const [receipts1, receipts2] = await Promise.all([promise1, promise2]);

      expect(receipts1).toHaveLength(1);
      expect(receipts1[0].opId).toBe('op-1');
      expect(receipts1[0].status).toBe('acked');

      expect(receipts2).toHaveLength(1);
      expect(receipts2[0].opId).toBe('op-2');
      expect(receipts2[0].status).toBe('acked');
    });
  });
});
