import { createCluster } from '../../../src/frontdoor/createCluster';
import { ClusterHandle } from '../../../src/frontdoor/ClusterHandle';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';

describe('Cluster Convergence (integration)', () => {
  let cluster: ClusterHandle | null = null;

  afterEach(async () => {
    if (cluster) {
      await cluster.stop();
      cluster = null;
    }
    InMemoryAdapter.clearRegistry();
  }, 60000);

  it('should converge a 3-node in-memory cluster', async () => {
    cluster = await createCluster({
      size: 3,
      transport: 'in-memory',
      autoStart: true,
      startupDelay: 100,
    });

    const converged = await cluster.waitForConvergence(30000);
    expect(converged).toBe(true);

    // Verify every node sees all 3 members
    for (const node of cluster.getNodes()) {
      expect(node.getMemberCount()).toBeGreaterThanOrEqual(3);
    }
  }, 60000);

  it('should converge a 5-node cluster', async () => {
    cluster = await createCluster({
      size: 5,
      transport: 'in-memory',
      autoStart: true,
      startupDelay: 100,
    });

    const converged = await cluster.waitForConvergence(30000);
    expect(converged).toBe(true);

    for (const node of cluster.getNodes()) {
      expect(node.getMemberCount()).toBeGreaterThanOrEqual(5);
    }
  }, 60000);

  it('should return false from waitForConvergence if cluster is not started', async () => {
    cluster = await createCluster({
      size: 3,
      transport: 'in-memory',
      autoStart: false,
    });

    // Without starting, nodes see only themselves (or 0 members)
    const converged = await cluster.waitForConvergence(500);
    expect(converged).toBe(false);
  });
});
