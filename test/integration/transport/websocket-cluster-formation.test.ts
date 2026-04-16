import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { NodeId, Message, MessageType } from '../../../src/types';
import { GossipMessage, MessageType as GossipMsgType, MessagePriority } from '../../../src/gossip/transport/GossipMessage';

jest.setTimeout(15000);

/**
 * Integration test: 3 WebSocketAdapter nodes form a connected mesh
 * using real WebSocket connections on localhost.
 *
 * Proves that:
 *  1. Each adapter can start its own WS server on a distinct port
 *  2. Adapters can connect to one another (outgoing WS client -> remote WS server)
 *  3. Messages sent through the adapter are received by the target
 *  4. All 3 nodes see connections to the other 2
 *  5. Graceful shutdown tears down every connection
 */
describe('WebSocket Cluster Formation Integration', () => {
  const PORTS = [19101, 19102, 19103];
  const HOST = '127.0.0.1';

  let adapters: WebSocketAdapter[];

  function makeNodeId(index: number): NodeId {
    return { id: `ws-node-${index}`, address: HOST, port: PORTS[index] };
  }

  function createAdapter(index: number): WebSocketAdapter {
    const nodeId = makeNodeId(index);
    return new WebSocketAdapter(nodeId, {
      port: nodeId.port,
      host: HOST,
      pingInterval: 60000,  // long interval so heartbeat doesn't interfere
      pongTimeout: 5000,
      enableCompression: false,
      enableLogging: false,
    });
  }

  beforeEach(() => {
    adapters = [createAdapter(0), createAdapter(1), createAdapter(2)];
  });

  afterAll(async () => {
    // Defensive cleanup in case a test fails mid-way
    for (const adapter of (adapters ?? [])) {
      try { await adapter.stop(); } catch { /* ignore */ }
    }
  });

  /**
   * Poll until a predicate returns true, or throw after timeout.
   */
  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 5000,
    intervalMs = 50,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  it('should start 3 WebSocket servers on distinct ports', async () => {
    for (const adapter of adapters) {
      await adapter.start();
    }

    for (let i = 0; i < 3; i++) {
      const stats = adapters[i].getStats();
      expect(stats.isStarted).toBe(true);
      expect(stats.port).toBe(PORTS[i]);
    }

    // Cleanup
    for (const adapter of [...adapters].reverse()) {
      await adapter.stop();
    }
  });

  it('should form a fully connected 3-node mesh via connect()', async () => {
    // Start all adapters
    for (const adapter of adapters) {
      await adapter.start();
    }

    // Connect every node to every other node (full mesh)
    // node-0 -> node-1, node-0 -> node-2
    // node-1 -> node-0, node-1 -> node-2
    // node-2 -> node-0, node-2 -> node-1
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i !== j) {
          await adapters[i].connect(makeNodeId(j));
        }
      }
    }

    // Each adapter should have 2 outgoing connections it initiated
    // (plus up to 2 incoming connections accepted by its server).
    // getConnectedNodes() returns all active connections.
    for (let i = 0; i < 3; i++) {
      const connected = adapters[i].getConnectedNodes();
      // At minimum each node established 2 outgoing connections
      expect(connected.length).toBeGreaterThanOrEqual(2);
    }

    const stats = adapters[0].getStats();
    expect(stats.activeConnections).toBeGreaterThanOrEqual(2);

    // Cleanup
    for (const adapter of [...adapters].reverse()) {
      await adapter.stop();
    }
  });

  it('should send a GossipMessage from node-0 and receive it on node-1', async () => {
    for (const adapter of adapters) {
      await adapter.start();
    }

    // Connect node-0 -> node-1
    const targetNode = makeNodeId(1);
    await adapters[0].connect(targetNode);

    // Listen for the message on node-1 via the 'message-received' event
    // (WebSocketAdapter emits 'message-received' after deserializing incoming data)
    const received: any[] = [];
    adapters[1].on('message-received', (msg: any) => {
      received.push(msg);
    });

    // Build a GossipMessage that can be serialized / deserialized cleanly
    const senderNodeId = makeNodeId(0);
    const gossipMsg = new GossipMessage(
      GossipMsgType.DATA,
      senderNodeId,
      { greeting: 'hello from node-0' },
      {
        recipient: targetNode,
        priority: MessagePriority.NORMAL,
        ttl: 30000,
      },
    );

    // The WebSocketAdapter.send() path for targeted messages uses
    // JSON.stringify on the Message object. However the receiver side
    // runs GossipMessage.deserialize on the raw buffer, so we need to
    // send the serialized GossipMessage bytes directly over the
    // underlying WebSocket connection.  We can achieve this by using
    // the broadcast / gossip path which calls sendMessage -> serialize.
    //
    // Instead, use the adapter's send() with a full Message wrapper.
    // The send() with target does JSON.stringify({ ...message, target }).
    // On the receiving end handleMessage does GossipMessage.deserialize
    // which is JSON.parse -> fromJSON.  As long as the JSON round-trips
    // we'll get a message-received event.

    const transportMessage: Message = {
      id: `test-msg-${Date.now()}`,
      type: MessageType.GOSSIP,
      data: gossipMsg.toJSON(),
      sender: senderNodeId,
      timestamp: Date.now(),
    };

    await adapters[0].send(transportMessage, targetNode);

    // Wait for delivery
    await waitFor(() => received.length > 0, 3000);

    expect(received).toHaveLength(1);
    // The deserialized object will have header/payload/metrics from toJSON
    // plus whatever extra fields send() added (like 'target')
    expect(received[0]).toBeDefined();

    // Cleanup
    for (const adapter of [...adapters].reverse()) {
      await adapter.stop();
    }
  });

  it('should propagate a message across all 3 nodes (node-0 -> node-1, node-0 -> node-2)', async () => {
    for (const adapter of adapters) {
      await adapter.start();
    }

    // node-0 connects to node-1 and node-2
    await adapters[0].connect(makeNodeId(1));
    await adapters[0].connect(makeNodeId(2));

    const node1Received: any[] = [];
    const node2Received: any[] = [];

    adapters[1].on('message-received', (msg: any) => node1Received.push(msg));
    adapters[2].on('message-received', (msg: any) => node2Received.push(msg));

    const senderNodeId = makeNodeId(0);

    // Send to node-1
    const msg1: Message = {
      id: `msg-to-1-${Date.now()}`,
      type: MessageType.GOSSIP,
      data: new GossipMessage(
        GossipMsgType.DATA,
        senderNodeId,
        { target: 'node-1', value: 42 },
        { recipient: makeNodeId(1) },
      ).toJSON(),
      sender: senderNodeId,
      timestamp: Date.now(),
    };
    await adapters[0].send(msg1, makeNodeId(1));

    // Send to node-2
    const msg2: Message = {
      id: `msg-to-2-${Date.now()}`,
      type: MessageType.GOSSIP,
      data: new GossipMessage(
        GossipMsgType.DATA,
        senderNodeId,
        { target: 'node-2', value: 99 },
        { recipient: makeNodeId(2) },
      ).toJSON(),
      sender: senderNodeId,
      timestamp: Date.now(),
    };
    await adapters[0].send(msg2, makeNodeId(2));

    // Wait for both
    await waitFor(() => node1Received.length > 0 && node2Received.length > 0, 3000);

    expect(node1Received).toHaveLength(1);
    expect(node2Received).toHaveLength(1);

    // Cleanup
    for (const adapter of [...adapters].reverse()) {
      await adapter.stop();
    }
  });

  it('should cleanly shut down all 3 nodes with no dangling connections', async () => {
    for (const adapter of adapters) {
      await adapter.start();
    }

    // Form full mesh
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i !== j) {
          await adapters[i].connect(makeNodeId(j));
        }
      }
    }

    // Stop in reverse order
    for (const adapter of [...adapters].reverse()) {
      await adapter.stop();
    }

    // All adapters report stopped
    for (const adapter of adapters) {
      const stats = adapter.getStats();
      expect(stats.isStarted).toBe(false);
      expect(stats.activeConnections).toBe(0);
      expect(stats.totalConnections).toBe(0);
    }
  });
});
