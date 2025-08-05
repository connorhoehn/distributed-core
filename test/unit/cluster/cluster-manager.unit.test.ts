import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';

describe('ClusterManager Unit Tests', () => {
  let clusterManager: ClusterManager;
  let transport: InMemoryAdapter;
  let nodeId: string;
  let config: BootstrapConfig;

  beforeEach(() => {
    nodeId = 'test-node';
    const nodeIdObj = { id: 'test-node', address: '127.0.0.1', port: 3000 };
    transport = new InMemoryAdapter(nodeIdObj);
    config = new BootstrapConfig([], 5000, 1000, false); // Enable logging=false for tests
    const nodeMetadata = { region: 'test-region', zone: 'test-zone', role: 'worker' };
    clusterManager = new ClusterManager(nodeId, transport, config, 100, nodeMetadata);
  });

  afterEach(async () => {
    if (clusterManager) {
      await clusterManager.stop();
    }
  });

  it('should start and add self to membership', async () => {
    await clusterManager.start();
    
    const membership = clusterManager.getMembership();
    expect(membership.size).toBe(1);
    expect(membership.has('test-node')).toBe(true);
    const selfEntry = membership.get('test-node');
    expect(selfEntry?.status).toBe('ALIVE');
  });

  it('should stop and clear membership', async () => {
    await clusterManager.start();
    await clusterManager.stop();
    
    expect(clusterManager.getMemberCount()).toBe(0);
  });

  it('should get node info', async () => {
    await clusterManager.start();
    const nodeInfo = clusterManager.getNodeInfo();
    
    expect(nodeInfo.id).toEqual(nodeId);
    expect(nodeInfo.status).toBe('ALIVE');
    expect(nodeInfo.version).toBeGreaterThanOrEqual(0); // Version starts at 0 and increments
    
    await clusterManager.stop();
  });
});
