import { EntityRegistryFactory } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { EntityRegistry } from '../../../../src/cluster/entity/types';
import { DistributedLock } from '../../../../src/cluster/locks/DistributedLock';
import { LeaderElection } from '../../../../src/cluster/locks/LeaderElection';

const LEASE_MS = 15_000;
const RENEW_MS = 5_000;

function makeElection(registry: EntityRegistry, nodeId: string) {
  const lock = new DistributedLock(registry, nodeId, {
    defaultTtlMs: LEASE_MS,
    acquireTimeoutMs: 500,
    retryIntervalMs: 50,
  });
  const election = new LeaderElection('group-1', nodeId, lock, {
    leaseDurationMs: LEASE_MS,
    renewIntervalMs: RENEW_MS,
  });
  return { lock, election };
}

describe('LeaderElection', () => {
  let registry: EntityRegistry;

  beforeEach(async () => {
    jest.useFakeTimers();
    registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await registry.stop();
  });

  it('start immediately tries to become leader and emits elected', async () => {
    const { election } = makeElection(registry, 'node-1');

    const elected = jest.fn();
    election.on('elected', elected);

    await election.start();

    expect(elected).toHaveBeenCalledTimes(1);
    expect(election.isLeader()).toBe(true);

    await election.stop();
  });

  it('second node does NOT become leader when first already holds it', async () => {
    const { election: e1 } = makeElection(registry, 'node-1');
    const { election: e2 } = makeElection(registry, 'node-2');

    const elected2 = jest.fn();
    e2.on('elected', elected2);

    await e1.start();
    await e2.start();

    expect(e1.isLeader()).toBe(true);
    expect(e2.isLeader()).toBe(false);
    expect(elected2).not.toHaveBeenCalled();

    await e1.stop();
    await e2.stop();
  });

  it('stop emits deposed and releases the lock', async () => {
    const { election } = makeElection(registry, 'node-1');

    const deposed = jest.fn();
    election.on('deposed', deposed);

    await election.start();
    expect(election.isLeader()).toBe(true);

    await election.stop();
    expect(deposed).toHaveBeenCalledTimes(1);
    expect(election.isLeader()).toBe(false);
  });

  it('second node becomes leader after first stops', async () => {
    const { election: e1 } = makeElection(registry, 'node-1');
    const { election: e2 } = makeElection(registry, 'node-2');

    const elected2 = jest.fn();
    e2.on('elected', elected2);

    await e1.start();
    await e2.start();
    expect(elected2).not.toHaveBeenCalled();

    await e1.stop();

    await jest.advanceTimersByTimeAsync(RENEW_MS + 100);

    expect(e2.isLeader()).toBe(true);
    expect(elected2).toHaveBeenCalledTimes(1);

    await e2.stop();
  });

  it('isLeader returns true only for the current leader', async () => {
    const { election: e1 } = makeElection(registry, 'node-1');
    const { election: e2 } = makeElection(registry, 'node-2');

    await e1.start();
    await e2.start();

    expect(e1.isLeader()).toBe(true);
    expect(e2.isLeader()).toBe(false);

    await e1.stop();
    await e2.stop();
  });

  it('leader-changed emits nodeId on election and null on deposition', async () => {
    const { election } = makeElection(registry, 'node-1');

    const leaderChanged = jest.fn();
    election.on('leader-changed', leaderChanged);

    await election.start();
    expect(leaderChanged).toHaveBeenCalledWith('node-1');

    await election.stop();
    expect(leaderChanged).toHaveBeenCalledWith(null);
    expect(leaderChanged).toHaveBeenCalledTimes(2);
  });

  it('getLeaderId returns nodeId when leader, null otherwise', async () => {
    const { election: e1 } = makeElection(registry, 'node-1');
    const { election: e2 } = makeElection(registry, 'node-2');

    await e1.start();
    await e2.start();

    expect(e1.getLeaderId()).toBe('node-1');
    expect(e2.getLeaderId()).toBeNull();

    await e1.stop();
    await e2.stop();
  });

  it('renewal keeps leader status across multiple renew cycles', async () => {
    const { election } = makeElection(registry, 'node-1');

    await election.start();
    expect(election.isLeader()).toBe(true);

    for (let i = 0; i < 3; i++) {
      await jest.advanceTimersByTimeAsync(RENEW_MS);
      expect(election.isLeader()).toBe(true);
    }

    await election.stop();
  });

  it('emits deposed when lock extend fails due to external release', async () => {
    const { election } = makeElection(registry, 'node-1');

    const deposed = jest.fn();
    const leaderChanged = jest.fn();
    election.on('deposed', deposed);
    election.on('leader-changed', leaderChanged);

    await election.start();
    expect(election.isLeader()).toBe(true);

    await registry.releaseEntity('election:group-1');

    await jest.advanceTimersByTimeAsync(RENEW_MS + 100);

    expect(deposed).toHaveBeenCalled();
    expect(leaderChanged).toHaveBeenCalledWith(null);
    expect(election.isLeader()).toBe(false);

    await election.stop();
  });
});
