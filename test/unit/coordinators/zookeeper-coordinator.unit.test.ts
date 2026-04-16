import {
  ZookeeperCoordinator,
  InMemoryZookeeperClient,
  IZookeeperClient
} from '../../../src/coordinators/ZookeeperCoordinator';

describe('ZookeeperCoordinator', () => {
  let client: InMemoryZookeeperClient;
  let coordinator: ZookeeperCoordinator;

  beforeEach(async () => {
    client = new InMemoryZookeeperClient();
    coordinator = new ZookeeperCoordinator(client);
    await coordinator.initialize('node-1', 'ring-1', {
      logging: { enableCoordinatorLogs: false, enableFrameworkLogs: false },
      leaseTimeoutMs: 1000
    });
  });

  afterEach(async () => {
    await coordinator.stop();
  });

  describe('getSemantics()', () => {
    it('should report strong consistency and durable persistence', () => {
      const sem = coordinator.getSemantics();
      expect(sem.consistency).toBe('strong');
      expect(sem.persistence).toBe('durable');
      expect(sem.leaseSupport).toBe(true);
      expect(sem.watchSupport).toBe(true);
    });
  });

  describe('initialize()', () => {
    it('should create ephemeral node under /distributed-core/nodes/', async () => {
      const exists = await client.exists('/distributed-core/nodes/node-1');
      expect(exists).toBe(true);
    });

    it('should store node metadata as JSON', async () => {
      const data = await client.getData('/distributed-core/nodes/node-1');
      expect(data).not.toBeNull();
      const parsed = JSON.parse(data!.data);
      expect(parsed.nodeId).toBe('node-1');
      expect(parsed.ringId).toBe('ring-1');
      expect(parsed.isAlive).toBe(true);
    });

    it('should create base paths', async () => {
      expect(await client.exists('/distributed-core')).toBe(true);
      expect(await client.exists('/distributed-core/nodes')).toBe(true);
      expect(await client.exists('/distributed-core/ranges')).toBe(true);
    });

    it('should update existing node on re-initialize', async () => {
      // Initialize same node again -- should setData, not fail on create
      const coord2 = new ZookeeperCoordinator(client);
      await coord2.initialize('node-1', 'ring-1', {
        logging: { enableCoordinatorLogs: false, enableFrameworkLogs: false }
      });
      const data = await client.getData('/distributed-core/nodes/node-1');
      expect(data).not.toBeNull();
      expect(data!.version).toBe(1); // version bumped from setData
      await coord2.stop();
    });
  });

  describe('joinCluster()', () => {
    it('should register seed nodes', async () => {
      await coordinator.joinCluster(['node-2', 'node-3']);
      expect(await client.exists('/distributed-core/nodes/node-2')).toBe(true);
      expect(await client.exists('/distributed-core/nodes/node-3')).toBe(true);
    });

    it('should emit node-joined for self', async () => {
      const joined: string[] = [];
      coordinator.on('node-joined', (id: string) => joined.push(id));
      await coordinator.joinCluster([]);
      expect(joined).toContain('node-1');
    });

    it('should not duplicate existing seed nodes', async () => {
      await coordinator.joinCluster(['node-2']);
      // Join again with same seed -- should not throw
      await coordinator.joinCluster(['node-2']);
      const children = await client.getChildren('/distributed-core/nodes');
      const node2Count = children.filter(c => c === 'node-2').length;
      expect(node2Count).toBe(1);
    });

    it('should watch for membership changes', async () => {
      const joined: string[] = [];
      coordinator.on('node-joined', (id: string) => joined.push(id));
      await coordinator.joinCluster([]);

      // Simulate a new node joining via ZK
      const newNodeData = JSON.stringify({ nodeId: 'node-new', ringId: 'ring-1', lastSeen: Date.now(), metadata: {}, isAlive: true });
      await client.create('/distributed-core/nodes/node-new', newNodeData, 'ephemeral');

      expect(joined).toContain('node-new');
    });
  });

  describe('leaveCluster()', () => {
    it('should remove node from ZK and emit node-left', async () => {
      await coordinator.joinCluster([]);
      const left: string[] = [];
      coordinator.on('node-left', (id: string) => left.push(id));
      await coordinator.leaveCluster();
      expect(await client.exists('/distributed-core/nodes/node-1')).toBe(false);
      expect(left).toContain('node-1');
    });

    it('should release all owned ranges on leave', async () => {
      await coordinator.acquireLease('range-A');
      await coordinator.acquireLease('range-B');
      expect(await coordinator.getOwnedRanges()).toHaveLength(2);
      await coordinator.leaveCluster();
      expect(await coordinator.getOwnedRanges()).toHaveLength(0);
    });
  });

  describe('acquireLease()', () => {
    it('should acquire a lease and track owned range', async () => {
      const acquired = await coordinator.acquireLease('range-1');
      expect(acquired).toBe(true);
      expect(await coordinator.ownsRange('range-1')).toBe(true);
      expect(await coordinator.getOwnedRanges()).toEqual(['range-1']);
    });

    it('should emit range-acquired on success', async () => {
      const acquired: string[] = [];
      coordinator.on('range-acquired', (id: string) => acquired.push(id));
      await coordinator.acquireLease('range-1');
      expect(acquired).toEqual(['range-1']);
    });

    it('should return true if already owned', async () => {
      await coordinator.acquireLease('range-1');
      const again = await coordinator.acquireLease('range-1');
      expect(again).toBe(true);
    });

    it('should fail when another node holds the lock', async () => {
      // node-1 acquires first
      await coordinator.acquireLease('range-1');

      // node-2 tries to acquire the same range
      const coord2 = new ZookeeperCoordinator(client);
      await coord2.initialize('node-2', 'ring-1', {
        logging: { enableCoordinatorLogs: false, enableFrameworkLogs: false },
        leaseTimeoutMs: 1000
      });

      const conflicts: string[] = [];
      coord2.on('lease-conflict', (_rangeId: string, holder: string) => conflicts.push(holder));

      const result = await coord2.acquireLease('range-1');
      expect(result).toBe(false);
      expect(await coord2.ownsRange('range-1')).toBe(false);
      expect(conflicts).toContain('node-1');

      await coord2.stop();
    });

    it('should create ephemeral sequential lock znodes', async () => {
      await coordinator.acquireLease('range-1');
      const children = await client.getChildren('/distributed-core/ranges/range-1');
      const locks = children.filter(c => c.startsWith('lock-'));
      expect(locks.length).toBe(1);
    });
  });

  describe('releaseLease()', () => {
    it('should release a held lease and emit range-released', async () => {
      await coordinator.acquireLease('range-1');
      const released: string[] = [];
      coordinator.on('range-released', (id: string) => released.push(id));

      await coordinator.releaseLease('range-1');
      expect(await coordinator.ownsRange('range-1')).toBe(false);
      expect(released).toEqual(['range-1']);
    });

    it('should delete the lock znode on release', async () => {
      await coordinator.acquireLease('range-1');
      await coordinator.releaseLease('range-1');
      const children = await client.getChildren('/distributed-core/ranges/range-1');
      const locks = children.filter(c => c.startsWith('lock-'));
      expect(locks.length).toBe(0);
    });

    it('should be safe to call on a range we do not own', async () => {
      await expect(coordinator.releaseLease('nonexistent')).resolves.toBeUndefined();
    });

    it('should allow another node to acquire after release', async () => {
      await coordinator.acquireLease('range-1');
      await coordinator.releaseLease('range-1');

      const coord2 = new ZookeeperCoordinator(client);
      await coord2.initialize('node-2', 'ring-1', {
        logging: { enableCoordinatorLogs: false, enableFrameworkLogs: false },
        leaseTimeoutMs: 1000
      });
      const result = await coord2.acquireLease('range-1');
      expect(result).toBe(true);
      await coord2.stop();
    });
  });

  describe('getClusterView()', () => {
    it('should list registered nodes', async () => {
      await coordinator.joinCluster(['node-2']);
      const view = await coordinator.getClusterView();
      expect(view.nodes.size).toBe(2);
      expect(view.nodes.has('node-1')).toBe(true);
      expect(view.nodes.has('node-2')).toBe(true);
      expect(view.ringId).toBe('ring-1');
    });

    it('should include lease information', async () => {
      await coordinator.acquireLease('range-1');
      const view = await coordinator.getClusterView();
      expect(view.leases.size).toBe(1);
      const lease = view.leases.get('range-1');
      expect(lease).toBeDefined();
      expect(lease!.nodeId).toBe('node-1');
      expect(lease!.rangeId).toBe('range-1');
    });

    it('should return empty maps when no nodes or leases', async () => {
      // Fresh client with a fresh coordinator
      const freshClient = new InMemoryZookeeperClient();
      const freshCoord = new ZookeeperCoordinator(freshClient);
      await freshCoord.initialize('solo', 'ring-1', {
        logging: { enableCoordinatorLogs: false, enableFrameworkLogs: false }
      });
      await freshCoord.leaveCluster();
      const view = await freshCoord.getClusterView();
      expect(view.nodes.size).toBe(0);
      expect(view.leases.size).toBe(0);
      await freshCoord.stop();
    });
  });

  describe('start() / stop()', () => {
    it('should be idempotent', async () => {
      await coordinator.start();
      await coordinator.start(); // no-op
      await coordinator.stop();
      await coordinator.stop(); // no-op
    });

    it('should release ranges and remove node on stop', async () => {
      await coordinator.start();
      await coordinator.acquireLease('range-1');
      await coordinator.stop();
      expect(await coordinator.getOwnedRanges()).toHaveLength(0);
      expect(await client.exists('/distributed-core/nodes/node-1')).toBe(false);
    });
  });
});

describe('InMemoryZookeeperClient', () => {
  let client: InMemoryZookeeperClient;

  beforeEach(() => {
    client = new InMemoryZookeeperClient();
  });

  it('should create and read persistent nodes', async () => {
    const path = await client.create('/test', 'hello');
    expect(path).toBe('/test');
    const data = await client.getData('/test');
    expect(data).toEqual({ data: 'hello', version: 0 });
  });

  it('should create sequential nodes with padded counter', async () => {
    const p1 = await client.create('/lock-', 'a', 'sequential');
    const p2 = await client.create('/lock-', 'b', 'sequential');
    expect(p1).toBe('/lock-0000000000');
    expect(p2).toBe('/lock-0000000001');
  });

  it('should throw on duplicate create', async () => {
    await client.create('/dup', 'x');
    await expect(client.create('/dup', 'y')).rejects.toThrow('Node already exists');
  });

  it('should update data and bump version', async () => {
    await client.create('/node', 'v0');
    await client.setData('/node', 'v1', 0);
    const data = await client.getData('/node');
    expect(data).toEqual({ data: 'v1', version: 1 });
  });

  it('should reject setData with wrong version', async () => {
    await client.create('/node', 'v0');
    await expect(client.setData('/node', 'v1', 99)).rejects.toThrow('Version mismatch');
  });

  it('should delete nodes', async () => {
    await client.create('/gone', 'bye');
    await client.delete('/gone');
    expect(await client.exists('/gone')).toBe(false);
    expect(await client.getData('/gone')).toBeNull();
  });

  it('should list direct children only', async () => {
    await client.create('/parent', '');
    await client.create('/parent/a', '');
    await client.create('/parent/b', '');
    await client.create('/parent/a/deep', '');
    const children = await client.getChildren('/parent');
    expect(children.sort()).toEqual(['a', 'b']);
  });

  it('should notify watchers on create and delete', async () => {
    await client.create('/watched', '');
    const events: Array<{ type: string; path: string }> = [];
    client.watch('/watched', (e) => events.push(e));

    await client.create('/watched/child', 'data');
    await client.delete('/watched/child');

    expect(events).toEqual([
      { type: 'created', path: '/watched/child' },
      { type: 'deleted', path: '/watched/child' }
    ]);
  });

  it('should cancel watchers', async () => {
    await client.create('/w', '');
    const events: any[] = [];
    const handle = client.watch('/w', (e) => events.push(e));
    handle.cancel();
    await client.create('/w/x', '');
    expect(events).toHaveLength(0);
  });

  it('should reset all state', async () => {
    await client.create('/a', '');
    client.reset();
    expect(await client.exists('/a')).toBe(false);
  });
});
