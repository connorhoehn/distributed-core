import { MessageBatcher } from '../../../src/transport/MessageBatcher';
import { Transport } from '../../../src/transport/Transport';
import { Message, MessageType, NodeId } from '../../../src/types';

// Minimal mock transport that records send() calls
class MockTransport extends Transport {
  public sent: Array<{ message: Message; target: NodeId }> = [];
  public shouldFail = false;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(message: Message, target: NodeId): Promise<void> {
    if (this.shouldFail) {
      throw new Error('send failed');
    }
    this.sent.push({ message, target });
  }

  onMessage(_callback: (message: Message) => void): void {}
  removeMessageListener(_callback: (message: Message) => void): void {}
  getConnectedNodes(): NodeId[] { return []; }
  getLocalNodeInfo(): NodeId { return { id: 'local', address: '127.0.0.1', port: 3000 }; }
}

function makeMessage(id: string, data: any = 'hello'): Message {
  return {
    id,
    type: MessageType.CUSTOM,
    data,
    sender: { id: 'sender', address: '127.0.0.1', port: 3000 },
    timestamp: Date.now()
  };
}

function makeTarget(id: string): NodeId {
  return { id, address: '127.0.0.1', port: 4000 };
}

describe('MessageBatcher.wrapTransport', () => {
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
  });

  test('should queue messages and flush them through the real transport', async () => {
    const batched = MessageBatcher.wrapTransport(transport, {
      maxBatchSize: 3,
      flushIntervalMs: 10000, // high interval so only size triggers flush
      enableLogging: false
    });

    const target = makeTarget('node-a');
    const msg1 = makeMessage('m1', 'data-1');
    const msg2 = makeMessage('m2', 'data-2');

    // Send two messages - should be queued, not yet flushed (batch size is 3)
    const p1 = batched.send(msg1, target);
    const p2 = batched.send(msg2, target);

    // Nothing sent yet
    expect(transport.sent.length).toBe(0);

    // Explicitly flush
    await batched.flush();

    // Now the promises should resolve
    await p1;
    await p2;

    expect(transport.sent.length).toBe(2);
    expect(transport.sent[0].message.id).toBe('m1');
    expect(transport.sent[1].message.id).toBe('m2');
    expect(transport.sent[0].target.id).toBe('node-a');

    batched.destroy();
  });

  test('should auto-flush when batch size threshold is reached', async () => {
    const batched = MessageBatcher.wrapTransport(transport, {
      maxBatchSize: 2,
      flushIntervalMs: 10000,
      enableLogging: false
    });

    const target = makeTarget('node-b');

    // Sending 2 messages should trigger auto-flush (maxBatchSize = 2)
    const p1 = batched.send(makeMessage('m1'), target);
    const p2 = batched.send(makeMessage('m2'), target);

    await p1;
    await p2;

    expect(transport.sent.length).toBe(2);

    batched.destroy();
  });

  test('should auto-flush on timer interval', async () => {
    const batched = MessageBatcher.wrapTransport(transport, {
      maxBatchSize: 100, // high threshold so size doesn't trigger
      flushIntervalMs: 50,
      enableLogging: false
    });

    const target = makeTarget('node-c');
    const p1 = batched.send(makeMessage('m1'), target);

    // Wait for the timer flush
    await new Promise(resolve => setTimeout(resolve, 100));

    await p1;
    expect(transport.sent.length).toBe(1);

    batched.destroy();
  });

  test('should route messages to correct targets', async () => {
    const batched = MessageBatcher.wrapTransport(transport, {
      maxBatchSize: 100,
      flushIntervalMs: 10000,
      enableLogging: false
    });

    const targetA = makeTarget('node-a');
    const targetB = makeTarget('node-b');

    const p1 = batched.send(makeMessage('m1'), targetA);
    const p2 = batched.send(makeMessage('m2'), targetB);

    await batched.flush();
    await p1;
    await p2;

    expect(transport.sent.length).toBe(2);

    const sentToA = transport.sent.find(s => s.target.id === 'node-a');
    const sentToB = transport.sent.find(s => s.target.id === 'node-b');
    expect(sentToA).toBeDefined();
    expect(sentToB).toBeDefined();
    expect(sentToA!.message.id).toBe('m1');
    expect(sentToB!.message.id).toBe('m2');

    batched.destroy();
  });

  test('should reject pending messages on destroy', async () => {
    const batched = MessageBatcher.wrapTransport(transport, {
      maxBatchSize: 100,
      flushIntervalMs: 10000,
      enableLogging: false
    });

    const target = makeTarget('node-a');
    const promise = batched.send(makeMessage('m1'), target);

    // Destroy before flush
    batched.destroy();

    await expect(promise).rejects.toThrow('BatchedTransport destroyed');
    expect(transport.sent.length).toBe(0);
  });

  test('should reject individual message if transport.send fails', async () => {
    const batched = MessageBatcher.wrapTransport(transport, {
      maxBatchSize: 1, // flush immediately
      enableLogging: false
    });

    transport.shouldFail = true;
    const target = makeTarget('node-a');
    const promise = batched.send(makeMessage('m1'), target);

    await expect(promise).rejects.toThrow('send failed');

    batched.destroy();
  });

  test('should expose the underlying batcher instance', () => {
    const batched = MessageBatcher.wrapTransport(transport, { enableLogging: false });
    expect(batched.batcher).toBeInstanceOf(MessageBatcher);
    batched.destroy();
  });
});
