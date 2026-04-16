import { EtcdCoordinator, InMemoryEtcdClient } from '../../../src/coordinators/EtcdCoordinator';
import { ClusterView, RangeLease } from '../../../src/coordinators/types';

describe('EtcdCoordinator', () => {
  let client: InMemoryEtcdClient;
  let coordinator: EtcdCoordinator;

  const NODE_ID = 'node-1';
  const RING_ID = 'ring-test';
  const LOGGING = { enableTestMode: true };

  beforeEach(async () => {
    client = new InMemoryEtcdClient();
    coordinator = new EtcdCoordinator(client);
    await coordinator.initialize(NODE_ID, RING_ID, { logging: LOGGING });
  });

  afterEach(async () => {
    await coordinator.stop();
  });

  // -----------------------------------------------------------------------
  // getSemantics
  // -----------------------------------------------------------------------

  it('should report strong consistency semantics', () => {
    const sem = coordinator.getSemantics();
    expect(sem.consistency).toBe('strong');
    expect(sem.persistence).toBe('durable');
    expect(sem.leaseSupport).toBe(true);
    expect(sem.watchSupport).toBe(true);
  });

  // -----------------------------------------------------------------------
  // initialize
  // -----------------------------------------------------------------------

  it('should register node key in etcd on initialize', async () => {
    const raw = await client.get('/distributed-core/nodes/node-1');
    expect(raw).not.toBeNull();
    const info = JSON.parse(raw!);
    expect(info.nodeId).toBe(NODE_ID);
    expect(info.ringId).toBe(RING_ID);
    expect(info.isAlive).toBe(true);
  });

  // -----------------------------------------------------------------------
  // start / stop
  // -----------------------------------------------------------------------

  it('should be idempotent for start and stop', async () => {
    await coordinator.start();
    await coordinator.start(); // second call is a no-op
    await coordinator.stop();
    await coordinator.stop(); // second call is a no-op
  });

  // -----------------------------------------------------------------------
  // joinCluster / leaveCluster
  // -----------------------------------------------------------------------

  it('should emit node-joined for self when joining', async () => {
    const joined: string[] = [];
    coordinator.on('node-joined', (id: string) => joined.push(id));

    await coordinator.start();
    await coordinator.joinCluster([]);

    expect(joined).toContain(NODE_ID);
  });

  it('should emit node-joined when another node registers', async () => {
    const joined: string[] = [];
    coordinator.on('node-joined', (id: string) => joined.push(id));

    await coordinator.start();
    await coordinator.joinCluster([]);

    // Simulate a second node registering via the same etcd client
    const otherInfo = JSON.stringify({ nodeId: 'node-2', ringId: RING_ID, isAlive: true });
    await client.put('/distributed-core/nodes/node-2', otherInfo);

    expect(joined).toContain('node-2');
  });

  it('should emit node-left when another node is deleted', async () => {
    const left: string[] = [];
    coordinator.on('node-left', (id: string) => left.push(id));

    await coordinator.start();
    await coordinator.joinCluster([]);

    // Register then remove another node
    const otherInfo = JSON.stringify({ nodeId: 'node-2', ringId: RING_ID, isAlive: true });
    await client.put('/distributed-core/nodes/node-2', otherInfo);
    await client.delete('/distributed-core/nodes/node-2');

    expect(left).toContain('node-2');
  });

  it('should remove node key and revoke lease on leaveCluster', async () => {
    await coordinator.start();
    await coordinator.joinCluster([]);
    await coordinator.leaveCluster();

    const raw = await client.get('/distributed-core/nodes/node-1');
    expect(raw).toBeNull();
  });

  // -----------------------------------------------------------------------
  // acquireLease / releaseLease / ownsRange
  // -----------------------------------------------------------------------

  it('should successfully acquire a range lease', async () => {
    await coordinator.start();
    await coordinator.joinCluster([]);

    const acquired = await coordinator.acquireLease('range-A');
    expect(acquired).toBe(true);
    expect(await coordinator.ownsRange('range-A')).toBe(true);
  });

  it('should return true when re-acquiring an already owned range', async () => {
    await coordinator.start();
    await coordinator.joinCluster([]);

    await coordinator.acquireLease('range-A');
    const again = await coordinator.acquireLease('range-A');
    expect(again).toBe(true);
  });

  it('should fail to acquire a range owned by another node', async () => {
    await coordinator.start();
    await coordinator.joinCluster([]);

    // Simulate another node owning the range
    const otherLease: RangeLease = {
      rangeId: 'range-B',
      nodeId: 'node-other',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 15000,
      version: 0
    };
    await client.put('/distributed-core/ranges/range-B', JSON.stringify(otherLease));

    const conflicts: string[] = [];
    coordinator.on('lease-conflict', (_rangeId: string, owner: string) => conflicts.push(owner));

    const acquired = await coordinator.acquireLease('range-B');
    expect(acquired).toBe(false);
    expect(conflicts).toContain('node-other');
  });

  it('should release a range lease and remove the key', async () => {
    await coordinator.start();
    await coordinator.joinCluster([]);

    await coordinator.acquireLease('range-A');
    await coordinator.releaseLease('range-A');

    expect(await coordinator.ownsRange('range-A')).toBe(false);
    const raw = await client.get('/distributed-core/ranges/range-A');
    expect(raw).toBeNull();
  });

  it('should handle releasing a range that was never acquired', async () => {
    await coordinator.start();
    // Should not throw
    await coordinator.releaseLease('range-nonexistent');
  });

  // -----------------------------------------------------------------------
  // getOwnedRanges
  // -----------------------------------------------------------------------

  it('should return all ranges owned by this node', async () => {
    await coordinator.start();
    await coordinator.joinCluster([]);

    await coordinator.acquireLease('range-1');
    await coordinator.acquireLease('range-2');

    // Another node owns range-3
    const otherLease: RangeLease = {
      rangeId: 'range-3',
      nodeId: 'node-other',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 15000,
      version: 0
    };
    await client.put('/distributed-core/ranges/range-3', JSON.stringify(otherLease));

    const owned = await coordinator.getOwnedRanges();
    expect(owned.sort()).toEqual(['range-1', 'range-2']);
  });

  // -----------------------------------------------------------------------
  // getClusterView
  // -----------------------------------------------------------------------

  it('should return a cluster view with nodes and leases', async () => {
    await coordinator.start();
    await coordinator.joinCluster([]);
    await coordinator.acquireLease('range-X');

    // Register a second node directly
    const otherInfo = JSON.stringify({ nodeId: 'node-2', ringId: RING_ID, isAlive: true, metadata: {} });
    await client.put('/distributed-core/nodes/node-2', otherInfo);

    const view: ClusterView = await coordinator.getClusterView();

    expect(view.ringId).toBe(RING_ID);
    expect(view.nodes.size).toBe(2);
    expect(view.nodes.has(NODE_ID)).toBe(true);
    expect(view.nodes.has('node-2')).toBe(true);
    expect(view.leases.size).toBe(1);
    expect(view.leases.has('range-X')).toBe(true);
    expect(view.leases.get('range-X')!.nodeId).toBe(NODE_ID);
  });

  // -----------------------------------------------------------------------
  // leaveCluster cleans up range leases
  // -----------------------------------------------------------------------

  it('should revoke all range leases when leaving the cluster', async () => {
    await coordinator.start();
    await coordinator.joinCluster([]);

    await coordinator.acquireLease('range-1');
    await coordinator.acquireLease('range-2');

    await coordinator.leaveCluster();

    // Both range keys should be gone
    expect(await client.get('/distributed-core/ranges/range-1')).toBeNull();
    expect(await client.get('/distributed-core/ranges/range-2')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // topology-changed event
  // -----------------------------------------------------------------------

  it('should emit topology-changed when nodes join', async () => {
    const views: ClusterView[] = [];
    coordinator.on('topology-changed', (view: ClusterView) => views.push(view));

    await coordinator.start();
    await coordinator.joinCluster([]);

    const otherInfo = JSON.stringify({ nodeId: 'node-2', ringId: RING_ID, isAlive: true });
    await client.put('/distributed-core/nodes/node-2', otherInfo);

    expect(views.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// InMemoryEtcdClient unit tests
// ---------------------------------------------------------------------------

describe('InMemoryEtcdClient', () => {
  let client: InMemoryEtcdClient;

  beforeEach(() => {
    client = new InMemoryEtcdClient();
  });

  it('should store and retrieve values', async () => {
    await client.put('/key', 'value');
    expect(await client.get('/key')).toBe('value');
  });

  it('should return null for missing keys', async () => {
    expect(await client.get('/missing')).toBeNull();
  });

  it('should delete keys', async () => {
    await client.put('/key', 'value');
    await client.delete('/key');
    expect(await client.get('/key')).toBeNull();
  });

  it('should enumerate keys by prefix', async () => {
    await client.put('/a/1', 'v1');
    await client.put('/a/2', 'v2');
    await client.put('/b/1', 'v3');

    const result = client.getPrefix('/a/');
    expect(result.size).toBe(2);
    expect(result.get('/a/1')).toBe('v1');
    expect(result.get('/a/2')).toBe('v2');
  });

  it('should notify watchers on put', async () => {
    const events: any[] = [];
    client.watch('/prefix/', (e) => events.push(e));

    await client.put('/prefix/key1', 'hello');

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('put');
    expect(events[0].key).toBe('/prefix/key1');
    expect(events[0].value).toBe('hello');
  });

  it('should notify watchers on delete', async () => {
    await client.put('/prefix/key1', 'hello');

    const events: any[] = [];
    client.watch('/prefix/', (e) => events.push(e));

    await client.delete('/prefix/key1');

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('delete');
  });

  it('should stop notifying after cancel', async () => {
    const events: any[] = [];
    const watcher = client.watch('/prefix/', (e) => events.push(e));

    await client.put('/prefix/key1', 'v1');
    watcher.cancel();
    await client.put('/prefix/key2', 'v2');

    expect(events.length).toBe(1);
  });

  it('should revoke lease and delete attached keys', async () => {
    const lease = await client.lease(10);
    await client.put('/leased/key', 'val');
    client.attachToLease(lease.id, '/leased/key');

    await lease.revoke();

    expect(await client.get('/leased/key')).toBeNull();
  });
});
