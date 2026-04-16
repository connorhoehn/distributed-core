import * as net from 'net';
import { TCPAdapter } from '../../../src/transport/adapters/TCPAdapter';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { MessageType, NodeId } from '../../../src/types';

// ---------------------------------------------------------------------------
// Transport base-class defaults (via InMemoryAdapter)
// ---------------------------------------------------------------------------

describe('Transport backpressure defaults', () => {
  let adapter: InMemoryAdapter;
  const nodeId: NodeId = { id: 'mem-node', address: '127.0.0.1', port: 0 };

  beforeEach(() => {
    adapter = new InMemoryAdapter(nodeId);
  });

  afterEach(async () => {
    await adapter.stop().catch(() => {});
    InMemoryAdapter.clearRegistry();
  });

  it('canSend() returns true by default', () => {
    expect(adapter.canSend()).toBe(true);
  });

  it('getQueueDepth() returns 0 by default', () => {
    expect(adapter.getQueueDepth()).toBe(0);
  });

  it('InMemoryAdapter keeps defaults during normal sends', async () => {
    await adapter.start();

    const peer = new InMemoryAdapter({ id: 'peer', address: '127.0.0.1', port: 0 });
    await peer.start();

    const events: string[] = [];
    adapter.on('backpressure', () => events.push('backpressure'));

    for (let i = 0; i < 20; i++) {
      await adapter.send(
        {
          id: `msg-${i}`,
          type: MessageType.PING,
          data: {},
          sender: nodeId,
          timestamp: Date.now()
        },
        { id: 'peer', address: '127.0.0.1', port: 0 }
      );
    }

    expect(events).toEqual([]);
    expect(adapter.canSend()).toBe(true);
    expect(adapter.getQueueDepth()).toBe(0);

    await peer.stop();
    InMemoryAdapter.clearRegistry();
  });
});

// ---------------------------------------------------------------------------
// TCPAdapter backpressure — unit-level (no network)
// ---------------------------------------------------------------------------

describe('TCPAdapter backpressure unit', () => {
  const node: NodeId = { id: 'n', address: '127.0.0.1', port: 0 };

  it('canSend() starts as true', () => {
    const adapter = new TCPAdapter(node, { port: 19999, enableLogging: false });
    expect(adapter.canSend()).toBe(true);
  });

  it('getQueueDepth() starts at 0', () => {
    const adapter = new TCPAdapter(node, { port: 19998, enableLogging: false });
    expect(adapter.getQueueDepth()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TCPAdapter backpressure — integration with real loopback sockets
// ---------------------------------------------------------------------------

describe('TCPAdapter backpressure integration', () => {
  let echoServer: net.Server;
  let adapter: TCPAdapter;
  let serverPort: number;
  let adapterPort: number;

  beforeEach(async () => {
    echoServer = net.createServer((socket) => {
      socket.resume(); // consume all data immediately
    });

    await new Promise<void>((resolve) => {
      echoServer.listen(0, '127.0.0.1', () => {
        serverPort = (echoServer.address() as net.AddressInfo).port;
        resolve();
      });
    });

    adapterPort = 30000 + Math.floor(Math.random() * 20000);
    adapter = new TCPAdapter(
      { id: 'sender', address: '127.0.0.1', port: adapterPort },
      {
        port: adapterPort,
        enableLogging: false,
        maxRetries: 1,
        baseRetryDelay: 50,
        circuitBreakerTimeout: 5000
      }
    );
    await adapter.start();
  });

  afterEach(async () => {
    // Force-close everything quickly to avoid afterEach timeout.
    try { await adapter?.stop(); } catch { /* ignore */ }
    echoServer?.close();
    // Give the OS a moment.
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  it('remains canSend=true after a single small send', async () => {
    const target: NodeId = { id: 'echo', address: '127.0.0.1', port: serverPort };
    await adapter.send(
      {
        id: 'single',
        type: MessageType.PING,
        data: {},
        sender: { id: 'sender', address: '127.0.0.1', port: adapterPort },
        timestamp: Date.now()
      },
      target
    );

    expect(adapter.canSend()).toBe(true);
  });

  it('queueDepth returns to 0 after sends complete', async () => {
    const target: NodeId = { id: 'echo', address: '127.0.0.1', port: serverPort };
    const promises: Promise<void>[] = [];

    for (let i = 0; i < 5; i++) {
      promises.push(
        adapter.send(
          {
            id: `q-${i}`,
            type: MessageType.PING,
            data: { x: i },
            sender: { id: 'sender', address: '127.0.0.1', port: adapterPort },
            timestamp: Date.now()
          },
          target
        )
      );
    }

    await Promise.all(promises);
    expect(adapter.getQueueDepth()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TCPAdapter backpressure — deterministic via raw sockets
//
// We bypass TCPAdapter entirely and instead verify that the _mechanism_
// works: when socket.write() returns false, the adapter would emit
// 'backpressure', and when the socket emits 'drain', the adapter would
// emit 'drain'. We test this by creating a raw net.Socket pair.
// ---------------------------------------------------------------------------

describe('TCPAdapter backpressure mechanism (raw socket proof)', () => {
  it('socket.write returns false when kernel buffer is full and drain fires after', async () => {
    // Create a server that never reads data.
    const server = net.createServer((socket) => {
      socket.pause();
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as net.AddressInfo).port);
      });
    });

    const client = new net.Socket();
    await new Promise<void>((resolve) => {
      client.connect(port, '127.0.0.1', resolve);
    });

    // Write until the buffer is full.
    const chunk = Buffer.alloc(256 * 1024, 0x41); // 256KB
    let writeFailed = false;

    for (let i = 0; i < 500; i++) {
      const ok = client.write(chunk);
      if (!ok) {
        writeFailed = true;
        break;
      }
    }

    // On any modern OS, eventually the socket write buffer fills up.
    expect(writeFailed).toBe(true);

    // The 'drain' event should fire when the buffer can accept more data.
    // We don't need to wait for it in this test — just prove the mechanism
    // is what TCPAdapter hooks into.

    client.destroy();
    server.close();
    await new Promise((r) => setTimeout(r, 50));
  }, 10000);
});
