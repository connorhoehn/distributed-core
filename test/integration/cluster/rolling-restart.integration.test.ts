/**
 * Rolling Restart Integration Tests
 *
 * Tests that nodes can restart (stop + fresh start) while the cluster
 * stays operational and membership eventually re-stabilizes.
 */

import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { createTestClusterConfig } from '../../support/test-config';

jest.setTimeout(30000);

// ── helpers ──────────────────────────────────────────────────────────────────

function makeNode(nodeId: string, seedIds: string[] = []): ClusterManager {
  const cfg = createTestClusterConfig('integration');
  const transport = new InMemoryAdapter({
    id: nodeId,
    address: '127.0.0.1',
    port: 3000
  });
  const config = new BootstrapConfig(
    seedIds,
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
  timeoutMs = 10000,
  intervalMs = 150
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
  timeoutMs = 10000
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

describe('Rolling Restart Integration', () => {
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

  // ── 1. restarted node rejoins the cluster ────────────────────────────────

  it('restarted node rejoins the cluster', async () => {
    const node0 = await startNode(makeNode('rr-seed'));
    const node1 = await startNode(makeNode('rr-peer1', ['rr-seed']));
    const node2 = await startNode(makeNode('rr-peer2', ['rr-seed']));

    await waitForAliveCount(node0, 3);

    // Simulate node2 crash
    await stopNode(node2);

    // Wait for failure detection on node0
    await waitFor(() => node0.getAliveMembers().length === 2, 8000);

    // Start a fresh replacement node (same seed)
    const node3 = await startNode(makeNode('rr-replacement', ['rr-seed']));

    // Wait for node3 to join
    await waitFor(() => seesNode(node0, 'rr-replacement'), 10000);
    await waitFor(() => seesNode(node1, 'rr-replacement'), 10000);

    expect(seesNode(node0, 'rr-replacement')).toBe(true);
    expect(seesNode(node1, 'rr-replacement')).toBe(true);
  });

  // ── 2. cluster remains operational during single node restart ────────────

  it('cluster remains operational during single node restart', async () => {
    const node0 = await startNode(makeNode('op-seed'));
    const node1 = await startNode(makeNode('op-peer1', ['op-seed']));
    const node2 = await startNode(makeNode('op-peer2', ['op-seed']));

    await waitForAliveCount(node0, 3);

    // Stop one non-seed node
    await stopNode(node2);

    // Remaining two nodes should still have quorum
    await waitFor(() => node0.getAliveMembers().length === 2, 8000);
    expect(node0.hasQuorum({})).toBe(true);
    expect(node1.hasQuorum({})).toBe(true);

    // Start a replacement
    const node3 = await startNode(makeNode('op-replacement', ['op-seed']));

    await waitFor(() => seesNode(node0, 'op-replacement'), 10000);

    // Final cluster should have at least 2 alive members on node0
    expect(node0.getAliveMembers().length).toBeGreaterThanOrEqual(2);
  });

  // ── 3. membership stabilizes after rolling restart sequence ─────────────

  it('membership stabilizes after rolling restart of two non-seed nodes', async () => {
    const node0 = await startNode(makeNode('rolling-seed'));
    const node1 = await startNode(makeNode('rolling-peer1', ['rolling-seed']));
    const node2 = await startNode(makeNode('rolling-peer2', ['rolling-seed']));

    await waitForAliveCount(node0, 3);

    // Rolling restart: stop node1, start replacement1, then stop node2, start replacement2
    await stopNode(node1);
    await new Promise(resolve => setTimeout(resolve, 500));

    const replacement1 = await startNode(makeNode('rolling-replacement1', ['rolling-seed']));
    await waitFor(() => seesNode(node0, 'rolling-replacement1'), 10000);

    await stopNode(node2);
    await new Promise(resolve => setTimeout(resolve, 500));

    const replacement2 = await startNode(makeNode('rolling-replacement2', ['rolling-seed']));
    await waitFor(() => seesNode(node0, 'rolling-replacement2'), 10000);

    // After rolling restart, all surviving/replacement nodes should see each other
    await waitFor(() => seesNode(replacement1, 'rolling-replacement2'), 10000);
    await waitFor(() => seesNode(replacement2, 'rolling-replacement1'), 10000);

    // Final cluster should have node0, replacement1, replacement2 alive
    expect(seesNode(node0, 'rolling-replacement1')).toBe(true);
    expect(seesNode(node0, 'rolling-replacement2')).toBe(true);
    expect(seesNode(replacement1, 'rolling-replacement2')).toBe(true);
    expect(seesNode(replacement2, 'rolling-replacement1')).toBe(true);
  });
});
