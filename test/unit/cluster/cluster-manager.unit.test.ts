import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { LifecycleAware } from '../../../src/common/LifecycleAware';

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

describe('ClusterManager — LifecycleAware', () => {
  function makeManager() {
    const nodeIdObj = { id: 'lc-node', address: '127.0.0.1', port: 3000 };
    const transport = new InMemoryAdapter(nodeIdObj);
    const config = new BootstrapConfig([], 5000, 1000, false);
    return new ClusterManager('lc-node', transport, config, 100);
  }

  it('isStarted() returns false before start()', () => {
    const mgr = makeManager();
    expect(mgr.isStarted()).toBe(false);
  });

  it('isStarted() returns true after start()', async () => {
    const mgr = makeManager();
    await mgr.start();
    expect(mgr.isStarted()).toBe(true);
    await mgr.stop();
  });

  it('isStarted() returns false after stop()', async () => {
    const mgr = makeManager();
    await mgr.start();
    await mgr.stop();
    expect(mgr.isStarted()).toBe(false);
  });

  it('start() twice is a no-op — lifecycle.start called only once', async () => {
    const mgr = makeManager();
    const lifecycleStartSpy = jest.spyOn((mgr as any).lifecycle, 'start');
    await mgr.start();
    await mgr.start();
    // ClusterManager.start() early-returns on the second call, so lifecycle.start
    // should have been invoked only once (by the first call).
    expect(lifecycleStartSpy).toHaveBeenCalledTimes(1);
    expect(mgr.isStarted()).toBe(true);
    await mgr.stop();
  });

  it('stop() twice is a no-op — lifecycle.stop called only once', async () => {
    const mgr = makeManager();
    await mgr.start();
    const lifecycleStopSpy = jest.spyOn((mgr as any).lifecycle, 'stop');
    await mgr.stop();
    await mgr.stop();
    // ClusterManager.stop() early-returns on the second call, so lifecycle.stop
    // should have been invoked only once (by the first call).
    expect(lifecycleStopSpy).toHaveBeenCalledTimes(1);
    expect(mgr.isStarted()).toBe(false);
  });

  it('stop() before start() is a no-op — does not throw', async () => {
    const mgr = makeManager();
    await expect(mgr.stop()).resolves.toBeUndefined();
    expect(mgr.isStarted()).toBe(false);
  });

  it('satisfies the LifecycleAware interface at the type level', () => {
    const mgr = makeManager();
    const lc: LifecycleAware = mgr;
    expect(typeof lc.start).toBe('function');
    expect(typeof lc.stop).toBe('function');
    expect(typeof lc.isStarted).toBe('function');
  });
});
