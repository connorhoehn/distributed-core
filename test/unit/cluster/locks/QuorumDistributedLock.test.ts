import { QuorumDistributedLock, QuorumDistributedLockConfig } from '../../../../src/cluster/locks/QuorumDistributedLock';
import { LockHandle } from '../../../../src/cluster/locks/DistributedLock';
import { PubSubMessageMetadata } from '../../../../src/gateway/pubsub/types';
import { MembershipEntry } from '../../../../src/cluster/types';

// ---------------------------------------------------------------------------
// Shared in-process PubSub mock — delivers synchronously to all subscribers
// ---------------------------------------------------------------------------

function makeSharedPubSub() {
  const subs: Array<{ nodeId: string; topic: string; handler: any; id: string }> = [];
  let idCounter = 0;

  return {
    bind(nodeId: string) {
      const pubsub = {
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
      };
      return pubsub as any;
    },
  };
}

// ---------------------------------------------------------------------------
// ClusterManager stub
// ---------------------------------------------------------------------------

function makeCluster(nodeIds: string[]) {
  const membership = new Map<string, MembershipEntry>();
  for (const id of nodeIds) {
    membership.set(id, {
      id,
      status: 'ALIVE',
      lastSeen: Date.now(),
      version: 1,
      lastUpdated: Date.now(),
      metadata: { address: '127.0.0.1', port: 7000 },
    } as MembershipEntry);
  }
  return { getMembership: () => membership } as any;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOPIC = 'quorum-lock';
const ACK_TIMEOUT = 100;
const LONG_TTL = 60_000;

async function makeNode(
  nodeId: string,
  pubsubBound: any,
  cluster: any,
  extraConfig?: QuorumDistributedLockConfig,
) {
  const lock = new QuorumDistributedLock(nodeId, pubsubBound, cluster, {
    topic: TOPIC,
    ackTimeoutMs: ACK_TIMEOUT,
    defaultTtlMs: LONG_TTL,
    ...extraConfig,
  });
  await lock.start();
  return lock;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QuorumDistributedLock', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // 1. Single node (majority = 1): tryAcquire succeeds immediately on self-grant.
  it('single node: tryAcquire succeeds immediately on self-grant', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    const cluster = makeCluster(['n1']);
    const lock = await makeNode('n1', shared.bind('n1'), cluster);

    const handle = await lock.tryAcquire('lock-a');
    await flushMicrotasks();

    expect(handle).not.toBeNull();
    expect(handle!.lockId).toBe('lock-a');
    expect(handle!.nodeId).toBe('n1');
    expect(lock.isHeldLocally('lock-a')).toBe(true);

    await lock.stop();
  });

  // 2. Three nodes all alive, one acquires → majority (2) ACKs within timeout → handle returned.
  it('three nodes: acquirer gets majority ACKs and receives handle', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    const cluster = makeCluster(['n1', 'n2', 'n3']);

    const lock1 = await makeNode('n1', shared.bind('n1'), cluster);
    const lock2 = await makeNode('n2', shared.bind('n2'), cluster);
    const lock3 = await makeNode('n3', shared.bind('n3'), cluster);

    const handle = await lock1.tryAcquire('lock-b');
    await flushMicrotasks();

    expect(handle).not.toBeNull();
    expect(handle!.nodeId).toBe('n1');
    expect(lock1.isHeldLocally('lock-b')).toBe(true);

    await Promise.all([lock1.stop(), lock2.stop(), lock3.stop()]);
  });

  // 3. Two nodes racing for same lock with third node arbitrating: exactly one wins.
  it('three nodes: exactly one winner in a two-way race', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    const cluster = makeCluster(['n1', 'n2', 'n3']);

    const lock1 = await makeNode('n1', shared.bind('n1'), cluster);
    const lock2 = await makeNode('n2', shared.bind('n2'), cluster);
    const lock3 = await makeNode('n3', shared.bind('n3'), cluster);

    // Race: n1 and n2 both try to acquire the same lock simultaneously
    // Because pubsub is synchronous, the first publish wins the arbitration
    const p1 = lock1.tryAcquire('lock-race');
    const p2 = lock2.tryAcquire('lock-race');

    const [h1, h2] = await Promise.all([p1, p2]);
    await flushMicrotasks();

    const wins = [h1, h2].filter(Boolean).length;
    expect(wins).toBe(1);

    await Promise.all([lock1.stop(), lock2.stop(), lock3.stop()]);
  });

  // 4. Node A holds lock, Node B tries → B gets majority DENY → tryAcquire returns null.
  it('three nodes: contended lock returns null for the second acquirer', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    const cluster = makeCluster(['n1', 'n2', 'n3']);

    const lock1 = await makeNode('n1', shared.bind('n1'), cluster);
    const lock2 = await makeNode('n2', shared.bind('n2'), cluster);
    const lock3 = await makeNode('n3', shared.bind('n3'), cluster);

    const handle1 = await lock1.tryAcquire('lock-c');
    await flushMicrotasks();
    expect(handle1).not.toBeNull();
    expect(lock1.isHeldLocally('lock-c')).toBe(true);

    // n2 tries after n1 holds — n1 has it in heldLocks, n2 and n3 have it in remoteLocks
    const handle2 = await lock2.tryAcquire('lock-c');
    await flushMicrotasks();

    expect(handle2).toBeNull();
    expect(lock2.isHeldLocally('lock-c')).toBe(false);

    await Promise.all([lock1.stop(), lock2.stop(), lock3.stop()]);
  });

  // 5. Node A holds, releases, B can now acquire.
  it('three nodes: after release, another node can acquire', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    const cluster = makeCluster(['n1', 'n2', 'n3']);

    const lock1 = await makeNode('n1', shared.bind('n1'), cluster);
    const lock2 = await makeNode('n2', shared.bind('n2'), cluster);
    const lock3 = await makeNode('n3', shared.bind('n3'), cluster);

    const handle1 = await lock1.tryAcquire('lock-d');
    await flushMicrotasks();
    expect(handle1).not.toBeNull();

    await lock1.release(handle1!);
    await flushMicrotasks();

    const handle2 = await lock2.tryAcquire('lock-d');
    await flushMicrotasks();

    expect(handle2).not.toBeNull();
    expect(handle2!.nodeId).toBe('n2');

    await Promise.all([lock1.stop(), lock2.stop(), lock3.stop()]);
  });

  // 6. TTL expires → auto-release → subsequent tryAcquire from another node succeeds.
  it('TTL expiry auto-releases; subsequent acquire from another node succeeds', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    const cluster = makeCluster(['n1', 'n2', 'n3']);

    const lock1 = await makeNode('n1', shared.bind('n1'), cluster, { defaultTtlMs: 200 });
    const lock2 = await makeNode('n2', shared.bind('n2'), cluster, { defaultTtlMs: 200 });
    const lock3 = await makeNode('n3', shared.bind('n3'), cluster, { defaultTtlMs: 200 });

    const handle1 = await lock1.tryAcquire('lock-e', { ttlMs: 200 });
    await flushMicrotasks();
    expect(handle1).not.toBeNull();
    expect(lock1.isHeldLocally('lock-e')).toBe(true);

    // Advance past the TTL — the remote TTL timers also need to fire to clear remoteLocks
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(lock1.isHeldLocally('lock-e')).toBe(false);

    const handle2 = await lock2.tryAcquire('lock-e', { ttlMs: 200 });
    await flushMicrotasks();

    expect(handle2).not.toBeNull();
    expect(handle2!.nodeId).toBe('n2');

    await Promise.all([lock1.stop(), lock2.stop(), lock3.stop()]);
  });

  // 7. ackTimeoutMs with no responses → tryAcquire returns null (cluster unresponsive).
  it('ackTimeoutMs with no other peers responding → returns null', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    // Only n1 subscribes; n2 and n3 are in the membership map but have no lock instances.
    const cluster = makeCluster(['n1', 'n2', 'n3']);

    const lock1 = await makeNode('n1', shared.bind('n1'), cluster);

    const p = lock1.tryAcquire('lock-f');

    // Let the ack timeout fire
    await jest.advanceTimersByTimeAsync(ACK_TIMEOUT + 10);

    const handle = await p;
    expect(handle).toBeNull();

    await lock1.stop();
  });

  // 8. release() broadcasts LOCK_RELEASE; other nodes clear their remoteLocks entry.
  it('release broadcasts LOCK_RELEASE; other nodes can then grant to a new requester', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    const cluster = makeCluster(['n1', 'n2', 'n3']);

    const lock1 = await makeNode('n1', shared.bind('n1'), cluster);
    const lock2 = await makeNode('n2', shared.bind('n2'), cluster);
    const lock3 = await makeNode('n3', shared.bind('n3'), cluster);

    const handle1 = await lock1.tryAcquire('lock-g');
    await flushMicrotasks();
    expect(handle1).not.toBeNull();

    // Release n1's lock — should broadcast LOCK_RELEASE, clearing remoteLocks on n2 and n3
    await lock1.release(handle1!);
    await flushMicrotasks();

    expect(lock1.isHeldLocally('lock-g')).toBe(false);

    // n2 should now be able to acquire (remoteLocks cleared on all peers)
    const handle2 = await lock2.tryAcquire('lock-g');
    await flushMicrotasks();

    expect(handle2).not.toBeNull();
    expect(handle2!.nodeId).toBe('n2');

    await Promise.all([lock1.stop(), lock2.stop(), lock3.stop()]);
  });

  // 9. Loop prevention: own LOCK_REQUEST doesn't trigger own LOCK_GRANT handling.
  it('loop prevention: own LOCK_REQUEST is ignored by the publisher', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    const cluster = makeCluster(['n1', 'n2', 'n3']);

    const lock1 = await makeNode('n1', shared.bind('n1'), cluster);
    const lock2 = await makeNode('n2', shared.bind('n2'), cluster);
    const lock3 = await makeNode('n3', shared.bind('n3'), cluster);

    const deniedEvents: string[] = [];
    lock1.on('lock:denied', (lockId: string) => deniedEvents.push(lockId));

    // If n1 processed its own LOCK_REQUEST it would deny itself (since it's mid-acquire),
    // but loop prevention should skip it.
    const handle = await lock1.tryAcquire('lock-h');
    await flushMicrotasks();

    expect(handle).not.toBeNull();
    // n1 must not have denied itself
    expect(deniedEvents).not.toContain('lock-h');

    await Promise.all([lock1.stop(), lock2.stop(), lock3.stop()]);
  });

  // 10. stop() unsubscribes from pubsub.
  it('stop() unsubscribes from pubsub', async () => {
    const shared = makeSharedPubSub();
    const cluster = makeCluster(['n1']);
    const pubsub = shared.bind('n1');

    const lock = new QuorumDistributedLock('n1', pubsub, cluster, {
      topic: TOPIC,
      ackTimeoutMs: ACK_TIMEOUT,
    });
    await lock.start();
    await lock.stop();

    expect(pubsub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  // Bonus: isHeldLocally and getHeldLocks
  it('getHeldLocks returns all locks held by this node', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    const cluster = makeCluster(['n1']);
    const lock = await makeNode('n1', shared.bind('n1'), cluster);

    expect(lock.getHeldLocks()).toHaveLength(0);

    const hA = await lock.tryAcquire('lock-x');
    await flushMicrotasks();
    const hB = await lock.tryAcquire('lock-y');
    await flushMicrotasks();

    expect(hA).not.toBeNull();
    expect(hB).not.toBeNull();
    expect(lock.getHeldLocks()).toHaveLength(2);

    await lock.release(hA!);
    expect(lock.getHeldLocks()).toHaveLength(1);
    expect(lock.getHeldLocks()[0].lockId).toBe('lock-y');

    await lock.release(hB!);
    expect(lock.getHeldLocks()).toHaveLength(0);

    await lock.stop();
  });

  // Bonus: tryAcquire on already-held lock returns existing handle
  it('tryAcquire on already-held lock returns existing handle without re-acquiring', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    const cluster = makeCluster(['n1']);
    const lock = await makeNode('n1', shared.bind('n1'), cluster);

    const h1 = await lock.tryAcquire('lock-z');
    await flushMicrotasks();

    const h2 = await lock.tryAcquire('lock-z');
    await flushMicrotasks();

    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    expect(h1!.acquiredAt).toBe(h2!.acquiredAt);

    await lock.stop();
  });

  // Bonus: events emitted correctly
  it('emits lock:acquired on successful acquire and lock:released on release', async () => {
    jest.useFakeTimers();
    const shared = makeSharedPubSub();
    const cluster = makeCluster(['n1']);
    const lock = await makeNode('n1', shared.bind('n1'), cluster);

    const acquiredHandles: LockHandle[] = [];
    const releasedIds: string[] = [];

    lock.on('lock:acquired', (h: LockHandle) => acquiredHandles.push(h));
    lock.on('lock:released', (id: string) => releasedIds.push(id));

    const handle = await lock.tryAcquire('lock-events');
    await flushMicrotasks();
    expect(acquiredHandles).toHaveLength(1);
    expect(acquiredHandles[0].lockId).toBe('lock-events');

    await lock.release(handle!);
    expect(releasedIds).toHaveLength(1);
    expect(releasedIds[0]).toBe('lock-events');

    await lock.stop();
  });
});
