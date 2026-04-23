/**
 * Seed Node Failover Integration Tests
 *
 * Tests cluster formation and resilience when seed nodes become unavailable.
 * Uses InMemoryAdapter, which routes by node ID string (not host:port).
 */

import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { createTestClusterConfig } from '../../support/test-config';

jest.setTimeout(20000);

// ── helpers ──────────────────────────────────────────────────────────────────

function makeNode(nodeId: string, seedIds: string[] = []): ClusterManager {
  const cfg = createTestClusterConfig('integration');
  const transport = new InMemoryAdapter({
    id: nodeId,
    address: '127.0.0.1',
    port: 3000
  });
  const config = new BootstrapConfig(
    seedIds,           // InMemoryAdapter uses node-ID strings as seed addresses
    cfg.joinTimeout,
    cfg.gossipInterval,
    false,
    cfg.failureDetector,
    cfg.keyManager,
    cfg.lifecycle
  );
  return new ClusterManager(nodeId, transport, config, 50);
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 8000,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function waitForAliveCount(
  node: ClusterManager,
  count: number,
  timeoutMs = 8000
): Promise<void> {
  return waitFor(
    () => node.getAliveMembers().length === count,
    timeoutMs
  );
}

function seesNode(observer: ClusterManager, targetId: string): boolean {
  return observer.getAliveMembers().some(m => m.id === targetId);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Seed Node Failover Integration', () => {
  const started: ClusterManager[] = [];

  async function startNode(node: ClusterManager): Promise<ClusterManager> {
    await node.start();
    started.push(node);
    return node;
  }

  async function stopNode(node: ClusterManager): Promise<void> {
    await node.stop();
    const idx = started.indexOf(node);
    if (idx !== -1) started.splice(idx, 1);
  }

  afterEach(async () => {
    await Promise.allSettled(started.map(n => n.stop()));
    started.length = 0;
  });

  // ── 1. basic join via seed ──────────────────────────────────────────────

  it('nodes join cluster seeded through the initial seed node', async () => {
    const node0 = await startNode(makeNode('snf-seed'));
    const node1 = await startNode(makeNode('snf-peer', ['snf-seed']));

    await waitForAliveCount(node0, 2);
    await waitForAliveCount(node1, 2);

    expect(seesNode(node0, 'snf-peer')).toBe(true);
    expect(seesNode(node1, 'snf-seed')).toBe(true);
  });

  // ── 2. seed crash does not break existing members ───────────────────────

  it('seed node crash does not prevent already-joined nodes from communicating', async () => {
    const node0 = await startNode(makeNode('crash-seed'));
    const node1 = await startNode(makeNode('crash-peer1', ['crash-seed']));
    const node2 = await startNode(makeNode('crash-peer2', ['crash-seed']));

    await waitForAliveCount(node0, 3);
    await waitForAliveCount(node1, 3);
    await waitForAliveCount(node2, 3);

    // Kill the seed node
    await stopNode(node0);

    // Give a moment for gossip to propagate the leave
    await new Promise(resolve => setTimeout(resolve, 300));

    // node1 and node2 already know about each other via gossip;
    // they should still appear in each other's membership
    expect(seesNode(node1, 'crash-peer2')).toBe(true);
    expect(seesNode(node2, 'crash-peer1')).toBe(true);
  });

  // ── 3. new node joins via alternative seed after primary seed fails ──────

  it('new node can join via alternative seed after primary seed fails', async () => {
    const node0 = await startNode(makeNode('alt-seed-primary'));
    const node1 = await startNode(makeNode('alt-peer1', ['alt-seed-primary']));
    const node2 = await startNode(makeNode('alt-peer2', ['alt-seed-primary']));

    await waitForAliveCount(node0, 3);
    await waitForAliveCount(node1, 3);
    await waitForAliveCount(node2, 3);

    // Bring down the original seed
    await stopNode(node0);

    // New node joins via node1 as alternative seed
    const node3 = await startNode(makeNode('alt-late-joiner', ['alt-peer1']));

    await waitFor(() => seesNode(node3, 'alt-peer1'), 8000);
    // node3 should also discover node2 through gossip
    await waitFor(() => seesNode(node3, 'alt-peer2'), 8000);
  });

  // ── 4. empty seed list starts standalone node ────────────────────────────

  it('empty seed list starts a standalone node successfully', async () => {
    const node = await startNode(makeNode('standalone'));

    await new Promise(resolve => setTimeout(resolve, 200));

    // A standalone node should know at least itself
    expect(node.getMemberCount()).toBeGreaterThanOrEqual(1);
  });
});
