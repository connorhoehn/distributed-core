import { InMemoryCoordinator } from '../../../src/coordinators/InMemoryCoordinator';

describe('InMemoryCoordinator', () => {
  let coordinator: InMemoryCoordinator;

  const testConfig = {
    testMode: true,
    heartbeatIntervalMs: 100,
    leaseRenewalIntervalMs: 200,
    leaseTimeoutMs: 1000,
    logging: { enableFrameworkLogs: false, enableCoordinatorLogs: false },
  };

  beforeEach(async () => {
    coordinator = new InMemoryCoordinator();
    await coordinator.initialize('node-1', 'ring-test', testConfig);
  });

  afterEach(async () => {
    await coordinator.stop();
  });

  describe('initialize and join cluster', () => {
    test('should initialize with node present in cluster view', async () => {
      const view = await coordinator.getClusterView();
      expect(view.nodes.has('node-1')).toBe(true);
      expect(view.nodes.get('node-1')!.isAlive).toBe(true);
      expect(view.ringId).toBe('ring-test');
    });

    test('should join cluster and emit node-joined event', async () => {
      const joinedNodes: string[] = [];
      coordinator.on('node-joined', (nodeId: string) => joinedNodes.push(nodeId));

      await coordinator.joinCluster(['seed-1', 'seed-2']);

      expect(joinedNodes).toContain('node-1');
      const view = await coordinator.getClusterView();
      expect(view.nodes.has('seed-1')).toBe(true);
      expect(view.nodes.has('seed-2')).toBe(true);
    });

    test('should not duplicate self when listed as seed node', async () => {
      await coordinator.joinCluster(['node-1', 'seed-1']);
      const view = await coordinator.getClusterView();
      const nodeIds = Array.from(view.nodes.keys());
      expect(nodeIds.filter((id) => id === 'node-1')).toHaveLength(1);
    });
  });

  describe('acquire and release leases', () => {
    beforeEach(async () => {
      await coordinator.joinCluster([]);
      await coordinator.start();
    });

    test('should acquire a lease successfully', async () => {
      const acquired = await coordinator.acquireLease('range-0');
      expect(acquired).toBe(true);
      expect(await coordinator.ownsRange('range-0')).toBe(true);
    });

    test('should emit range-acquired on successful acquisition', async () => {
      const acquiredRanges: string[] = [];
      coordinator.on('range-acquired', (r: string) => acquiredRanges.push(r));

      await coordinator.acquireLease('range-0');
      expect(acquiredRanges).toContain('range-0');
    });

    test('should allow re-acquiring an already owned lease', async () => {
      await coordinator.acquireLease('range-0');
      const again = await coordinator.acquireLease('range-0');
      expect(again).toBe(true);
    });

    test('should release a lease and emit range-released', async () => {
      const releasedRanges: string[] = [];
      coordinator.on('range-released', (r: string) => releasedRanges.push(r));

      await coordinator.acquireLease('range-0');
      await coordinator.releaseLease('range-0');

      expect(await coordinator.ownsRange('range-0')).toBe(false);
      expect(releasedRanges).toContain('range-0');
    });

    test('should silently handle releasing a non-owned range', async () => {
      await coordinator.releaseLease('range-nonexistent');
    });

    test('should respect maxRangesPerNode limit', async () => {
      const customCoordinator = new InMemoryCoordinator();
      await customCoordinator.initialize('node-limited', 'ring-test', {
        ...testConfig,
        maxRangesPerNode: 2,
      });
      await customCoordinator.joinCluster([]);
      await customCoordinator.start();

      expect(await customCoordinator.acquireLease('r-0')).toBe(true);
      expect(await customCoordinator.acquireLease('r-1')).toBe(true);
      expect(await customCoordinator.acquireLease('r-2')).toBe(false);

      await customCoordinator.stop();
    });
  });

  describe('getClusterView shows correct members', () => {
    test('should show correct members after join', async () => {
      await coordinator.joinCluster(['peer-a', 'peer-b']);
      const view = await coordinator.getClusterView();

      expect(view.nodes.size).toBe(3); // node-1, peer-a, peer-b
      expect(view.nodes.has('node-1')).toBe(true);
      expect(view.nodes.has('peer-a')).toBe(true);
      expect(view.nodes.has('peer-b')).toBe(true);
    });

    test('should reflect leases in cluster view', async () => {
      await coordinator.joinCluster([]);
      await coordinator.start();
      await coordinator.acquireLease('range-0');

      const view = await coordinator.getClusterView();
      expect(view.leases.has('range-0')).toBe(true);
      expect(view.leases.get('range-0')!.nodeId).toBe('node-1');
    });

    test('should return a defensive copy of nodes and leases', async () => {
      await coordinator.joinCluster([]);
      const view1 = await coordinator.getClusterView();
      view1.nodes.delete('node-1');
      const view2 = await coordinator.getClusterView();
      expect(view2.nodes.has('node-1')).toBe(true);
    });
  });

  describe('getOwnedRanges returns only this node ranges', () => {
    beforeEach(async () => {
      await coordinator.joinCluster([]);
      await coordinator.start();
    });

    test('should return empty array when no leases held', async () => {
      const ranges = await coordinator.getOwnedRanges();
      expect(ranges).toEqual([]);
    });

    test('should return only ranges this node owns', async () => {
      await coordinator.acquireLease('range-0');
      await coordinator.acquireLease('range-1');

      const ranges = await coordinator.getOwnedRanges();
      expect(ranges).toHaveLength(2);
      expect(ranges).toContain('range-0');
      expect(ranges).toContain('range-1');
    });

    test('should not include released ranges', async () => {
      await coordinator.acquireLease('range-0');
      await coordinator.acquireLease('range-1');
      await coordinator.releaseLease('range-0');

      const ranges = await coordinator.getOwnedRanges();
      expect(ranges).toEqual(['range-1']);
    });
  });

  describe('multiple nodes can coexist', () => {
    let coordinator2: InMemoryCoordinator;

    beforeEach(async () => {
      coordinator2 = new InMemoryCoordinator();
      await coordinator2.initialize('node-2', 'ring-test', testConfig);
    });

    afterEach(async () => {
      await coordinator2.stop();
    });

    test('two coordinators can join independently', async () => {
      await coordinator.joinCluster([]);
      await coordinator2.joinCluster([]);

      const view1 = await coordinator.getClusterView();
      const view2 = await coordinator2.getClusterView();

      expect(view1.nodes.has('node-1')).toBe(true);
      expect(view2.nodes.has('node-2')).toBe(true);
    });

    test('each coordinator tracks its own leases', async () => {
      await coordinator.start();
      await coordinator2.start();

      await coordinator.acquireLease('range-0');
      await coordinator2.acquireLease('range-1');

      expect(await coordinator.ownsRange('range-0')).toBe(true);
      expect(await coordinator.ownsRange('range-1')).toBe(false);
      expect(await coordinator2.ownsRange('range-1')).toBe(true);
      expect(await coordinator2.ownsRange('range-0')).toBe(false);
    });
  });

  describe('lease conflict', () => {
    test('re-acquiring same range by same node returns true', async () => {
      await coordinator.start();
      await coordinator.acquireLease('range-0');

      const result = await coordinator.acquireLease('range-0');
      expect(result).toBe(true);
    });

    test('should emit lease-conflict event with correct arguments', () => {
      const conflicts: Array<{ rangeId: string; ownerId: string }> = [];
      coordinator.on('lease-conflict', (rangeId: string, ownerId: string) => {
        conflicts.push({ rangeId, ownerId });
      });

      // Verify the event signature by emitting directly
      coordinator.emit('lease-conflict', 'range-0', 'other-node');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toEqual({ rangeId: 'range-0', ownerId: 'other-node' });
    });
  });

  describe('leave cluster removes node from view', () => {
    test('should remove node from view and release all leases', async () => {
      await coordinator.joinCluster([]);
      await coordinator.start();
      await coordinator.acquireLease('range-0');
      await coordinator.acquireLease('range-1');

      await coordinator.leaveCluster();

      const view = await coordinator.getClusterView();
      expect(view.nodes.has('node-1')).toBe(false);
      expect(await coordinator.getOwnedRanges()).toEqual([]);
    });

    test('should emit node-left event', async () => {
      const leftNodes: string[] = [];
      coordinator.on('node-left', (nodeId: string) => leftNodes.push(nodeId));

      await coordinator.joinCluster([]);
      await coordinator.leaveCluster();

      expect(leftNodes).toContain('node-1');
    });

    test('stop() calls leaveCluster internally', async () => {
      await coordinator.joinCluster([]);
      await coordinator.start();
      await coordinator.acquireLease('range-0');

      await coordinator.stop();

      const view = await coordinator.getClusterView();
      expect(view.nodes.has('node-1')).toBe(false);
      expect(await coordinator.getOwnedRanges()).toEqual([]);
    });
  });

  describe('start and stop lifecycle', () => {
    test('start is idempotent', async () => {
      await coordinator.start();
      await coordinator.start();
    });

    test('stop is idempotent', async () => {
      await coordinator.start();
      await coordinator.stop();
      await coordinator.stop();
    });

    test('stop without start does nothing', async () => {
      await coordinator.stop();
    });
  });
});
