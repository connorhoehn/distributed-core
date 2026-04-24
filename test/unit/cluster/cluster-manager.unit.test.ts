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

// ---------------------------------------------------------------------------
// Dual-emit deprecation bridge tests
// ---------------------------------------------------------------------------

describe('ClusterManager — dual-emit deprecation bridge', () => {
  function makeManager() {
    const nodeIdObj = { id: 'de-node', address: '127.0.0.1', port: 3000 };
    const transport = new InMemoryAdapter(nodeIdObj);
    const config = new BootstrapConfig([], 5000, 1000, false);
    return new ClusterManager('de-node', transport, config, 100);
  }

  // ── member:joined / member-joined ──────────────────────────────────────────

  it('member:joined — new name fires when a node joins', async () => {
    const mgr = makeManager();
    const newNameSpy = jest.fn();
    mgr.on('member:joined', newNameSpy);

    // Adding a peer node triggers member-joined via MembershipTable
    mgr.membership.updateNode({
      id: 'peer-1',
      status: 'ALIVE',
      version: 1,
      lastSeen: Date.now(),
      metadata: { address: '127.0.0.1', port: 3001 }
    });

    expect(newNameSpy).toHaveBeenCalledTimes(1);
    await mgr.stop();
  });

  it('member-joined — legacy name still fires when a node joins (compat)', async () => {
    const mgr = makeManager();
    const oldNameSpy = jest.fn();
    mgr.on('member-joined', oldNameSpy);

    mgr.membership.updateNode({
      id: 'peer-2',
      status: 'ALIVE',
      version: 1,
      lastSeen: Date.now(),
      metadata: { address: '127.0.0.1', port: 3001 }
    });

    expect(oldNameSpy).toHaveBeenCalledTimes(1);
    await mgr.stop();
  });

  it('member-joined — payload is identical between new and old name', async () => {
    const mgr = makeManager();
    let newPayload: unknown;
    let oldPayload: unknown;

    mgr.on('member:joined', (p: unknown) => { newPayload = p; });
    mgr.on('member-joined', (p: unknown) => { oldPayload = p; });

    const nodeInfo = {
      id: 'peer-3',
      status: 'ALIVE' as const,
      version: 1,
      lastSeen: Date.now(),
      metadata: { address: '127.0.0.1', port: 3001 }
    };
    mgr.membership.updateNode(nodeInfo);

    expect(newPayload).toEqual(oldPayload);
    await mgr.stop();
  });

  it('member-joined — both names fire in the same synchronous emission (not deferred)', async () => {
    const mgr = makeManager();
    const order: string[] = [];

    mgr.on('member:joined', () => order.push('new'));
    mgr.on('member-joined', () => order.push('old'));

    mgr.membership.updateNode({
      id: 'peer-4',
      status: 'ALIVE',
      version: 1,
      lastSeen: Date.now(),
      metadata: { address: '127.0.0.1', port: 3001 }
    });

    // Both should have fired; new fires first per the dual-emit contract
    expect(order).toEqual(['new', 'old']);
    await mgr.stop();
  });

  // ── member:left / member-left ─────────────────────────────────────────────

  it('member:left — new name fires when a node leaves', async () => {
    const mgr = makeManager();
    const newNameSpy = jest.fn();
    mgr.on('member:left', newNameSpy);

    mgr.membership.addMember({
      id: 'peer-5',
      status: 'ALIVE',
      version: 1,
      lastSeen: Date.now(),
      metadata: { address: '127.0.0.1', port: 3001 }
    });
    mgr.membership.markDead('peer-5');

    expect(newNameSpy).toHaveBeenCalledTimes(1);
    await mgr.stop();
  });

  it('member-left — legacy name still fires when a node leaves (compat)', async () => {
    const mgr = makeManager();
    const oldNameSpy = jest.fn();
    mgr.on('member-left', oldNameSpy);

    mgr.membership.addMember({
      id: 'peer-6',
      status: 'ALIVE',
      version: 1,
      lastSeen: Date.now(),
      metadata: { address: '127.0.0.1', port: 3001 }
    });
    mgr.membership.markDead('peer-6');

    expect(oldNameSpy).toHaveBeenCalledTimes(1);
    await mgr.stop();
  });

  // ── lifecycle:started / started ───────────────────────────────────────────

  it('lifecycle:started — new name fires on start()', async () => {
    const mgr = makeManager();
    const newNameSpy = jest.fn();
    mgr.on('lifecycle:started', newNameSpy);

    await mgr.start();
    expect(newNameSpy).toHaveBeenCalledTimes(1);
    await mgr.stop();
  });

  it('started — legacy name still fires on start() (compat)', async () => {
    const mgr = makeManager();
    const oldNameSpy = jest.fn();
    mgr.on('started', oldNameSpy);

    await mgr.start();
    expect(oldNameSpy).toHaveBeenCalledTimes(1);
    await mgr.stop();
  });

  it('lifecycle:started — both names fire in same emission, new fires first', async () => {
    const mgr = makeManager();
    const order: string[] = [];

    mgr.on('lifecycle:started', () => order.push('new'));
    mgr.on('started', () => order.push('old'));

    await mgr.start();
    expect(order).toEqual(['new', 'old']);
    await mgr.stop();
  });

  // ── lifecycle:stopped / stopped ───────────────────────────────────────────

  it('lifecycle:stopped — new name fires on stop()', async () => {
    const mgr = makeManager();
    await mgr.start();

    const newNameSpy = jest.fn();
    mgr.on('lifecycle:stopped', newNameSpy);

    await mgr.stop();
    expect(newNameSpy).toHaveBeenCalledTimes(1);
  });

  it('stopped — legacy name still fires on stop() (compat)', async () => {
    const mgr = makeManager();
    await mgr.start();

    const oldNameSpy = jest.fn();
    mgr.on('stopped', oldNameSpy);

    await mgr.stop();
    expect(oldNameSpy).toHaveBeenCalledTimes(1);
  });
});
