import { EntityRegistryBootstrapper } from '../../../../src/cluster/entity/EntityRegistryBootstrapper';
import { EntityRegistryFactory } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { EntityRegistry } from '../../../../src/cluster/entity/types';
import { PubSubMessageMetadata } from '../../../../src/gateway/pubsub/types';
import { NotStartedError } from '../../../../src/common/errors';

// ---------------------------------------------------------------------------
// Shared PubSub mock — N nodes routing to each other via a shared bus
// ---------------------------------------------------------------------------

function makeSharedPubSub() {
  const subs: Array<{ nodeId: string; handler: any; topic: string; subId: string }> = [];
  let subIdCounter = 0;

  return {
    bind(nodeId: string) {
      const unsubscribedIds = new Set<string>();

      return {
        subscribe: (topic: string, h: any): string => {
          const id = `sub-${nodeId}-${++subIdCounter}`;
          subs.push({ nodeId, handler: h, topic, subId: id });
          return id;
        },
        unsubscribe: (subId: string): boolean => {
          unsubscribedIds.add(subId);
          const idx = subs.findIndex((s) => s.subId === subId);
          if (idx !== -1) {
            subs.splice(idx, 1);
            return true;
          }
          return false;
        },
        publish: async (topic: string, payload: unknown): Promise<void> => {
          const meta: PubSubMessageMetadata = {
            publisherNodeId: nodeId,
            messageId: `msg-${nodeId}-${Date.now()}-${Math.random()}`,
            timestamp: Date.now(),
            topic,
          };
          // Snapshot subs in case handlers modify the array
          const current = subs.filter((s) => s.topic === topic);
          for (const s of current) {
            s.handler(topic, payload, meta);
          }
        },
      } as any;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStartedRegistry(nodeId: string): Promise<EntityRegistry> {
  const reg = EntityRegistryFactory.createMemory(nodeId, { enableTestMode: true });
  await reg.start();
  return reg;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EntityRegistryBootstrapper', () => {
  // -------------------------------------------------------------------------
  // 1. Happy-path three-node bootstrap
  // -------------------------------------------------------------------------
  it('node-C receives all entities from node-A and node-B after bootstrap()', async () => {
    const sharedBus = makeSharedPubSub();

    const regA = await makeStartedRegistry('node-a');
    const regB = await makeStartedRegistry('node-b');
    const regC = await makeStartedRegistry('node-c');

    // Pre-populate A and B
    await regA.proposeEntity('room-1');
    await regA.proposeEntity('room-2');
    await regB.proposeEntity('room-3');

    const pubsubA = sharedBus.bind('node-a');
    const pubsubB = sharedBus.bind('node-b');
    const pubsubC = sharedBus.bind('node-c');

    const bsA = new EntityRegistryBootstrapper(regA, pubsubA, 'node-a');
    const bsB = new EntityRegistryBootstrapper(regB, pubsubB, 'node-b');
    const bsC = new EntityRegistryBootstrapper(regC, pubsubC, 'node-c', {
      responseTimeoutMs: 100,
      minResponders: 2,
    });

    await bsA.start();
    await bsB.start();
    await bsC.start();

    const result = await bsC.bootstrap();

    expect(regC.getEntityHost('room-1')).toBe('node-a');
    expect(regC.getEntityHost('room-2')).toBe('node-a');
    expect(regC.getEntityHost('room-3')).toBe('node-b');

    await bsA.stop();
    await bsB.stop();
    await bsC.stop();
    await regA.stop();
    await regB.stop();
    await regC.stop();

    // Counts checked in the next test
    void result;
  });

  // -------------------------------------------------------------------------
  // 2. Returned counts match expectations
  // -------------------------------------------------------------------------
  it('bootstrap() returns respondersCount=2 and entitiesMerged=3', async () => {
    const sharedBus = makeSharedPubSub();

    const regA = await makeStartedRegistry('node-a');
    const regB = await makeStartedRegistry('node-b');
    const regC = await makeStartedRegistry('node-c');

    await regA.proposeEntity('room-1');
    await regA.proposeEntity('room-2');
    await regB.proposeEntity('room-3');

    const bsA = new EntityRegistryBootstrapper(regA, sharedBus.bind('node-a'), 'node-a');
    const bsB = new EntityRegistryBootstrapper(regB, sharedBus.bind('node-b'), 'node-b');
    const bsC = new EntityRegistryBootstrapper(regC, sharedBus.bind('node-c'), 'node-c', {
      responseTimeoutMs: 100,
    });

    await bsA.start();
    await bsB.start();
    await bsC.start();

    const result = await bsC.bootstrap();

    expect(result.respondersCount).toBe(2);
    expect(result.entitiesMerged).toBe(3);

    await bsA.stop();
    await bsB.stop();
    await bsC.stop();
    await regA.stop();
    await regB.stop();
    await regC.stop();
  });

  // -------------------------------------------------------------------------
  // 3. Duplicate entity: highest version wins
  // -------------------------------------------------------------------------
  it('when A and B both have room-1, the one with the higher version is applied', async () => {
    const sharedBus = makeSharedPubSub();

    const regA = await makeStartedRegistry('node-a');
    const regB = await makeStartedRegistry('node-b');
    const regC = await makeStartedRegistry('node-c');

    // Give node-A room-1 v1, then update it twice → v3
    await regA.proposeEntity('room-1');
    await regA.updateEntity('room-1', { rev: 2 });
    await regA.updateEntity('room-1', { rev: 3 });

    // Give node-B a stale copy of room-1 at v1 (simulate diverged gossip)
    await regB.applyRemoteUpdate({
      entityId: 'room-1',
      ownerNodeId: 'node-a',
      version: 1,
      timestamp: Date.now(),
      operation: 'CREATE',
    });

    const bsA = new EntityRegistryBootstrapper(regA, sharedBus.bind('node-a'), 'node-a');
    const bsB = new EntityRegistryBootstrapper(regB, sharedBus.bind('node-b'), 'node-b');
    const bsC = new EntityRegistryBootstrapper(regC, sharedBus.bind('node-c'), 'node-c', {
      responseTimeoutMs: 100,
    });

    await bsA.start();
    await bsB.start();
    await bsC.start();

    await bsC.bootstrap();

    const record = regC.getEntity('room-1');
    expect(record).not.toBeNull();
    expect(record!.version).toBe(3); // highest version from node-A wins

    await bsA.stop();
    await bsB.stop();
    await bsC.stop();
    await regA.stop();
    await regB.stop();
    await regC.stop();
  });

  // -------------------------------------------------------------------------
  // 4. Timeout with no peers → resolves with zero counts (does not throw)
  // -------------------------------------------------------------------------
  it('bootstrap() resolves with respondersCount=0, entitiesMerged=0 when no peers reply', async () => {
    jest.useFakeTimers();

    const regC = await makeStartedRegistry('node-c');
    const sharedBus = makeSharedPubSub();
    const pubsubC = sharedBus.bind('node-c');

    const bsC = new EntityRegistryBootstrapper(regC, pubsubC, 'node-c', {
      responseTimeoutMs: 3000,
    });
    await bsC.start();

    const bootstrapPromise = bsC.bootstrap();

    // Advance past the timeout
    await jest.advanceTimersByTimeAsync(3001);

    const result = await bootstrapPromise;

    expect(result.respondersCount).toBe(0);
    expect(result.entitiesMerged).toBe(0);

    jest.useRealTimers();

    await bsC.stop();
    await regC.stop();
  });

  // -------------------------------------------------------------------------
  // 5. Self-responses are ignored (publisherNodeId === localNodeId)
  // -------------------------------------------------------------------------
  it('a node does not process its own snapshot-request as a response', async () => {
    const sharedBus = makeSharedPubSub();

    const regC = await makeStartedRegistry('node-c');
    const pubsubC = sharedBus.bind('node-c');

    const spy = jest.spyOn(regC, 'applyRemoteUpdate');

    const bsC = new EntityRegistryBootstrapper(regC, pubsubC, 'node-c', {
      responseTimeoutMs: 100,
    });
    await bsC.start();

    const result = await bsC.bootstrap();

    // No peer responded, so applyRemoteUpdate should not have been called from bootstrap
    expect(result.respondersCount).toBe(0);
    // The spy may be called 0 times because no responses arrived
    expect(spy).not.toHaveBeenCalled();

    await bsC.stop();
    await regC.stop();
  });

  // -------------------------------------------------------------------------
  // 6. stop() unsubscribes; bootstrap() on a stopped instance throws NotStartedError
  // -------------------------------------------------------------------------
  it('bootstrap() on a stopped bootstrapper throws NotStartedError', async () => {
    const reg = await makeStartedRegistry('node-c');
    const sharedBus = makeSharedPubSub();
    const bs = new EntityRegistryBootstrapper(reg, sharedBus.bind('node-c'), 'node-c');

    await bs.start();
    await bs.stop();

    await expect(bs.bootstrap()).rejects.toThrow(NotStartedError);

    await reg.stop();
  });

  it('stop() unsubscribes from the pubsub topic', async () => {
    const reg = await makeStartedRegistry('node-c');
    const sharedBus = makeSharedPubSub();
    const pubsubC = sharedBus.bind('node-c');
    const unsubSpy = jest.spyOn(pubsubC, 'unsubscribe');

    const bs = new EntityRegistryBootstrapper(reg, pubsubC, 'node-c');
    await bs.start();
    await bs.stop();

    expect(unsubSpy).toHaveBeenCalledTimes(1);

    await reg.stop();
  });

  // -------------------------------------------------------------------------
  // 7. Idempotent start / stop
  // -------------------------------------------------------------------------
  it('start() is idempotent — calling it twice subscribes only once', async () => {
    const reg = await makeStartedRegistry('node-c');
    const sharedBus = makeSharedPubSub();
    const pubsubC = sharedBus.bind('node-c');
    const subSpy = jest.spyOn(pubsubC, 'subscribe');

    const bs = new EntityRegistryBootstrapper(reg, pubsubC, 'node-c');

    await bs.start();
    await bs.start(); // second call should be a no-op

    expect(subSpy).toHaveBeenCalledTimes(1);
    expect(bs.isStarted()).toBe(true);

    await bs.stop();
    await reg.stop();
  });

  it('stop() is idempotent — calling it twice unsubscribes only once', async () => {
    const reg = await makeStartedRegistry('node-c');
    const sharedBus = makeSharedPubSub();
    const pubsubC = sharedBus.bind('node-c');
    const unsubSpy = jest.spyOn(pubsubC, 'unsubscribe');

    const bs = new EntityRegistryBootstrapper(reg, pubsubC, 'node-c');

    await bs.start();
    await bs.stop();
    await bs.stop(); // second call should be a no-op

    expect(unsubSpy).toHaveBeenCalledTimes(1);
    expect(bs.isStarted()).toBe(false);

    await reg.stop();
  });

  // -------------------------------------------------------------------------
  // 8. minResponders: result reflects actual count; does not block
  // -------------------------------------------------------------------------
  it('minResponders=2 with only 1 responder: resolves with metMinResponders=false', async () => {
    const sharedBus = makeSharedPubSub();

    const regA = await makeStartedRegistry('node-a');
    const regC = await makeStartedRegistry('node-c');

    await regA.proposeEntity('room-1');

    const bsA = new EntityRegistryBootstrapper(regA, sharedBus.bind('node-a'), 'node-a');
    const bsC = new EntityRegistryBootstrapper(regC, sharedBus.bind('node-c'), 'node-c', {
      responseTimeoutMs: 100,
      minResponders: 2,
    });

    await bsA.start();
    await bsC.start();

    const result = await bsC.bootstrap();

    // Only 1 peer responded
    expect(result.respondersCount).toBe(1);
    expect(result.entitiesMerged).toBe(1);
    expect(result.metMinResponders).toBe(false);

    await bsA.stop();
    await bsC.stop();
    await regA.stop();
    await regC.stop();
  });

  it('minResponders=1 with 1 responder: metMinResponders=true', async () => {
    const sharedBus = makeSharedPubSub();

    const regA = await makeStartedRegistry('node-a');
    const regC = await makeStartedRegistry('node-c');

    await regA.proposeEntity('room-1');

    const bsA = new EntityRegistryBootstrapper(regA, sharedBus.bind('node-a'), 'node-a');
    const bsC = new EntityRegistryBootstrapper(regC, sharedBus.bind('node-c'), 'node-c', {
      responseTimeoutMs: 100,
      minResponders: 1,
    });

    await bsA.start();
    await bsC.start();

    const result = await bsC.bootstrap();

    expect(result.respondersCount).toBe(1);
    expect(result.metMinResponders).toBe(true);

    await bsA.stop();
    await bsC.stop();
    await regA.stop();
    await regC.stop();
  });
});
