import { EventEmitter } from 'events';
import { EntityRegistryFactory } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { EntityRegistry } from '../../../../src/cluster/entity/types';
import { DistributedLock } from '../../../../src/cluster/locks/DistributedLock';
import { ClusterLeaderElection } from '../../../../src/cluster/locks/ClusterLeaderElection';
import { ResourceRouter } from '../../../../src/routing/ResourceRouter';
import { MembershipEntry } from '../../../../src/cluster/types';

const LEASE_MS = 15_000;
const RENEW_MS = 5_000;

function makeCluster(localNodeId: string) {
  const emitter = new EventEmitter();
  const membership = new Map<string, MembershipEntry>();

  membership.set(localNodeId, {
    id: localNodeId,
    status: 'ALIVE',
    lastSeen: Date.now(),
    version: 1,
    lastUpdated: Date.now(),
    metadata: { address: '127.0.0.1', port: 7000 },
  } as MembershipEntry);

  return {
    getMembership: () => membership,
    getLocalNodeInfo: () => ({ id: localNodeId, status: 'ALIVE', lastSeen: Date.now(), version: 1 }),
    on: (event: string, handler: (...args: any[]) => void) => emitter.on(event, handler),
    off: (event: string, handler: (...args: any[]) => void) => emitter.off(event, handler),
    emit: (event: string, ...args: any[]) => emitter.emit(event, ...args),
    _membership: membership,
  };
}

function makeClusterElection(
  registry: EntityRegistry,
  nodeId: string,
  cluster?: ReturnType<typeof makeCluster>
) {
  const lock = new DistributedLock(registry, nodeId, {
    defaultTtlMs: LEASE_MS,
    acquireTimeoutMs: 500,
    retryIntervalMs: 50,
  });
  const clusterManager = cluster ?? makeCluster(nodeId);
  const routerRegistry = EntityRegistryFactory.createMemory(nodeId, { enableTestMode: true });
  const router = new ResourceRouter(nodeId, routerRegistry, clusterManager as any);
  const election = new ClusterLeaderElection('group-1', nodeId, lock, router, {
    leaseDurationMs: LEASE_MS,
    renewIntervalMs: RENEW_MS,
  });
  return { election, router, lock };
}

describe('ClusterLeaderElection', () => {
  let registry: EntityRegistry;
  const cleanup: ClusterLeaderElection[] = [];

  beforeEach(async () => {
    jest.useFakeTimers();
    registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
  });

  afterEach(async () => {
    for (const election of cleanup.splice(0)) {
      try {
        await election.stop();
      } catch {
        // ignore
      }
    }
    jest.useRealTimers();
    await registry.stop();
  });

  it('start() causes the node to become leader and emits elected', async () => {
    const { election } = makeClusterElection(registry, 'node-1');
    cleanup.push(election);

    const elected = jest.fn();
    election.on('elected', elected);

    await election.start();

    expect(elected).toHaveBeenCalledTimes(1);
  });

  it('isLeader() returns true after election', async () => {
    const { election } = makeClusterElection(registry, 'node-1');
    cleanup.push(election);

    await election.start();

    expect(election.isLeader()).toBe(true);
  });

  it('getLeaderRoute() returns a non-null RouteTarget after election', async () => {
    const { election } = makeClusterElection(registry, 'node-1');
    cleanup.push(election);

    await election.start();

    const route = await election.getLeaderRoute();
    expect(route).not.toBeNull();
  });

  it('getLeaderRoute() returns isLocal: true when this node is the leader', async () => {
    const { election } = makeClusterElection(registry, 'node-1');
    cleanup.push(election);

    await election.start();

    const route = await election.getLeaderRoute();
    expect(route).not.toBeNull();
    expect(route!.isLocal).toBe(true);
    expect(route!.nodeId).toBe('node-1');
  });

  it('second node does NOT become leader while first holds it', async () => {
    const { election: e1 } = makeClusterElection(registry, 'node-1');
    const { election: e2 } = makeClusterElection(registry, 'node-2');
    cleanup.push(e1, e2);

    const elected2 = jest.fn();
    e2.on('elected', elected2);

    await e1.start();
    await e2.start();

    expect(e1.isLeader()).toBe(true);
    expect(e2.isLeader()).toBe(false);
    expect(elected2).not.toHaveBeenCalled();
  });

  it('after stop(), isLeader() returns false and deposed is emitted', async () => {
    const { election } = makeClusterElection(registry, 'node-1');
    cleanup.push(election);

    const deposed = jest.fn();
    election.on('deposed', deposed);

    await election.start();
    expect(election.isLeader()).toBe(true);

    await election.stop();
    expect(election.isLeader()).toBe(false);
    expect(deposed).toHaveBeenCalledTimes(1);
  });

  it('after first node stops, second node can acquire leadership', async () => {
    const { election: e1 } = makeClusterElection(registry, 'node-1');
    const { election: e2 } = makeClusterElection(registry, 'node-2');
    cleanup.push(e1, e2);

    const elected2 = jest.fn();
    e2.on('elected', elected2);

    await e1.start();
    await e2.start();

    expect(elected2).not.toHaveBeenCalled();

    await e1.stop();

    await jest.advanceTimersByTimeAsync(RENEW_MS + 100);

    expect(e2.isLeader()).toBe(true);
    expect(elected2).toHaveBeenCalledTimes(1);
  });

  it('getLeaderId() returns nodeId when leader, null otherwise', async () => {
    const { election: e1 } = makeClusterElection(registry, 'node-1');
    const { election: e2 } = makeClusterElection(registry, 'node-2');
    cleanup.push(e1, e2);

    await e1.start();
    await e2.start();

    expect(e1.getLeaderId()).toBe('node-1');
    expect(e2.getLeaderId()).toBeNull();
  });

  it('leader-changed is emitted with nodeId on election and null on deposition', async () => {
    const { election } = makeClusterElection(registry, 'node-1');
    cleanup.push(election);

    const leaderChanged = jest.fn();
    election.on('leader-changed', leaderChanged);

    await election.start();
    expect(leaderChanged).toHaveBeenCalledWith('node-1');

    await election.stop();
    expect(leaderChanged).toHaveBeenCalledWith(null);
    expect(leaderChanged).toHaveBeenCalledTimes(2);
  });

  it('getLeaderRoute() returns null when no leader holds the resource', async () => {
    const { election } = makeClusterElection(registry, 'node-1');
    cleanup.push(election);

    await election.start();
    expect(election.isLeader()).toBe(true);

    await election.stop();

    const route = await election.getLeaderRoute();
    expect(route).toBeNull();
  });
});
