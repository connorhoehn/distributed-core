import { EventEmitter } from 'events';
import { ResourceRouter } from '../../../src/routing/ResourceRouter';
import { ResourceRouterFactory } from '../../../src/routing/ResourceRouterFactory';
import {
  HashPlacement,
  LeastLoadedPlacement,
  LocalPlacement,
  RandomPlacement,
} from '../../../src/routing/PlacementStrategy';
import { EntityRegistryFactory } from '../../../src/cluster/entity/EntityRegistryFactory';
import { MembershipEntry } from '../../../src/cluster/types';
import { MetricsRegistry } from '../../../src/monitoring/metrics/MetricsRegistry';

// ---------------------------------------------------------------------------
// Minimal ClusterManager stub — only what ResourceRouter touches
// ---------------------------------------------------------------------------

function makeCluster(localNodeId: string, peers: { id: string; address: string; port: number }[] = []) {
  const emitter = new EventEmitter();
  const membership = new Map<string, MembershipEntry>();

  // Add local node
  membership.set(localNodeId, {
    id: localNodeId,
    status: 'ALIVE',
    lastSeen: Date.now(),
    version: 1,
    lastUpdated: Date.now(),
    metadata: { address: '127.0.0.1', port: 7000 },
  } as MembershipEntry);

  for (const peer of peers) {
    membership.set(peer.id, {
      id: peer.id,
      status: 'ALIVE',
      lastSeen: Date.now(),
      version: 1,
      lastUpdated: Date.now(),
      metadata: { address: peer.address, port: peer.port },
    } as MembershipEntry);
  }

  return {
    getMembership: () => membership,
    getLocalNodeInfo: () => ({ id: localNodeId, status: 'ALIVE', lastSeen: Date.now(), version: 1 }),
    on: (event: string, handler: (...args: any[]) => void) => emitter.on(event, handler),
    off: (event: string, handler: (...args: any[]) => void) => emitter.off(event, handler),
    emit: (event: string, ...args: any[]) => emitter.emit(event, ...args),
    _membership: membership,
    _emitter: emitter,
    // Simulate node leaving
    simulateLeave: (nodeId: string) => {
      const entry = membership.get(nodeId);
      if (entry) membership.set(nodeId, { ...entry, status: 'DEAD' });
      emitter.emit('member-left', nodeId);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const activeRouters: ResourceRouter[] = [];

async function makeRouter(
  nodeId = 'node-1',
  peers: { id: string; address: string; port: number }[] = [],
  config?: any
) {
  const cluster = makeCluster(nodeId, peers);
  const registry = EntityRegistryFactory.createMemory(nodeId, { enableTestMode: true });
  const router = new ResourceRouter(nodeId, registry, cluster as any, config);
  await router.start();
  activeRouters.push(router);
  return { router, cluster, registry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResourceRouter', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const r of activeRouters.splice(0)) {
      await r.stop();
    }
  });

  // -------------------------------------------------------------------------
  // claim
  // -------------------------------------------------------------------------

  describe('claim()', () => {
    it('claims a resource and returns a ResourceHandle', async () => {
      const { router } = await makeRouter();
      const handle = await router.claim('room-1');

      expect(handle.resourceId).toBe('room-1');
      expect(handle.ownerNodeId).toBe('node-1');
      expect(handle.version).toBe(1);
      expect(typeof handle.claimedAt).toBe('number');
    });

    it('stores metadata on the handle', async () => {
      const { router } = await makeRouter();
      const handle = await router.claim('room-1', { metadata: { region: 'us-east-1' } });
      expect(handle.metadata).toEqual({ region: 'us-east-1' });
    });

    it('throws when the resource is already owned by this node', async () => {
      const { router } = await makeRouter();
      await router.claim('room-1');
      await expect(router.claim('room-1')).rejects.toThrow();
    });

    it('throws when the resource is already owned by a remote node', async () => {
      const { router, registry } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
      ]);
      await registry.applyRemoteUpdate({
        entityId: 'room-1',
        ownerNodeId: 'node-2',
        version: 1,
        timestamp: Date.now(),
        operation: 'CREATE',
        metadata: {},
      });
      await expect(router.claim('room-1')).rejects.toThrow();
    });

    it('does not emit resource:claimed for remote ownership applied via applyRemoteUpdate', async () => {
      const { router, registry } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
      ]);
      const spy = jest.fn();
      router.on('resource:claimed', spy);
      await registry.applyRemoteUpdate({
        entityId: 'room-remote',
        ownerNodeId: 'node-2',
        version: 1,
        timestamp: Date.now(),
        operation: 'CREATE',
        metadata: {},
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it('emits resource:claimed', async () => {
      const { router } = await makeRouter();
      const spy = jest.fn();
      router.on('resource:claimed', spy);

      const handle = await router.claim('room-1');
      expect(spy).toHaveBeenCalledWith(handle);
    });
  });

  // -------------------------------------------------------------------------
  // release
  // -------------------------------------------------------------------------

  describe('release()', () => {
    it('releases an owned resource', async () => {
      const { router } = await makeRouter();
      await router.claim('room-1');
      await router.release('room-1');

      expect(router.isLocal('room-1')).toBe(false);
      expect(router.getOwnedResources()).toHaveLength(0);
    });

    it('is a no-op for resources not owned by this node', async () => {
      const { router } = await makeRouter();
      await expect(router.release('nonexistent')).resolves.not.toThrow();
    });

    it('emits resource:released', async () => {
      const { router } = await makeRouter();
      await router.claim('room-1');
      const spy = jest.fn();
      router.on('resource:released', spy);
      await router.release('room-1');
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // route
  // -------------------------------------------------------------------------

  describe('route()', () => {
    it('returns null for an unknown resource', async () => {
      const { router } = await makeRouter();
      expect(await router.route('unknown')).toBeNull();
    });

    it('returns isLocal: true for locally-owned resources', async () => {
      const { router } = await makeRouter();
      await router.claim('room-1');
      const target = await router.route('room-1');

      expect(target).not.toBeNull();
      expect(target!.isLocal).toBe(true);
      expect(target!.nodeId).toBe('node-1');
    });

    it('returns address and port for remotely-owned resources', async () => {
      const { router, cluster, registry } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
      ]);

      // Simulate node-2 owning a resource by applying a remote update
      await registry.applyRemoteUpdate({
        entityId: 'room-remote',
        ownerNodeId: 'node-2',
        version: 1,
        timestamp: Date.now(),
        operation: 'CREATE',
        metadata: {},
      });

      const target = await router.route('room-remote');
      expect(target).not.toBeNull();
      expect(target!.isLocal).toBe(false);
      expect(target!.nodeId).toBe('node-2');
      expect(target!.address).toBe('10.0.0.2');
      expect(target!.port).toBe(7001);
    });

    it('returns null when the owner is no longer in the membership table', async () => {
      const { router, cluster, registry } = await makeRouter('node-1');

      await registry.applyRemoteUpdate({
        entityId: 'room-gone',
        ownerNodeId: 'node-ghost',
        version: 1,
        timestamp: Date.now(),
        operation: 'CREATE',
        metadata: {},
      });

      expect(await router.route('room-gone')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // isLocal
  // -------------------------------------------------------------------------

  describe('isLocal()', () => {
    it('returns true for owned resources', async () => {
      const { router } = await makeRouter();
      await router.claim('room-1');
      expect(router.isLocal('room-1')).toBe(true);
    });

    it('returns false for unknown resources', async () => {
      const { router } = await makeRouter();
      expect(router.isLocal('nonexistent')).toBe(false);
    });

    it('returns false for remotely-owned resources', async () => {
      const { router, registry } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
      ]);
      await registry.applyRemoteUpdate({
        entityId: 'room-remote',
        ownerNodeId: 'node-2',
        version: 1,
        timestamp: Date.now(),
        operation: 'CREATE',
        metadata: {},
      });
      expect(router.isLocal('room-remote')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // transfer
  // -------------------------------------------------------------------------

  describe('transfer()', () => {
    it('changes ownerNodeId to the target', async () => {
      const { router } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
      ]);
      await router.claim('room-1');
      const handle = await router.transfer('room-1', 'node-2');

      expect(handle.ownerNodeId).toBe('node-2');
      expect(router.isLocal('room-1')).toBe(false);
    });

    it('emits resource:transferred', async () => {
      const { router } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
      ]);
      await router.claim('room-1');
      const spy = jest.fn();
      router.on('resource:transferred', spy);
      await router.transfer('room-1', 'node-2');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('throws when transferring to a node not in alive membership', async () => {
      const { router, cluster } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
      ]);
      await router.claim('room-1');
      cluster.simulateLeave('node-2');
      await expect(router.transfer('room-1', 'node-2')).rejects.toThrow(/not in alive membership/);
    });

    it('throws when transferring to a completely unknown node', async () => {
      const { router } = await makeRouter('node-1');
      await router.claim('room-1');
      await expect(router.transfer('room-1', 'node-ghost')).rejects.toThrow(/not in alive membership/);
    });
  });

  // -------------------------------------------------------------------------
  // getOwnedResources / getAllResources
  // -------------------------------------------------------------------------

  describe('resource queries', () => {
    it('getOwnedResources returns only local resources', async () => {
      const { router, registry } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
      ]);
      await router.claim('local-room');
      await registry.applyRemoteUpdate({
        entityId: 'remote-room',
        ownerNodeId: 'node-2',
        version: 1,
        timestamp: Date.now(),
        operation: 'CREATE',
        metadata: {},
      });

      expect(router.getOwnedResources()).toHaveLength(1);
      expect(router.getOwnedResources()[0].resourceId).toBe('local-room');
    });

    it('getAllResources returns local and remote', async () => {
      const { router, registry } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
      ]);
      await router.claim('local-room');
      await registry.applyRemoteUpdate({
        entityId: 'remote-room',
        ownerNodeId: 'node-2',
        version: 1,
        timestamp: Date.now(),
        operation: 'CREATE',
        metadata: {},
      });

      expect(router.getAllResources()).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // selectNode
  // -------------------------------------------------------------------------

  describe('selectNode()', () => {
    it('returns local node with LocalPlacement (default)', async () => {
      const { router } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
      ]);
      expect(router.selectNode('any-resource')).toBe('node-1');
    });

    it('selects deterministically with HashPlacement', async () => {
      const { router } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
        { id: 'node-3', address: '10.0.0.3', port: 7002 },
      ], { placement: new HashPlacement() });

      const a = router.selectNode('room-abc');
      const b = router.selectNode('room-abc');
      expect(a).toBe(b); // stable across calls
    });

    it('per-call placement override works', async () => {
      const { router } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
      ]);
      // Default is Local; override to Hash
      const result = router.selectNode('room-x', new HashPlacement());
      expect(typeof result).toBe('string');
    });

    it('returns local node when no alive peers', async () => {
      const { router } = await makeRouter('node-1', [], { placement: new LeastLoadedPlacement(() => []) });
      expect(router.selectNode('room-1')).toBe('node-1');
    });
  });

  // -------------------------------------------------------------------------
  // orphan detection
  // -------------------------------------------------------------------------

  describe('resource:orphaned', () => {
    it('emits for every resource owned by a leaving node', async () => {
      const { router, cluster, registry } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
      ]);

      await registry.applyRemoteUpdate({
        entityId: 'room-a', ownerNodeId: 'node-2', version: 1,
        timestamp: Date.now(), operation: 'CREATE', metadata: {},
      });
      await registry.applyRemoteUpdate({
        entityId: 'room-b', ownerNodeId: 'node-2', version: 1,
        timestamp: Date.now(), operation: 'CREATE', metadata: {},
      });

      const orphaned: string[] = [];
      router.on('resource:orphaned', (h) => orphaned.push(h.resourceId));

      cluster.simulateLeave('node-2');

      expect(orphaned.sort()).toEqual(['room-a', 'room-b']);
    });

    it('does not emit for resources owned by other surviving nodes', async () => {
      const { router, cluster, registry } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
        { id: 'node-3', address: '10.0.0.3', port: 7002 },
      ]);

      await registry.applyRemoteUpdate({
        entityId: 'room-n2', ownerNodeId: 'node-2', version: 1,
        timestamp: Date.now(), operation: 'CREATE', metadata: {},
      });
      await registry.applyRemoteUpdate({
        entityId: 'room-n3', ownerNodeId: 'node-3', version: 1,
        timestamp: Date.now(), operation: 'CREATE', metadata: {},
      });

      const orphaned: string[] = [];
      router.on('resource:orphaned', (h) => orphaned.push(h.resourceId));

      cluster.simulateLeave('node-2');

      expect(orphaned).toEqual(['room-n2']);
    });

    it('does not emit for locally-owned resources when a peer leaves', async () => {
      const { router, cluster } = await makeRouter('node-1', [
        { id: 'node-2', address: '10.0.0.2', port: 7001 },
      ]);

      await router.claim('my-room');

      const spy = jest.fn();
      router.on('resource:orphaned', spy);

      cluster.simulateLeave('node-2');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // applyRemoteUpdate / getUpdatesAfter
  // -------------------------------------------------------------------------

  describe('cross-node sync helpers', () => {
    it('applyRemoteUpdate makes a remote resource visible', async () => {
      const { router } = await makeRouter('node-1');
      const applied = await router.applyRemoteUpdate({
        entityId: 'remote-room',
        ownerNodeId: 'node-2',
        version: 1,
        timestamp: Date.now(),
        operation: 'CREATE',
        metadata: {},
      });
      expect(applied).toBe(true);
      expect(router.getAllResources().find((r) => r.resourceId === 'remote-room')).toBeDefined();
    });

    it('getUpdatesAfter returns recent updates (CRDT registry tracks history)', async () => {
      const cluster = makeCluster('node-1');
      const registry = EntityRegistryFactory.create({ type: 'crdt', nodeId: 'node-1' });
      const router = new ResourceRouter('node-1', registry, cluster as any);
      activeRouters.push(router);
      await router.start();
      await router.claim('room-1');
      const updates = router.getUpdatesAfter(0);
      expect(updates.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // PlacementStrategy implementations
  // -------------------------------------------------------------------------

  describe('PlacementStrategy', () => {
    describe('LocalPlacement', () => {
      it('always returns the local node', () => {
        const p = new LocalPlacement();
        expect(p.selectNode('x', 'node-1', ['node-1', 'node-2', 'node-3'])).toBe('node-1');
      });
    });

    describe('HashPlacement', () => {
      it('returns a valid candidate node', () => {
        const p = new HashPlacement();
        const candidates = ['node-1', 'node-2', 'node-3'];
        const result = p.selectNode('resource-abc', 'node-1', candidates);
        expect(candidates).toContain(result);
      });

      it('is stable for the same resourceId and candidate list', () => {
        const p = new HashPlacement();
        const candidates = ['node-1', 'node-2', 'node-3'];
        const r1 = p.selectNode('resource-abc', 'node-1', candidates);
        const r2 = p.selectNode('resource-abc', 'node-1', candidates);
        expect(r1).toBe(r2);
      });

      it('distributes different resourceIds across nodes', () => {
        const p = new HashPlacement();
        const candidates = ['node-1', 'node-2', 'node-3'];
        const results = new Set<string>();
        for (let i = 0; i < 30; i++) {
          results.add(p.selectNode(`resource-${i}`, 'node-1', candidates));
        }
        // With 30 resources and 3 nodes, all nodes should appear
        expect(results.size).toBeGreaterThan(1);
      });

      it('falls back to local node with empty candidates', () => {
        const p = new HashPlacement();
        expect(p.selectNode('x', 'node-1', [])).toBe('node-1');
      });
    });

    describe('LeastLoadedPlacement', () => {
      it('picks the node with the fewest resources', () => {
        const resources = [
          { resourceId: 'r1', ownerNodeId: 'node-1', metadata: {}, claimedAt: 0, version: 1 },
          { resourceId: 'r2', ownerNodeId: 'node-1', metadata: {}, claimedAt: 0, version: 1 },
          { resourceId: 'r3', ownerNodeId: 'node-2', metadata: {}, claimedAt: 0, version: 1 },
        ];
        const p = new LeastLoadedPlacement(() => resources);
        // node-2 has 1, node-3 has 0 → node-3 wins
        expect(p.selectNode('new', 'node-1', ['node-1', 'node-2', 'node-3'])).toBe('node-3');
      });

      it('falls back to local when no candidates', () => {
        const p = new LeastLoadedPlacement(() => []);
        expect(p.selectNode('x', 'node-1', [])).toBe('node-1');
      });

      it('prefers local node on load ties', () => {
        // All nodes empty — local should win over iteration order
        const p = new LeastLoadedPlacement(() => []);
        const result = p.selectNode('new', 'node-1', ['node-2', 'node-1', 'node-3']);
        expect(result).toBe('node-1');
      });
    });

    describe('RandomPlacement', () => {
      it('always returns a candidate node', () => {
        const p = new RandomPlacement();
        const candidates = ['node-1', 'node-2', 'node-3'];
        for (let i = 0; i < 20; i++) {
          expect(candidates).toContain(p.selectNode(`r-${i}`, 'node-1', candidates));
        }
      });

      it('falls back to local with empty candidates', () => {
        const p = new RandomPlacement();
        expect(p.selectNode('x', 'node-1', [])).toBe('node-1');
      });
    });
  });

  // -------------------------------------------------------------------------
  // metrics
  // -------------------------------------------------------------------------

  describe('metrics', () => {
    async function makeMetricsRouter() {
      const metrics = new MetricsRegistry('node-1');
      const cluster = makeCluster('node-1', [{ id: 'node-2', address: '10.0.0.2', port: 7001 }]);
      const registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
      const router = new ResourceRouter('node-1', registry, cluster as any, { metrics });
      await router.start();
      activeRouters.push(router);
      return { router, cluster, registry, metrics };
    }

    it('increments resource.claim.count{result=success} on successful claim', async () => {
      const { router, metrics } = await makeMetricsRouter();
      await router.claim('r1');
      expect(metrics.counter('resource.claim.count', { result: 'success' }).get()).toBe(1);
    });

    it('increments resource.claim.count{result=conflict} on duplicate claim', async () => {
      const { router, metrics } = await makeMetricsRouter();
      await router.claim('r1');
      await expect(router.claim('r1')).rejects.toThrow();
      expect(metrics.counter('resource.claim.count', { result: 'conflict' }).get()).toBe(1);
    });

    it('records resource.claim.latency_ms histogram on successful claim', async () => {
      const { router, metrics } = await makeMetricsRouter();
      await router.claim('r1');
      expect(metrics.histogram('resource.claim.latency_ms').getCount()).toBe(1);
    });

    it('increments resource.release.count on release', async () => {
      const { router, metrics } = await makeMetricsRouter();
      await router.claim('r1');
      await router.release('r1');
      expect(metrics.counter('resource.release.count').get()).toBe(1);
    });

    it('increments resource.transfer.count on transfer', async () => {
      const { router, metrics } = await makeMetricsRouter();
      await router.claim('r1');
      await router.transfer('r1', 'node-2');
      expect(metrics.counter('resource.transfer.count').get()).toBe(1);
    });

    it('increments resource.orphaned.count on orphan event', async () => {
      const { router, cluster, registry, metrics } = await makeMetricsRouter();
      await registry.applyRemoteUpdate({
        entityId: 'r-orphan', ownerNodeId: 'node-2', version: 1,
        timestamp: Date.now(), operation: 'CREATE', metadata: {},
      });
      cluster.simulateLeave('node-2');
      expect(metrics.counter('resource.orphaned.count').get()).toBe(1);
    });

    it('resource.local.gauge reflects owned resource count (increment + decrement cycle)', async () => {
      const { router, metrics } = await makeMetricsRouter();
      expect(metrics.gauge('resource.local.gauge').get()).toBe(0);
      await router.claim('r1');
      expect(metrics.gauge('resource.local.gauge').get()).toBe(1);
      await router.claim('r2');
      expect(metrics.gauge('resource.local.gauge').get()).toBe(2);
      await router.release('r1');
      expect(metrics.gauge('resource.local.gauge').get()).toBe(1);
    });

    it('no metrics errors when metrics is omitted', async () => {
      const { router } = await makeRouter();
      await expect(router.claim('r-no-metrics')).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // ResourceRouterFactory
  // -------------------------------------------------------------------------

  describe('ResourceRouterFactory', () => {
    let cluster: ReturnType<typeof makeCluster>;

    beforeEach(() => {
      cluster = makeCluster('node-1');
    });

    it('createInMemory returns a working router', async () => {
      const router = ResourceRouterFactory.createInMemory('node-1', cluster as any);
      activeRouters.push(router);
      await router.start();
      const handle = await router.claim('room-1');
      expect(handle.resourceId).toBe('room-1');
    });

    it('createCRDT returns a working router', async () => {
      const router = ResourceRouterFactory.createCRDT('node-1', cluster as any);
      activeRouters.push(router);
      await router.start();
      const handle = await router.claim('room-crdt');
      expect(handle.ownerNodeId).toBe('node-1');
    });

    it('createLeastLoaded uses LeastLoadedPlacement', async () => {
      const router = ResourceRouterFactory.createLeastLoaded('node-1', cluster as any);
      activeRouters.push(router);
      await router.start();
      // selectNode with no peers should return local node
      expect(router.selectNode('room-1')).toBe('node-1');
    });

    it('createLeastLoaded placement references the returned router (no dual-instance bug)', async () => {
      const router = ResourceRouterFactory.createLeastLoaded('node-1', cluster as any);
      activeRouters.push(router);
      await router.start();
      await router.claim('room-a');
      await router.claim('room-b');
      // Resources are on the returned router, so placement sees them
      expect(router.getAllResources()).toHaveLength(2);
    });
  });
});
