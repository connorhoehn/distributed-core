/**
 * Quorum Real Cluster Integration Tests
 *
 * Tests ClusterManager.hasQuorum(), canHandleFailures(), and detectPartition()
 * under real in-memory cluster conditions.
 */

import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { createTestClusterConfig } from '../../support/test-config';

jest.setTimeout(20000);

// ── helpers ─────────────────────────────────────────────────────────────────

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

// ── tests ────────────────────────────────────────────────────────────────────

describe('Quorum Real Cluster Integration', () => {
  const started: ClusterManager[] = [];

  afterEach(async () => {
    await Promise.allSettled(started.map(n => n.stop()));
    started.length = 0;
  });

  async function startNode(node: ClusterManager): Promise<ClusterManager> {
    await node.start();
    started.push(node);
    return node;
  }

  // ── 1. single node ──────────────────────────────────────────────────────

  it('single node never achieves quorum with minNodeCount: 2', async () => {
    const node = await startNode(makeNode('solo-node'));
    // Allow a moment for the node to settle
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(node.hasQuorum({ minNodeCount: 2 })).toBe(false);
  });

  // ── 2. two-node cluster ─────────────────────────────────────────────────

  it('two-node cluster satisfies majority quorum', async () => {
    const node0 = await startNode(makeNode('quorum-node-0'));
    const node1 = await startNode(makeNode('quorum-node-1', ['quorum-node-0']));

    await waitForAliveCount(node0, 2);
    await waitForAliveCount(node1, 2);

    // majority of 2 is ceil(2/2) = 1; both are alive so quorum holds
    expect(node0.hasQuorum({})).toBe(true);
    expect(node1.hasQuorum({})).toBe(true);
  });

  // ── 3. three-node: quorum with one down ─────────────────────────────────

  it('three-node cluster has quorum with one node down', async () => {
    const node0 = await startNode(makeNode('q3-node-0'));
    const node1 = await startNode(makeNode('q3-node-1', ['q3-node-0']));
    const node2 = await startNode(makeNode('q3-node-2', ['q3-node-0']));

    // Wait for full convergence
    await waitForAliveCount(node0, 3);

    // Stop node2
    await node2.stop();
    started.splice(started.indexOf(node2), 1);

    // Wait for failure detection on node0
    await waitFor(
      () => node0.getAliveMembers().length === 2,
      8000
    );

    // 2 out of 3 = majority
    expect(node0.hasQuorum({})).toBe(true);
  });

  // ── 4. three-node: quorum lost when majority fails ───────────────────────

  it('cluster loses quorum when majority fails', async () => {
    const node0 = await startNode(makeNode('ql-node-0'));
    const node1 = await startNode(makeNode('ql-node-1', ['ql-node-0']));
    const node2 = await startNode(makeNode('ql-node-2', ['ql-node-0']));

    await waitForAliveCount(node0, 3);

    // Stop two nodes — keep only node0 alive
    await node1.stop();
    started.splice(started.indexOf(node1), 1);
    await node2.stop();
    started.splice(started.indexOf(node2), 1);

    // Wait for failure detection: node0 sees only itself
    await waitFor(
      () => node0.getAliveMembers().length === 1,
      8000
    );

    // 1 out of 3 — no majority
    expect(node0.hasQuorum({})).toBe(false);
  });

  // ── 5. canHandleFailures ─────────────────────────────────────────────────

  it('canHandleFailures reports correctly for a 3-node cluster', async () => {
    const node0 = await startNode(makeNode('cf-node-0'));
    const node1 = await startNode(makeNode('cf-node-1', ['cf-node-0']));
    const node2 = await startNode(makeNode('cf-node-2', ['cf-node-0']));

    await waitForAliveCount(node0, 3);

    // With 3 alive: can handle 1 failure (2 remaining >= ceil(3*0.5)=2)
    expect(node0.canHandleFailures(1)).toBe(true);
    // Cannot handle 2 failures (1 remaining < 2)
    expect(node0.canHandleFailures(2)).toBe(false);
  });

  // ── 6. detectPartition returns null in healthy cluster ───────────────────

  it('detectPartition returns null in a healthy 3-node cluster', async () => {
    const node0 = await startNode(makeNode('dp-node-0'));
    const node1 = await startNode(makeNode('dp-node-1', ['dp-node-0']));
    const node2 = await startNode(makeNode('dp-node-2', ['dp-node-0']));

    await waitForAliveCount(node0, 3);

    // All three alive and in multiple "zones" (metadata not set so all 'unknown'),
    // but the default path should return null when majority is alive.
    // Note: detectPartition returns null when aliveMembers >= ceil(total/2)
    // and zones.size > 1 OR total == aliveMembers (no dead members).
    // With 3 alive of 3 total — alive >= ceil(3/2)=2 → passes first check.
    // All metadata.zone is undefined → single 'unknown' zone, but
    // totalMembers == aliveMembers so second check (totalMembers > aliveMembers) is false.
    expect(node0.detectPartition()).toBeNull();
  });
});
