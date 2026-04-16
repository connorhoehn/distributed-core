import { Transport } from '../../../src/transport/Transport';
import { Encryption } from '../../../src/transport/Encryption';
import { EncryptedTransport } from '../../../src/transport/EncryptedTransport';
import { NodeId, Message, MessageType } from '../../../src/types';

/**
 * Minimal in-memory transport that supports onMessage/removeMessageListener
 * so we can test the encrypt -> send -> receive -> decrypt round-trip.
 */
class InlineTransport extends Transport {
  private msgHandlers: Array<(message: Message) => void> = [];
  public sent: Message[] = [];

  private localNode: NodeId = { id: 'local', address: '127.0.0.1', port: 3000 };

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(message: Message, _target: NodeId): Promise<void> {
    this.sent.push(message);
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

  /** Simulate receiving a message (call registered listeners) */
  simulateReceive(message: Message): void {
    for (const listener of this.msgHandlers) {
      listener(message);
    }
  }
}

describe('EncryptedTransport', () => {
  const target: NodeId = { id: 'remote', address: '10.0.0.1', port: 4000 };

  let inner: InlineTransport;
  let encryption: Encryption;
  let encrypted: EncryptedTransport;

  beforeEach(async () => {
    inner = new InlineTransport();
    encryption = new Encryption({ enableKeyRotation: false });
    await encryption.initialize();
    encrypted = new EncryptedTransport(inner, encryption);
  });

  afterEach(() => {
    encryption.destroy();
  });

  function makeMessage(data: any): Message {
    return {
      id: 'msg-1',
      type: MessageType.CUSTOM,
      data,
      sender: { id: 'local', address: '127.0.0.1', port: 3000 },
      timestamp: Date.now(),
    };
  }

  test('send encrypts message data', async () => {
    const original = { greeting: 'hello world' };
    await encrypted.send(makeMessage(original), target);

    expect(inner.sent).toHaveLength(1);
    const sentData = inner.sent[0].data;
    expect(sentData.__encrypted).toBe(true);
    expect(sentData.payload).toHaveProperty('data');
    expect(sentData.payload).toHaveProperty('iv');
    expect(sentData.payload).toHaveProperty('tag');
    // The plaintext should NOT appear in the sent message
    expect(JSON.stringify(sentData)).not.toContain('hello world');
  });

  test('encrypt -> send -> receive -> decrypt round-trip', async () => {
    const original = { greeting: 'hello world', count: 42 };
    const msg = makeMessage(original);

    // Send encrypts
    await encrypted.send(msg, target);
    const sentMessage = inner.sent[0];

    // Register a decrypting listener
    const received: Message[] = [];
    encrypted.onMessage((m) => received.push(m));

    // Simulate the encrypted message arriving on the inner transport
    inner.simulateReceive(sentMessage);

    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual(original);
    expect(received[0].id).toBe(msg.id);
  });

  test('passes through unencrypted messages', async () => {
    const plain = makeMessage({ raw: true });

    const received: Message[] = [];
    encrypted.onMessage((m) => received.push(m));
    inner.simulateReceive(plain);

    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual({ raw: true });
  });

  test('removeMessageListener stops delivery', async () => {
    const received: Message[] = [];
    const handler = (m: Message) => received.push(m);

    encrypted.onMessage(handler);
    encrypted.removeMessageListener(handler);

    inner.simulateReceive(makeMessage({ x: 1 }));
    expect(received).toHaveLength(0);
  });

  test('delegates start/stop to inner transport', async () => {
    const startSpy = jest.spyOn(inner, 'start');
    const stopSpy = jest.spyOn(inner, 'stop');

    await encrypted.start();
    await encrypted.stop();

    expect(startSpy).toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalled();
  });

  test('wrapTransport static factory creates a working wrapper', async () => {
    const freshInner = new InlineTransport();
    const wrapped = await EncryptedTransport.wrapTransport(freshInner, {
      algorithm: 'aes-256-gcm',
      keySize: 32,
      enabled: true,
    });

    const msg = makeMessage({ factory: 'test' });
    await wrapped.send(msg, target);

    const received: Message[] = [];
    wrapped.onMessage((m) => received.push(m));
    freshInner.simulateReceive(freshInner.sent[0]);

    expect(received[0].data).toEqual({ factory: 'test' });

    wrapped.getEncryption().destroy();
  });
});
