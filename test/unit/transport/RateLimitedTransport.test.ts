import { Transport } from '../../../src/transport/Transport';
import {
  RateLimitedTransport,
  RateLimitError,
  RateLimitConfig,
} from '../../../src/transport/RateLimitedTransport';
import { NodeId, Message, MessageType } from '../../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal in-memory transport for testing the wrapper. */
class StubTransport extends Transport {
  public sent: Array<{ message: Message; target: NodeId }> = [];
  private msgHandlers: Array<(message: Message) => void> = [];
  private localNode: NodeId = { id: 'local', address: '127.0.0.1', port: 3000 };

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(message: Message, target: NodeId): Promise<void> {
    this.sent.push({ message, target });
  }

  onMessage(callback: (message: Message) => void): void {
    this.msgHandlers.push(callback);
  }

  removeMessageListener(callback: (message: Message) => void): void {
    this.msgHandlers = this.msgHandlers.filter((l) => l !== callback);
  }

  getConnectedNodes(): NodeId[] {
    return [];
  }

  getLocalNodeInfo(): NodeId {
    return this.localNode;
  }

  simulateReceive(message: Message): void {
    for (const listener of this.msgHandlers) {
      listener(message);
    }
  }
}

function makeMessage(id: string = 'msg-1'): Message {
  return {
    id,
    type: MessageType.CUSTOM,
    data: { hello: 'world' },
    sender: { id: 'sender', address: '127.0.0.1', port: 3000 },
    timestamp: Date.now(),
  };
}

const target: NodeId = { id: 'remote', address: '10.0.0.1', port: 4000 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RateLimitedTransport', () => {
  let inner: StubTransport;

  beforeEach(() => {
    inner = new StubTransport();
  });

  // -----------------------------------------------------------------------
  // Basic rate-limit enforcement
  // -----------------------------------------------------------------------

  describe('rate-limit enforcement (throw mode)', () => {
    it('allows messages within the rate limit', async () => {
      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 5,
        onLimitExceeded: 'throw',
      });
      await limited.start();

      for (let i = 0; i < 5; i++) {
        await limited.send(makeMessage(`msg-${i}`), target);
      }

      expect(inner.sent).toHaveLength(5);
      const stats = limited.getStats();
      expect(stats.sent).toBe(5);
      expect(stats.rateLimitHits).toBe(0);

      await limited.stop();
    });

    it('throws RateLimitError when exceeding message rate', async () => {
      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 2,
        onLimitExceeded: 'throw',
      });
      await limited.start();

      await limited.send(makeMessage('1'), target);
      await limited.send(makeMessage('2'), target);

      await expect(limited.send(makeMessage('3'), target)).rejects.toThrow(RateLimitError);
      await expect(limited.send(makeMessage('3'), target)).rejects.toThrow('Message rate limit exceeded');

      const stats = limited.getStats();
      expect(stats.sent).toBe(2);
      expect(stats.rateLimitHits).toBe(2);

      await limited.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Drop mode
  // -----------------------------------------------------------------------

  describe('drop mode', () => {
    it('silently drops excess messages', async () => {
      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 1,
        onLimitExceeded: 'drop',
      });
      await limited.start();

      await limited.send(makeMessage('1'), target);
      // These should be dropped without error
      await limited.send(makeMessage('2'), target);
      await limited.send(makeMessage('3'), target);

      expect(inner.sent).toHaveLength(1);
      const stats = limited.getStats();
      expect(stats.sent).toBe(1);
      expect(stats.dropped).toBe(2);
      expect(stats.rateLimitHits).toBe(2);

      await limited.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Queue mode
  // -----------------------------------------------------------------------

  describe('queue mode', () => {
    it('queues excess messages and drains on refill', async () => {
      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 2,
        onLimitExceeded: 'queue',
      });
      await limited.start();

      // Send 2 immediately
      await limited.send(makeMessage('1'), target);
      await limited.send(makeMessage('2'), target);

      // Third message should be queued (promise won't resolve until refill)
      const thirdPromise = limited.send(makeMessage('3'), target);

      expect(inner.sent).toHaveLength(2);
      expect(limited.getStats().queued).toBe(1);
      expect(limited.getStats().rateLimitHits).toBe(1);

      // Simulate token refill
      limited._testRefill();

      // The queued message should now be sent
      await thirdPromise;
      expect(inner.sent).toHaveLength(3);
      expect(limited.getStats().sent).toBe(3);
      expect(limited.getStats().queued).toBe(0);

      await limited.stop();
    });

    it('rejects queued messages when transport is stopped', async () => {
      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 1,
        onLimitExceeded: 'queue',
      });
      await limited.start();

      await limited.send(makeMessage('1'), target);
      const queuedPromise = limited.send(makeMessage('2'), target);

      // Stopping should reject the queued message
      await limited.stop();
      await expect(queuedPromise).rejects.toThrow('Transport stopped');
    });
  });

  // -----------------------------------------------------------------------
  // Byte rate limiting
  // -----------------------------------------------------------------------

  describe('byte rate limiting', () => {
    it('enforces byte rate limit', async () => {
      // Estimate the byte size of one message so we can set a limit
      // that allows exactly one but not two.
      const sampleSize = Buffer.byteLength(JSON.stringify(makeMessage('x')), 'utf8');

      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 100, // high message limit
        maxBytesPerSecond: sampleSize + 10, // enough for one message, not two
        onLimitExceeded: 'throw',
      });
      await limited.start();

      // First message should fit
      await limited.send(makeMessage('1'), target);

      // Second message exceeds byte budget
      await expect(limited.send(makeMessage('2'), target)).rejects.toThrow(RateLimitError);

      const stats = limited.getStats();
      expect(stats.sent).toBe(1);
      expect(stats.rateLimitHits).toBe(1);

      await limited.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent connection limiting
  // -----------------------------------------------------------------------

  describe('concurrent connection limiting', () => {
    it('enforces max concurrent connections', async () => {
      // Make inner.send block until we release it
      let releaseSend: (() => void) | null = null;
      const blockingSend = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      inner.send = async () => {
        await blockingSend;
      };

      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 100,
        maxConcurrentConnections: 1,
        onLimitExceeded: 'throw',
      });
      await limited.start();

      // First send will block (in-flight = 1)
      const firstSend = limited.send(makeMessage('1'), target);

      // Second send should be rejected (concurrency limit hit)
      await expect(limited.send(makeMessage('2'), target)).rejects.toThrow(RateLimitError);

      // Release the first send
      releaseSend!();
      await firstSend;

      expect(limited.getStats().rateLimitHits).toBe(1);
      await limited.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Token refill
  // -----------------------------------------------------------------------

  describe('token refill', () => {
    it('restores capacity after refill', async () => {
      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 2,
        onLimitExceeded: 'throw',
      });
      await limited.start();

      // Exhaust tokens
      await limited.send(makeMessage('1'), target);
      await limited.send(makeMessage('2'), target);
      await expect(limited.send(makeMessage('3'), target)).rejects.toThrow(RateLimitError);

      // Refill
      limited._testRefill();

      // Should be able to send again
      await limited.send(makeMessage('4'), target);
      await limited.send(makeMessage('5'), target);
      expect(limited.getStats().sent).toBe(4);

      await limited.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Stats tracking
  // -----------------------------------------------------------------------

  describe('getStats()', () => {
    it('tracks all counters correctly', async () => {
      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 2,
        onLimitExceeded: 'drop',
      });
      await limited.start();

      await limited.send(makeMessage('1'), target);
      await limited.send(makeMessage('2'), target);
      await limited.send(makeMessage('3'), target); // dropped
      await limited.send(makeMessage('4'), target); // dropped

      const stats = limited.getStats();
      expect(stats.sent).toBe(2);
      expect(stats.dropped).toBe(2);
      expect(stats.rateLimitHits).toBe(2);
      expect(stats.queued).toBe(0);

      await limited.stop();
    });

    it('returns a snapshot (not a mutable reference)', async () => {
      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 10,
      });
      await limited.start();

      const before = limited.getStats();
      await limited.send(makeMessage('1'), target);
      const after = limited.getStats();

      expect(before.sent).toBe(0);
      expect(after.sent).toBe(1);

      await limited.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Delegation of Transport methods
  // -----------------------------------------------------------------------

  describe('delegation', () => {
    it('delegates getConnectedNodes()', async () => {
      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 10,
      });
      expect(limited.getConnectedNodes()).toEqual([]);
    });

    it('delegates getLocalNodeInfo()', async () => {
      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 10,
      });
      expect(limited.getLocalNodeInfo()).toEqual({
        id: 'local',
        address: '127.0.0.1',
        port: 3000,
      });
    });

    it('delegates onMessage / removeMessageListener', () => {
      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 10,
      });

      const received: Message[] = [];
      const handler = (msg: Message) => received.push(msg);

      limited.onMessage(handler);

      const msg = makeMessage('test');
      inner.simulateReceive(msg);
      expect(received).toHaveLength(1);
      expect(received[0].id).toBe('test');

      limited.removeMessageListener(handler);
      inner.simulateReceive(msg);
      expect(received).toHaveLength(1); // no new message
    });
  });

  // -----------------------------------------------------------------------
  // Default config
  // -----------------------------------------------------------------------

  describe('default config', () => {
    it('defaults onLimitExceeded to throw', async () => {
      const limited = RateLimitedTransport.wrapTransport(inner, {
        maxMessagesPerSecond: 1,
      });
      await limited.start();

      await limited.send(makeMessage('1'), target);
      await expect(limited.send(makeMessage('2'), target)).rejects.toThrow(RateLimitError);

      await limited.stop();
    });
  });
});
