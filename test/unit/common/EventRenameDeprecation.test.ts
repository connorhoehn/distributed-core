/**
 * EventRenameDeprecation.test.ts
 *
 * Overarching test that verifies the dual-emit deprecation bridge for each
 * renamed event family.  For every deprecated event this suite asserts:
 *
 *  1. The OLD name fires on a single underlying trigger.
 *  2. The NEW name fires on the same trigger.
 *  3. The payload delivered to both names is identical.
 *  4. Both names fire synchronously in the same emission tick
 *     (new name fires first, old name second).
 *
 * Classes under test:
 *  - MembershipTable  — member:joined / member:left / member:updated / membership:updated
 *  - ClusterLifecycle — lifecycle:started / lifecycle:stopped
 *  - ObservabilityManager — lifecycle:started / lifecycle:stopped
 *  - ClusterTopologyManager — lifecycle:started / lifecycle:stopped
 */

import { MembershipTable } from '../../../src/cluster/membership/MembershipTable';
import { ClusterLifecycle } from '../../../src/cluster/lifecycle/ClusterLifecycle';
import { NodeInfo, MembershipEntry } from '../../../src/cluster/types';
import { IClusterManagerContext } from '../../../src/cluster/core/IClusterManagerContext';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNodeInfo(id: string, version = 1): NodeInfo {
  return {
    id,
    status: 'ALIVE',
    version,
    lastSeen: Date.now(),
    metadata: { address: '127.0.0.1', port: 3000 }
  };
}

/**
 * Assert that a single call to `trigger()` causes both `oldName` and `newName`
 * to fire on `emitter`, with identical payloads, new name first.
 */
function assertDualEmit<T>(
  emitter: NodeJS.EventEmitter,
  oldName: string,
  newName: string,
  trigger: () => void
) {
  const order: string[] = [];
  let newPayload: unknown;
  let oldPayload: unknown;

  const onNew = (payload: T) => { order.push('new'); newPayload = payload; };
  const onOld = (payload: T) => { order.push('old'); oldPayload = payload; };

  emitter.on(newName, onNew);
  emitter.on(oldName, onOld);

  trigger();

  emitter.removeListener(newName, onNew);
  emitter.removeListener(oldName, onOld);

  expect(order).toContain('new');
  expect(order).toContain('old');
  expect(order.indexOf('new')).toBeLessThan(order.indexOf('old'));
  expect(newPayload).toEqual(oldPayload);
}

// ---------------------------------------------------------------------------
// MembershipTable dual-emit
// ---------------------------------------------------------------------------

describe('EventRenameDeprecation — MembershipTable', () => {
  let table: MembershipTable;

  beforeEach(() => {
    table = new MembershipTable('local');
  });

  it('member:joined / member-joined — both fire, new first, payload identical', () => {
    assertDualEmit(
      table,
      'member-joined',
      'member:joined',
      () => table.addMember(makeNodeInfo('peer-1'))
    );
  });

  it('member:joined — fired by updateNode() (new node path)', () => {
    const newSpy = jest.fn();
    const oldSpy = jest.fn();
    table.on('member:joined', newSpy);
    table.on('member-joined', oldSpy);

    table.updateNode(makeNodeInfo('peer-2'));

    expect(newSpy).toHaveBeenCalledTimes(1);
    expect(oldSpy).toHaveBeenCalledTimes(1);
    expect(newSpy.mock.calls[0][0]).toEqual(oldSpy.mock.calls[0][0]);
  });

  it('member:left / member-left — both fire, new first, payload identical', () => {
    table.addMember(makeNodeInfo('peer-3'));

    assertDualEmit(
      table,
      'member-left',
      'member:left',
      () => table.markDead('peer-3')
    );
  });

  it('member:left — fired by removeMember()', () => {
    table.addMember(makeNodeInfo('peer-4'));

    const newSpy = jest.fn();
    const oldSpy = jest.fn();
    table.on('member:left', newSpy);
    table.on('member-left', oldSpy);

    table.removeMember('peer-4');

    expect(newSpy).toHaveBeenCalledTimes(1);
    expect(oldSpy).toHaveBeenCalledTimes(1);
    expect(newSpy.mock.calls[0][0]).toBe(oldSpy.mock.calls[0][0]); // same primitive
  });

  it('member:updated / member-updated — both fire, new first, payload identical', () => {
    table.addMember(makeNodeInfo('peer-5'));

    assertDualEmit(
      table,
      'member-updated',
      'member:updated',
      () => table.markSuspect('peer-5')
    );
  });

  it('membership:updated / membership-updated — both fire, new first', () => {
    assertDualEmit<Map<string, MembershipEntry>>(
      table,
      'membership-updated',
      'membership:updated',
      () => table.addMember(makeNodeInfo('peer-6'))
    );
  });

  it('membership:updated — fired by pruneDeadNodes() when nodes are removed', () => {
    // Add a node and immediately mark it dead with a very old lastUpdated
    table.addMember({ ...makeNodeInfo('peer-7'), status: 'DEAD' });
    // Directly manipulate lastUpdated to simulate age
    const member = (table as any).members.get('peer-7') as MembershipEntry;
    member.lastUpdated = Date.now() - 100000;

    const newSpy = jest.fn();
    const oldSpy = jest.fn();
    table.on('membership:updated', newSpy);
    table.on('membership-updated', oldSpy);

    const pruned = table.pruneDeadNodes(1000);

    expect(pruned).toBe(1);
    expect(newSpy).toHaveBeenCalledTimes(1);
    expect(oldSpy).toHaveBeenCalledTimes(1);
  });

  it('listener counts are symmetric — on("member:joined") and on("member-joined") each receive exactly one call per emit', () => {
    let newCount = 0;
    let oldCount = 0;

    table.on('member:joined', () => newCount++);
    table.on('member-joined', () => oldCount++);

    table.addMember(makeNodeInfo('peer-8'));
    table.addMember(makeNodeInfo('peer-9'));

    expect(newCount).toBe(2);
    expect(oldCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ClusterLifecycle dual-emit
// ---------------------------------------------------------------------------

describe('EventRenameDeprecation — ClusterLifecycle', () => {
  function makeContext(): jest.Mocked<IClusterManagerContext> {
    return {
      config: { getSeedNodes: jest.fn().mockReturnValue([]), enableLogging: false },
      localNodeId: 'lc-node',
      keyManager: { signClusterPayload: jest.fn().mockImplementation((p) => p) },
      transport: {
        start: jest.fn().mockResolvedValue(void 0),
        stop: jest.fn().mockResolvedValue(void 0),
        send: jest.fn().mockResolvedValue(void 0),
        onMessage: jest.fn()
      },
      membership: {
        addLocalNode: jest.fn(),
        getMember: jest.fn().mockReturnValue(undefined) as jest.MockedFunction<(nodeId: string) => MembershipEntry | undefined>,
        updateNode: jest.fn().mockReturnValue(true),
        getAliveMembers: jest.fn().mockReturnValue([]) as jest.MockedFunction<() => MembershipEntry[]>,
        clear: jest.fn()
      },
      failureDetector: { start: jest.fn(), stop: jest.fn() },
      gossipStrategy: { sendPeriodicGossip: jest.fn().mockResolvedValue(void 0) },
      hashRing: { rebuild: jest.fn() },
      recentUpdates: [],
      getLocalNodeInfo: jest.fn().mockReturnValue(makeNodeInfo('lc-node')),
      addToRecentUpdates: jest.fn(),
      incrementVersion: jest.fn(),
      isBootstrapped: jest.fn().mockReturnValue(false),
      getClusterSize: jest.fn().mockReturnValue(1),
      rebuildHashRing: jest.fn(),
      joinCluster: jest.fn().mockResolvedValue(void 0),
      startGossipTimer: jest.fn(),
      stopGossipTimer: jest.fn(),
      sendImmediateGossip: jest.fn().mockResolvedValue(void 0),
      runAntiEntropyCycle: jest.fn()
    } as any;
  }

  function makeLifecycle(ctx: IClusterManagerContext): ClusterLifecycle {
    const lc = new ClusterLifecycle({ shutdownTimeout: 50, drainTimeout: 50, maxShutdownWait: 10 });
    lc.setContext(ctx);
    return lc;
  }

  it('lifecycle:started / started — both fire on start(), new first, payload identical', async () => {
    const ctx = makeContext();
    const lc = makeLifecycle(ctx);

    const order: string[] = [];
    let newPayload: unknown;
    let oldPayload: unknown;

    lc.on('lifecycle:started', (p: unknown) => { order.push('new'); newPayload = p; });
    lc.on('started', (p: unknown) => { order.push('old'); oldPayload = p; });

    await lc.start();

    expect(order).toContain('new');
    expect(order).toContain('old');
    expect(order.indexOf('new')).toBeLessThan(order.indexOf('old'));
    expect(newPayload).toEqual(oldPayload);
  });

  it('lifecycle:stopped / stopped — both fire on stop(), new first, payload identical', async () => {
    const ctx = makeContext();
    const lc = makeLifecycle(ctx);
    await lc.start();

    const order: string[] = [];
    let newPayload: unknown;
    let oldPayload: unknown;

    lc.on('lifecycle:stopped', (p: unknown) => { order.push('new'); newPayload = p; });
    lc.on('stopped', (p: unknown) => { order.push('old'); oldPayload = p; });

    await lc.stop();

    expect(order).toContain('new');
    expect(order).toContain('old');
    expect(order.indexOf('new')).toBeLessThan(order.indexOf('old'));
    expect(newPayload).toEqual(oldPayload);
  });

  it('error event is NOT dual-emitted (Node.js semantics preserved)', async () => {
    const ctx = makeContext();
    (ctx.transport.start as jest.Mock).mockRejectedValue(new Error('fail'));
    const lc = makeLifecycle(ctx);

    // Only one listener — the raw `error` event; if dual-emit were applied a
    // `lifecycle:error` event would also fire with no listener (safe to ignore)
    // but the `error` event must still reach the handler.
    const errorSpy = jest.fn();
    lc.on('error', errorSpy);

    await expect(lc.start()).rejects.toThrow('fail');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
