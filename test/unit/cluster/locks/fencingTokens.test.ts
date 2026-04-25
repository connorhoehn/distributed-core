import { EventEmitter } from 'events';
import { EntityRegistryFactory } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { EntityRegistry } from '../../../../src/cluster/entity/types';
import { DistributedLock, LockHandle } from '../../../../src/cluster/locks/DistributedLock';
import { LeaderElection } from '../../../../src/cluster/locks/LeaderElection';
import { ClusterLeaderElection } from '../../../../src/cluster/locks/ClusterLeaderElection';
import { QuorumDistributedLock } from '../../../../src/cluster/locks/QuorumDistributedLock';
import { ResourceRouter } from '../../../../src/routing/ResourceRouter';
import { MembershipEntry } from '../../../../src/cluster/types';
import { PubSubMessageMetadata } from '../../../../src/gateway/pubsub/types';
import { StaleLeaderError, CoreError } from '../../../../src/common/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCluster(localNodeId: string, allNodeIds: string[] = [localNodeId]) {
  const emitter = new EventEmitter();
  const membership = new Map<string, MembershipEntry>();

  for (const id of allNodeIds) {
    membership.set(id, {
      id,
      status: 'ALIVE',
      lastSeen: Date.now(),
      version: 1,
      lastUpdated: Date.now(),
      metadata: { address: '127.0.0.1', port: 7000 },
    } as MembershipEntry);
  }

  return {
    getMembership: () => membership,
    getLocalNodeInfo: () => ({ id: localNodeId, status: 'ALIVE', lastSeen: Date.now(), version: 1 }),
    on: (event: string, handler: (...args: any[]) => void) => emitter.on(event, handler),
    off: (event: string, handler: (...args: any[]) => void) => emitter.off(event, handler),
    emit: (event: string, ...args: any[]) => emitter.emit(event, ...args),
  };
}

function makeSharedPubSub() {
  const subs: Array<{ nodeId: string; topic: string; handler: any; id: string }> = [];
  let idCounter = 0;
  return {
    bind(nodeId: string) {
      return {
        subscribe: (topic: string, h: any) => {
          const id = `${nodeId}-${idCounter++}`;
          subs.push({ nodeId, topic, handler: h, id });
          return id;
        },
        unsubscribe: jest.fn((subId: string) => {
          const idx = subs.findIndex((s) => s.id === subId);
          if (idx !== -1) subs.splice(idx, 1);
        }),
        publish: async (topic: string, payload: unknown) => {
          const meta: PubSubMessageMetadata = {
            publisherNodeId: nodeId,
            messageId: `msg-${idCounter++}`,
            timestamp: Date.now(),
            topic,
          };
          for (const s of [...subs]) {
            if (s.topic === topic) {
              s.handler(topic, payload, meta);
            }
          }
        },
      } as any;
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// DistributedLock — fencing tokens
// ---------------------------------------------------------------------------

describe('DistributedLock fencing tokens', () => {
  let registry: EntityRegistry;
  let lockA: DistributedLock;
  let lockB: DistributedLock;

  beforeEach(async () => {
    registry = EntityRegistryFactory.createMemory('node-A', { enableTestMode: true });
    await registry.start();
    lockA = new DistributedLock(registry, 'node-A', {
      defaultTtlMs: 60_000,
      acquireTimeoutMs: 500,
      retryIntervalMs: 50,
    });
    lockB = new DistributedLock(registry, 'node-B', {
      defaultTtlMs: 60_000,
      acquireTimeoutMs: 500,
      retryIntervalMs: 50,
    });
  });

  afterEach(async () => {
    await registry.stop();
  });

  it('LockHandle exposes a bigint fencingToken on tryAcquire', async () => {
    const handle = await lockA.tryAcquire('lock-1');
    expect(handle).not.toBeNull();
    expect(typeof handle!.fencingToken).toBe('bigint');
    expect(handle!.fencingToken).toBe(1n);
  });

  it('fencingToken is monotonically increasing across acquire/release/acquire', async () => {
    const h1 = await lockA.tryAcquire('lock-mono');
    expect(h1!.fencingToken).toBe(1n);
    await lockA.release(h1!);

    const h2 = await lockB.tryAcquire('lock-mono');
    expect(h2!.fencingToken).toBe(2n);
    await lockB.release(h2!);

    const h3 = await lockA.tryAcquire('lock-mono');
    expect(h3!.fencingToken).toBe(3n);
    await lockA.release(h3!);
  });

  it('fencingToken is bumped on extend()', async () => {
    const h1 = await lockA.tryAcquire('lock-extend');
    expect(h1!.fencingToken).toBe(1n);

    const h2 = await lockA.extend(h1!, 30_000);
    expect(h2.fencingToken).toBe(2n);
    expect(h2.fencingToken > h1!.fencingToken).toBe(true);
  });

  it('fencingToken is per-lockId — different locks have independent counters', async () => {
    const hA = await lockA.tryAcquire('lock-X');
    const hB = await lockA.tryAcquire('lock-Y');
    expect(hA!.fencingToken).toBe(1n);
    expect(hB!.fencingToken).toBe(1n);
  });

  it('getCurrentFencingToken reflects the latest persisted token', async () => {
    expect(lockA.getCurrentFencingToken('lock-q')).toBe(0n);
    const h = await lockA.tryAcquire('lock-q');
    expect(lockA.getCurrentFencingToken('lock-q')).toBe(1n);
    await lockA.release(h!);
    // Sidecar persists past release.
    expect(lockA.getCurrentFencingToken('lock-q')).toBe(1n);
  });

  // -------------------------------------------------------------------------
  // The canonical "stale leader" scenario: A acquires, B simulates a partition
  // and also acquires (token now higher); A's later write should be rejected
  // by an example acceptance gate that compares the held token to the highest
  // seen.
  // -------------------------------------------------------------------------
  it('stale-leader scenario: example acceptance gate rejects writes with stale token', async () => {
    // A acquires the lock.
    const tokenA = (await lockA.tryAcquire('shared-resource'))!.fencingToken;
    expect(tokenA).toBe(1n);

    // Simulate a partition / failover: A is unreachable. The cluster
    // (here, B with the registry's view) re-acquires by first deleting the
    // lock entity remotely (mimicking handleRemoteNodeFailure) and then
    // acquiring fresh.
    await registry.applyRemoteUpdate({
      entityId: 'shared-resource',
      ownerNodeId: 'node-A',
      version: Date.now(),
      timestamp: Date.now(),
      operation: 'DELETE',
      metadata: {},
    });

    const tokenB = (await lockB.tryAcquire('shared-resource'))!.fencingToken;
    expect(tokenB).toBe(2n);
    expect(tokenB > tokenA).toBe(true);

    // Acceptance gate: a downstream service tracks the highest fencing
    // token it has accepted per resource and rejects writes with a lower
    // token. Standard Kleppmann pattern.
    class AcceptanceGate {
      private highestAccepted = new Map<string, bigint>();
      accept(resourceId: string, token: bigint): boolean {
        const seen = this.highestAccepted.get(resourceId) ?? 0n;
        if (token <= seen) return false; // stale write rejected
        this.highestAccepted.set(resourceId, token);
        return true;
      }
    }

    const gate = new AcceptanceGate();

    // B's write lands first.
    expect(gate.accept('shared-resource', tokenB)).toBe(true);
    // A's stale write — comes in late, e.g. after a long GC pause —
    // must be rejected.
    expect(gate.accept('shared-resource', tokenA)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// QuorumDistributedLock — fencing tokens
// ---------------------------------------------------------------------------

describe('QuorumDistributedLock fencing tokens', () => {
  it('single-node grant returns a strictly-increasing bigint token', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    const cluster = makeCluster('n1', ['n1']);
    const lock = new QuorumDistributedLock('n1', shared.bind('n1'), cluster as any, {
      ackTimeoutMs: 100,
      defaultTtlMs: 60_000,
    });
    await lock.start();

    const h1 = await lock.tryAcquire('q-lock');
    expect(h1).not.toBeNull();
    expect(typeof h1!.fencingToken).toBe('bigint');
    expect(h1!.fencingToken).toBe(1n);

    await lock.release(h1!);
    await flushMicrotasks();

    const h2 = await lock.tryAcquire('q-lock');
    expect(h2!.fencingToken).toBe(2n);

    await lock.stop();
    jest.useRealTimers();
  });

  it('three-node majority grant: tokens are monotonic across nodes', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    const cluster = makeCluster('n1', ['n1', 'n2', 'n3']);

    const l1 = new QuorumDistributedLock('n1', shared.bind('n1'), cluster as any, { ackTimeoutMs: 100, defaultTtlMs: 60_000 });
    const l2 = new QuorumDistributedLock('n2', shared.bind('n2'), cluster as any, { ackTimeoutMs: 100, defaultTtlMs: 60_000 });
    const l3 = new QuorumDistributedLock('n3', shared.bind('n3'), cluster as any, { ackTimeoutMs: 100, defaultTtlMs: 60_000 });
    await l1.start();
    await l2.start();
    await l3.start();

    const h1 = await l1.tryAcquire('q-cross');
    await flushMicrotasks();
    expect(h1!.fencingToken).toBe(1n);
    await l1.release(h1!);
    await flushMicrotasks();

    const h2 = await l2.tryAcquire('q-cross');
    await flushMicrotasks();
    expect(h2!.fencingToken).toBeGreaterThan(h1!.fencingToken);
    expect(h2!.fencingToken).toBe(2n);
    await l2.release(h2!);
    await flushMicrotasks();

    const h3 = await l3.tryAcquire('q-cross');
    await flushMicrotasks();
    expect(h3!.fencingToken).toBe(3n);

    await Promise.all([l1.stop(), l2.stop(), l3.stop()]);
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// ClusterLeaderElection — currentEpoch and guard
// ---------------------------------------------------------------------------

describe('ClusterLeaderElection currentEpoch / guard', () => {
  let registry: EntityRegistry;
  const cleanup: ClusterLeaderElection[] = [];

  beforeEach(async () => {
    registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
  });

  afterEach(async () => {
    for (const e of cleanup.splice(0)) {
      try { await e.stop(); } catch { /* ignore */ }
    }
    await registry.stop();
  });

  function makeElection(nodeId: string) {
    const lock = new DistributedLock(registry, nodeId, {
      defaultTtlMs: 60_000,
      acquireTimeoutMs: 500,
      retryIntervalMs: 50,
    });
    const cluster = makeCluster(nodeId);
    const routerRegistry = EntityRegistryFactory.createMemory(nodeId, { enableTestMode: true });
    const router = new ResourceRouter(nodeId, routerRegistry, cluster as any);
    const election = new ClusterLeaderElection('group-fence', nodeId, lock, router, {
      leaseDurationMs: 60_000,
      renewIntervalMs: 30_000,
    });
    cleanup.push(election);
    return { election, lock };
  }

  it('currentEpoch() returns the fencing token of the held lease', async () => {
    const { election } = makeElection('node-1');
    await election.start();
    expect(election.isLeader()).toBe(true);
    const epoch = election.currentEpoch();
    expect(typeof epoch).toBe('bigint');
    expect(epoch).toBe(1n);
  });

  it('currentEpoch() throws when not leader', async () => {
    const { election } = makeElection('node-1');
    // Not started — never elected.
    expect(() => election.currentEpoch()).toThrow();
  });

  it('guard() resolves with the function result when no token change occurs', async () => {
    const { election } = makeElection('node-1');
    await election.start();

    const result = await election.guard(async (epoch) => {
      expect(epoch).toBe(1n);
      return 'ok';
    });
    expect(result).toBe('ok');
  });

  it('guard() rejects with StaleLeaderError when the lock is mutated during execution', async () => {
    const { election, lock } = makeElection('node-1');
    await election.start();
    const startedEpoch = election.currentEpoch();
    expect(startedEpoch).toBe(1n);

    // Simulate the lease being lost & re-acquired (with a higher token)
    // mid-flight by externally bumping the fencing-token sidecar via a
    // remote update. This mirrors the partition scenario described in
    // GAPS doc §1.
    const bumpExternally = async () => {
      // Bump the sidecar to a higher token directly; in a real scenario
      // a remote node would call tryAcquire() which would do this.
      const fenceId = '__fence__:election:group-fence';
      const existing = registry.getEntity(fenceId);
      const next = (existing
        ? BigInt((existing.metadata as any).fencingToken)
        : 0n) + 1n;
      await registry.applyRemoteUpdate({
        entityId: fenceId,
        ownerNodeId: 'node-2',
        version: Number(next),
        timestamp: Date.now(),
        operation: 'UPDATE',
        metadata: { fencingToken: next.toString() },
      });
    };

    const guarded = election.guard(async (epoch) => {
      expect(epoch).toBe(startedEpoch);
      // Mutate during the delay.
      await bumpExternally();
      // Sanity: the registry sidecar now reports a higher token than ours.
      expect(lock.getCurrentFencingToken('election:group-fence') > epoch).toBe(true);
      return 'should-not-be-returned';
    });

    const err = await guarded.catch((e) => e);
    expect(err).toBeInstanceOf(CoreError);
    expect(err).toBeInstanceOf(StaleLeaderError);
    expect((err as StaleLeaderError).heldEpoch).toBe(startedEpoch);
    expect((err as StaleLeaderError).observedEpoch).not.toBeNull();
    expect((err as StaleLeaderError).observedEpoch! > startedEpoch).toBe(true);
  });

  it('guard() rejects with StaleLeaderError when leadership is lost mid-flight', async () => {
    const { election } = makeElection('node-1');
    await election.start();
    const startedEpoch = election.currentEpoch();

    const guarded = election.guard(async () => {
      // Stop the election (mimics a deposition / lease loss). Using a
      // direct stop is the cleanest local trigger.
      await election.stop();
      return 'should-not-be-returned';
    });

    const err = await guarded.catch((e) => e);
    expect(err).toBeInstanceOf(StaleLeaderError);
    expect((err as StaleLeaderError).heldEpoch).toBe(startedEpoch);
    // Lock no longer held → observedEpoch is null.
    expect((err as StaleLeaderError).observedEpoch).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inner LeaderElection: fencing-token integration
// ---------------------------------------------------------------------------

describe('LeaderElection fencing tokens', () => {
  let registry: EntityRegistry;

  beforeEach(async () => {
    registry = EntityRegistryFactory.createMemory('node-1', { enableTestMode: true });
    await registry.start();
  });

  afterEach(async () => {
    await registry.stop();
  });

  it('getCurrentHandle and currentEpoch reflect the held lease', async () => {
    const lock = new DistributedLock(registry, 'node-1', {
      defaultTtlMs: 60_000,
      acquireTimeoutMs: 500,
      retryIntervalMs: 50,
    });
    const election = new LeaderElection('lg', 'node-1', lock, {
      leaseDurationMs: 60_000,
      renewIntervalMs: 30_000,
    });

    await election.start();
    const handle = election.getCurrentHandle();
    expect(handle).not.toBeNull();
    expect((handle as LockHandle).fencingToken).toBe(1n);
    expect(election.currentEpoch()).toBe(1n);

    await election.stop();
    expect(election.getCurrentHandle()).toBeNull();
    expect(() => election.currentEpoch()).toThrow();
  });
});
