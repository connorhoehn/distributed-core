import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';
import { TCPAdapter } from '../../../src/transport/adapters/TCPAdapter';
import { Message, MessageType, NodeId } from '../../../src/types';

jest.setTimeout(15000);

/**
 * Integration test: 3 nodes form a cluster over real TCP connections.
 *
 * Each node runs a TCPAdapter bound to a distinct high port (19001-19003).
 * Nodes discover each other through the gossip-based join protocol, then a
 * custom message is sent directly between two nodes to verify end-to-end
 * transport over TCP.
 */
describe('TCP Cluster Formation Integration', () => {
  const BASE_PORT = 19001;
  const HOST = '127.0.0.1';

  let transports: TCPAdapter[];
  let nodes: ClusterManager[];

  beforeEach(() => {
    transports = [];
    nodes = [];
  });

  afterAll(async () => {
    // Ensure everything is torn down even if a test fails mid-way
    for (const node of [...nodes].reverse()) {
      try { await node.stop(); } catch { /* ignore */ }
    }
    for (const transport of transports) {
      try { await transport.stop(); } catch { /* ignore */ }
    }
  });

  /**
   * Helper: create a ClusterManager backed by a real TCPAdapter.
   *
   * @param id       logical node name (e.g. "tcp-node-0")
   * @param port     TCP listen port for this node
   * @param seedAddrs seed nodes in "host:port" format (empty for the first node)
   */
  function createNode(
    id: string,
    port: number,
    seedAddrs: string[]
  ): { manager: ClusterManager; transport: TCPAdapter } {
    const nodeId: NodeId = { id, address: HOST, port };

    const transport = new TCPAdapter(nodeId, {
      port,
      host: HOST,
      enableLogging: false,
      // Tighten timeouts for test speed
      connectionTimeout: 5000,
      keepAliveInterval: 60000,
      maxRetries: 2,
      baseRetryDelay: 200,
      circuitBreakerTimeout: 5000
    });

    const config = new BootstrapConfig(
      seedAddrs,   // e.g. ["127.0.0.1:19001"]
      5000,        // joinTimeout
      300,         // gossipInterval – fast for tests
      false        // enableLogging
    );

    const manager = new ClusterManager(id, transport, config, 100, {
      region: 'test-region',
      zone: 'test-zone',
      role: 'worker',
      tags: { test: 'true' }
    });

    transports.push(transport);
    nodes.push(manager);
    return { manager, transport };
  }

  /**
   * Poll until a predicate is true, or throw after timeout.
   */
  async function waitFor(
    predicate: () => boolean,
    timeoutMs: number = 8000,
    intervalMs: number = 100
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  }

  it('should form a 3-node cluster over TCP and exchange a custom message', async () => {
    // --- 1. Create 3 nodes; node-0 is the seed for the other two ---
    const seedAddr = `${HOST}:${BASE_PORT}`;
    const { manager: node0, transport: transport0 } = createNode('tcp-node-0', BASE_PORT,     []);
    const { manager: node1, transport: transport1 } = createNode('tcp-node-1', BASE_PORT + 1, [seedAddr]);
    const { manager: node2 }                        = createNode('tcp-node-2', BASE_PORT + 2, [seedAddr]);

    // --- 2. Start all nodes (seed first so its TCP server is accepting) ---
    await node0.start();
    await node1.start();
    await node2.start();

    // --- 3. Wait until every node sees all 3 members ---
    await waitFor(() => {
      return (
        node0.getMemberCount() >= 3 &&
        node1.getMemberCount() >= 3 &&
        node2.getMemberCount() >= 3
      );
    }, 10000);

    expect(node0.getMemberCount()).toBeGreaterThanOrEqual(3);
    expect(node1.getMemberCount()).toBeGreaterThanOrEqual(3);
    expect(node2.getMemberCount()).toBeGreaterThanOrEqual(3);

    // Verify each node's membership table contains the other two
    const ids0 = Array.from(node0.getMembership().keys());
    const ids1 = Array.from(node1.getMembership().keys());
    const ids2 = Array.from(node2.getMembership().keys());

    expect(ids0).toEqual(expect.arrayContaining(['tcp-node-0', 'tcp-node-1', 'tcp-node-2']));
    expect(ids1).toEqual(expect.arrayContaining(['tcp-node-0', 'tcp-node-1', 'tcp-node-2']));
    expect(ids2).toEqual(expect.arrayContaining(['tcp-node-0', 'tcp-node-1', 'tcp-node-2']));

    // --- 4. Send a custom message from node-0 to node-1 over TCP ---
    const receivedMessages: Message[] = [];
    transport1.onMessage((message: Message) => {
      const data = message.data as any;
      if (data && data.type === 'tcp-test-greeting') {
        receivedMessages.push(message);
      }
    });

    const customPayload = { text: 'Hello over TCP', ts: Date.now() };
    const customMessage: Message = {
      id: `custom-tcp-${Date.now()}`,
      type: MessageType.GOSSIP,
      data: { type: 'tcp-test-greeting', payload: customPayload },
      sender: { id: 'tcp-node-0', address: HOST, port: BASE_PORT },
      timestamp: Date.now()
    };

    // Send directly via transport with the real address so TCP can connect
    await transport0.send(customMessage, { id: 'tcp-node-1', address: HOST, port: BASE_PORT + 1 });

    // --- 5. Verify node-1 received the message ---
    await waitFor(() => receivedMessages.length > 0, 3000);

    expect(receivedMessages).toHaveLength(1);
    const received = receivedMessages[0];
    expect((received.data as any).type).toBe('tcp-test-greeting');
    expect((received.data as any).payload).toEqual(customPayload);

    // --- 6. Clean shutdown (reverse order) ---
    await node2.stop();
    await node1.stop();
    await node0.stop();

    for (const t of transports) {
      try { await t.stop(); } catch { /* may already be stopped */ }
    }

    // Prevent afterAll from double-stopping
    nodes.length = 0;
    transports.length = 0;
  });
});
