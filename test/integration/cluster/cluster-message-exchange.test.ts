import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { Message, NodeId } from '../../../src/types';

jest.setTimeout(10000);

/**
 * Integration test: 3 nodes form a cluster and exchange custom messages.
 *
 * Uses InMemoryAdapter so no real networking is required. Nodes discover
 * each other through the gossip-based join protocol, then sendCustomMessage
 * is used to deliver an application-level payload between specific nodes.
 */
describe('Cluster Message Exchange Integration', () => {
  let transports: InMemoryAdapter[];
  let nodes: ClusterManager[];

  beforeEach(() => {
    InMemoryAdapter.clearRegistry();
    transports = [];
    nodes = [];
  });

  afterEach(async () => {
    // Stop all nodes in reverse order
    for (const node of [...nodes].reverse()) {
      try { await node.stop(); } catch { /* ignore */ }
    }
    for (const transport of transports) {
      try { await transport.stop(); } catch { /* ignore */ }
    }
    InMemoryAdapter.clearRegistry();
  });

  /**
   * Helper: create a ClusterManager backed by InMemoryAdapter.
   */
  function createNode(id: string, port: number, seedNodes: string[]): { manager: ClusterManager; transport: InMemoryAdapter } {
    const nodeId: NodeId = { id, address: '127.0.0.1', port };
    const transport = new InMemoryAdapter(nodeId);

    const config = new BootstrapConfig(
      seedNodes,
      5000,  // joinTimeout
      200,   // gossipInterval – fast for tests
      false  // enableLogging
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
  async function waitFor(predicate: () => boolean, timeoutMs: number = 5000, intervalMs: number = 50): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  }

  it('should form a 3-node cluster and exchange a custom message between nodes', async () => {
    // --- 1. Create 3 nodes (node-0 is the seed for the others) ---
    const { manager: node1 } = createNode('node-0', 4000, []);
    const { manager: node2, transport: transport2 } = createNode('node-1', 4001, ['node-0']);
    const { manager: node3 } = createNode('node-2', 4002, ['node-0']);

    // --- 2. Start all nodes sequentially to let join protocol run ---
    await node1.start();
    await node2.start();
    await node3.start();

    // --- 3. Wait until every node sees all 3 members ---
    await waitFor(() => {
      return (
        node1.getMemberCount() >= 3 &&
        node2.getMemberCount() >= 3 &&
        node3.getMemberCount() >= 3
      );
    }, 8000);

    expect(node1.getMemberCount()).toBeGreaterThanOrEqual(3);
    expect(node2.getMemberCount()).toBeGreaterThanOrEqual(3);
    expect(node3.getMemberCount()).toBeGreaterThanOrEqual(3);

    // --- 4. Node 1 sends a custom message to Node 2 ---
    const receivedMessages: Message[] = [];
    transport2.onMessage((message: Message) => {
      // Filter for our custom message by checking the inner data.type
      const data = message.data as any;
      if (data && data.type === 'test-greeting') {
        receivedMessages.push(message);
      }
    });

    const customPayload = { text: 'Hello from node-0', timestamp: Date.now() };
    await node1.sendCustomMessage('test-greeting', customPayload, ['node-1']);

    // --- 5. Verify Node 2 received the message ---
    await waitFor(() => receivedMessages.length > 0, 3000);

    expect(receivedMessages).toHaveLength(1);

    const received = receivedMessages[0];
    expect(received.sender.id).toBe('node-0');
    expect((received.data as any).type).toBe('test-greeting');
    expect((received.data as any).payload).toEqual(customPayload);

    // --- 6. Clean shutdown ---
    await node3.stop();
    await node2.stop();
    await node1.stop();

    // Mark as stopped so afterEach doesn't double-stop
    nodes.length = 0;
    transports.length = 0;
  });

  it('should deliver custom messages to multiple target nodes', async () => {
    const { manager: node1 } = createNode('multi-0', 5000, []);
    const { manager: node2, transport: transport2 } = createNode('multi-1', 5001, ['multi-0']);
    const { manager: node3, transport: transport3 } = createNode('multi-2', 5002, ['multi-0']);

    await node1.start();
    await node2.start();
    await node3.start();

    // Wait for full membership
    await waitFor(() => {
      return (
        node1.getMemberCount() >= 3 &&
        node2.getMemberCount() >= 3 &&
        node3.getMemberCount() >= 3
      );
    }, 8000);

    // Collect messages on both receivers
    const node2Messages: Message[] = [];
    const node3Messages: Message[] = [];

    transport2.onMessage((msg: Message) => {
      if ((msg.data as any)?.type === 'broadcast-alert') {
        node2Messages.push(msg);
      }
    });
    transport3.onMessage((msg: Message) => {
      if ((msg.data as any)?.type === 'broadcast-alert') {
        node3Messages.push(msg);
      }
    });

    // Send to both node-2 and node-3
    await node1.sendCustomMessage('broadcast-alert', { level: 'info', body: 'cluster ready' }, ['multi-1', 'multi-2']);

    await waitFor(() => node2Messages.length > 0 && node3Messages.length > 0, 3000);

    expect(node2Messages).toHaveLength(1);
    expect(node3Messages).toHaveLength(1);
    expect((node2Messages[0].data as any).payload.body).toBe('cluster ready');
    expect((node3Messages[0].data as any).payload.body).toBe('cluster ready');

    // Clean shutdown
    await node3.stop();
    await node2.stop();
    await node1.stop();
    nodes.length = 0;
    transports.length = 0;
  });
});
