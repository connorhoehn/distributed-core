import { MessageValidator, ValidationResult } from '../../../src/transport/MessageValidator';
import { Transport } from '../../../src/transport/Transport';
import { Message, MessageType, NodeId } from '../../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    type: MessageType.PING,
    data: {},
    sender: { id: 'node-1', address: '127.0.0.1', port: 3000 },
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Minimal concrete Transport for testing the wrapper. */
class StubTransport extends Transport {
  public sent: { message: Message; target: NodeId }[] = [];
  private messageListeners: Array<(message: Message) => void> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(message: Message, target: NodeId): Promise<void> {
    this.sent.push({ message, target });
  }

  onMessage(callback: (message: Message) => void): void {
    this.messageListeners.push(callback);
  }

  removeMessageListener(callback: (message: Message) => void): void {
    this.messageListeners = this.messageListeners.filter((l) => l !== callback);
  }

  getConnectedNodes(): NodeId[] {
    return [];
  }

  getLocalNodeInfo(): NodeId {
    return { id: 'local', address: '127.0.0.1', port: 3000 };
  }

  /** Simulate receiving a message from the network. */
  simulateIncoming(message: Message): void {
    for (const cb of this.messageListeners) {
      cb(message);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests — MessageValidator.validate()
// ---------------------------------------------------------------------------

describe('MessageValidator.validate()', () => {
  test('accepts a valid message', () => {
    const result = MessageValidator.validate(validMessage());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('rejects null', () => {
    const result = MessageValidator.validate(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Message must be a non-null object');
  });

  test('rejects undefined', () => {
    const result = MessageValidator.validate(undefined);
    expect(result.valid).toBe(false);
  });

  test('rejects a primitive', () => {
    const result = MessageValidator.validate('hello');
    expect(result.valid).toBe(false);
  });

  test('reports missing id', () => {
    const { id, ...rest } = validMessage();
    const result = MessageValidator.validate(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('id')]));
  });

  test('reports non-string id', () => {
    const result = MessageValidator.validate({ ...validMessage(), id: 123 });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('"id" must be a string')]));
  });

  test('reports missing type', () => {
    const { type, ...rest } = validMessage();
    const result = MessageValidator.validate(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('type')]));
  });

  test('reports invalid type value', () => {
    const result = MessageValidator.validate({ ...validMessage(), type: 'not_a_type' });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('valid MessageType')]));
  });

  test('reports missing sender', () => {
    const { sender, ...rest } = validMessage();
    const result = MessageValidator.validate(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('sender')]));
  });

  test('reports non-object sender', () => {
    const result = MessageValidator.validate({ ...validMessage(), sender: 'node-1' });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('sender')]) );
  });

  test('reports sender without id', () => {
    const result = MessageValidator.validate({ ...validMessage(), sender: { address: '127.0.0.1' } });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('sender.id')]));
  });

  test('reports missing timestamp', () => {
    const { timestamp, ...rest } = validMessage();
    const result = MessageValidator.validate(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('timestamp')]));
  });

  test('reports non-number timestamp', () => {
    const result = MessageValidator.validate({ ...validMessage(), timestamp: 'now' });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('timestamp')]) );
  });

  test('collects multiple errors at once', () => {
    const result = MessageValidator.validate({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Tests — MessageValidator.validateSize()
// ---------------------------------------------------------------------------

describe('MessageValidator.validateSize()', () => {
  test('accepts a message under the limit', () => {
    const result = MessageValidator.validateSize(validMessage());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('rejects a message over the limit', () => {
    const big = { ...validMessage(), data: 'x'.repeat(2_000_000) };
    const result = MessageValidator.validateSize(big);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/exceeds limit/);
  });

  test('accepts a custom smaller limit', () => {
    const result = MessageValidator.validateSize(validMessage(), 10);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/exceeds limit.*10 bytes/);
  });

  test('accepts message exactly at the limit', () => {
    const json = JSON.stringify(validMessage());
    const byteLen = Buffer.byteLength(json, 'utf8');
    const result = MessageValidator.validateSize(validMessage(), byteLen);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — MessageValidator.wrapTransport()
// ---------------------------------------------------------------------------

describe('MessageValidator.wrapTransport()', () => {
  let stub: StubTransport;
  let wrapped: Transport;
  const target: NodeId = { id: 'target', address: '10.0.0.1', port: 4000 };

  beforeEach(() => {
    stub = new StubTransport();
    wrapped = MessageValidator.wrapTransport(stub);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -- lifecycle delegation -----------------------------------------------

  test('delegates start() and stop()', async () => {
    const startSpy = jest.spyOn(stub, 'start');
    const stopSpy = jest.spyOn(stub, 'stop');

    await wrapped.start();
    await wrapped.stop();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  test('delegates getConnectedNodes() and getLocalNodeInfo()', () => {
    expect(wrapped.getConnectedNodes()).toEqual([]);
    expect(wrapped.getLocalNodeInfo()).toEqual(stub.getLocalNodeInfo());
  });

  // -- outgoing validation ------------------------------------------------

  test('forwards a valid outgoing message', async () => {
    await wrapped.send(validMessage(), target);
    expect(stub.sent).toHaveLength(1);
  });

  test('drops an invalid outgoing message and warns', async () => {
    const bad = { ...validMessage(), id: undefined } as any;
    await wrapped.send(bad, target);
    expect(stub.sent).toHaveLength(0);
    expect(console.warn).toHaveBeenCalled();
  });

  test('drops outgoing message exceeding size limit', async () => {
    const smallWrapped = MessageValidator.wrapTransport(stub, {
      maxMessageSizeBytes: 10,
    });
    await smallWrapped.send(validMessage(), target);
    expect(stub.sent).toHaveLength(0);
    expect(console.warn).toHaveBeenCalled();
  });

  // -- incoming validation ------------------------------------------------

  test('delivers a valid incoming message to the callback', () => {
    const received: Message[] = [];
    wrapped.onMessage((msg) => received.push(msg));

    stub.simulateIncoming(validMessage());
    expect(received).toHaveLength(1);
  });

  test('drops an invalid incoming message and warns', () => {
    const received: Message[] = [];
    wrapped.onMessage((msg) => received.push(msg));

    stub.simulateIncoming({ type: MessageType.PING } as any);
    expect(received).toHaveLength(0);
    expect(console.warn).toHaveBeenCalled();
  });

  // -- option: requireId=false --------------------------------------------

  test('allows missing id when requireId is false', async () => {
    const relaxed = MessageValidator.wrapTransport(stub, { requireId: false });
    const { id, ...rest } = validMessage();
    await relaxed.send(rest as any, target);
    expect(stub.sent).toHaveLength(1);
  });

  // -- option: requireType=false ------------------------------------------

  test('allows missing type when requireType is false', async () => {
    const relaxed = MessageValidator.wrapTransport(stub, { requireType: false });
    const { type, ...rest } = validMessage();
    await relaxed.send(rest as any, target);
    expect(stub.sent).toHaveLength(1);
  });

  // -- option: requireSender=false ----------------------------------------

  test('allows missing sender when requireSender is false', async () => {
    const relaxed = MessageValidator.wrapTransport(stub, { requireSender: false });
    const { sender, ...rest } = validMessage();
    await relaxed.send(rest as any, target);
    expect(stub.sent).toHaveLength(1);
  });

  // -- removeMessageListener ----------------------------------------------

  test('removeMessageListener stops delivery', () => {
    const received: Message[] = [];
    const cb = (msg: Message) => received.push(msg);

    wrapped.onMessage(cb);
    stub.simulateIncoming(validMessage());
    expect(received).toHaveLength(1);

    wrapped.removeMessageListener(cb);
    stub.simulateIncoming(validMessage());
    expect(received).toHaveLength(1); // no new messages
  });
});
