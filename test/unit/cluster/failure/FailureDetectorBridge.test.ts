import { EventEmitter } from 'events';
import { FailureDetectorBridge } from '../../../../src/cluster/failure/FailureDetectorBridge';
import { ResourceRouter } from '../../../../src/routing/ResourceRouter';
import { ConnectionRegistry } from '../../../../src/connections/ConnectionRegistry';
import { EntityRegistryFactory } from '../../../../src/cluster/entity/EntityRegistryFactory';
import { MembershipEntry } from '../../../../src/cluster/types';
import { FailureDetector } from '../../../../src/monitoring/FailureDetector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDetector() {
  const e = new EventEmitter();
  return e as unknown as FailureDetector;
}

function makeCluster(localNodeId: string, peers: string[] = []) {
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

  for (const peerId of peers) {
    membership.set(peerId, {
      id: peerId,
      status: 'ALIVE',
      lastSeen: Date.now(),
      version: 1,
      lastUpdated: Date.now(),
      metadata: { address: '10.0.0.2', port: 7001 },
    } as MembershipEntry);
  }

  return {
    getMembership: () => membership,
    on: (event: string, handler: (...args: any[]) => void) => emitter.on(event, handler),
    off: (event: string, handler: (...args: any[]) => void) => emitter.off(event, handler),
    emit: (event: string, ...args: any[]) => emitter.emit(event, ...args),
  };
}

async function makeRouter(localNodeId: string, peers: string[] = []) {
  const cluster = makeCluster(localNodeId, peers);
  const registry = EntityRegistryFactory.createMemory(localNodeId, { enableTestMode: true });
  const router = new ResourceRouter(localNodeId, registry, cluster as any);
  await router.start();
  return { router, cluster, registry };
}

async function makeConnectionRegistry(localNodeId: string) {
  const entityRegistry = EntityRegistryFactory.createMemory(localNodeId, { enableTestMode: true });
  const connRegistry = new ConnectionRegistry(entityRegistry, localNodeId);
  await connRegistry.start();
  return { connRegistry, entityRegistry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FailureDetectorBridge', () => {
  const routers: ResourceRouter[] = [];
  const connRegistries: ConnectionRegistry[] = [];

  afterEach(async () => {
    for (const r of routers.splice(0)) await r.stop();
    for (const c of connRegistries.splice(0)) await c.stop();
  });

  // -------------------------------------------------------------------------
  // 1. router.handleNodeLeft is called on node-failed
  // -------------------------------------------------------------------------

  it('calls router.handleNodeLeft for the failed node', async () => {
    const detector = makeMockDetector();
    const { router } = await makeRouter('node-1', ['node-2']);
    routers.push(router);

    await (router as any).registry.applyRemoteUpdate({
      entityId: 'r1', ownerNodeId: 'node-2', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });

    const orphaned: string[] = [];
    router.on('resource:orphaned', (h: any) => orphaned.push(h.resourceId));

    const bridge = new FailureDetectorBridge(detector, { router });
    bridge.start();

    (detector as unknown as EventEmitter).emit('node-failed', 'node-2', 'timeout');

    // Give async handleFailure a tick to complete
    await new Promise(r => setImmediate(r));

    expect(orphaned).toContain('r1');

    bridge.stop();
  });

  // -------------------------------------------------------------------------
  // 2. connectionRegistry.handleRemoteNodeFailure is called, removes connections
  // -------------------------------------------------------------------------

  it('removes connections owned by the failed node', async () => {
    const detector = makeMockDetector();
    const { connRegistry } = await makeConnectionRegistry('node-local');
    connRegistries.push(connRegistry);

    // Inject a remote connection owned by 'node-dead'
    await connRegistry.applyRemoteUpdate({
      entityId: 'conn-dead', ownerNodeId: 'node-dead', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });

    expect(connRegistry.getAllConnections().map(c => c.connectionId)).toContain('conn-dead');

    const bridge = new FailureDetectorBridge(detector, { connectionRegistry: connRegistry });
    bridge.start();

    (detector as unknown as EventEmitter).emit('node-failed', 'node-dead', 'ping-timeout');

    await new Promise(r => setImmediate(r));

    expect(connRegistry.getAllConnections().map(c => c.connectionId)).not.toContain('conn-dead');

    bridge.stop();
  });

  // -------------------------------------------------------------------------
  // 3. cleanup:triggered fires with accurate summary counts
  // -------------------------------------------------------------------------

  it('emits cleanup:triggered with correct orphanedResources and expiredConnections', async () => {
    const detector = makeMockDetector();
    const { router } = await makeRouter('node-1', ['node-2']);
    routers.push(router);
    const { connRegistry } = await makeConnectionRegistry('node-1');
    connRegistries.push(connRegistry);

    await (router as any).registry.applyRemoteUpdate({
      entityId: 'r1', ownerNodeId: 'node-2', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });
    await (router as any).registry.applyRemoteUpdate({
      entityId: 'r2', ownerNodeId: 'node-2', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });
    await connRegistry.applyRemoteUpdate({
      entityId: 'c1', ownerNodeId: 'node-2', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });

    const summaries: Array<{ orphanedResources: number; expiredConnections: number }> = [];
    const bridge = new FailureDetectorBridge(detector, { router, connectionRegistry: connRegistry });
    bridge.on('cleanup:triggered', (_nodeId: string, summary: any) => summaries.push(summary));
    bridge.start();

    (detector as unknown as EventEmitter).emit('node-failed', 'node-2', 'timeout');

    await new Promise(r => setImmediate(r));

    expect(summaries).toHaveLength(1);
    expect(summaries[0].orphanedResources).toBe(2);
    expect(summaries[0].expiredConnections).toBe(1);

    bridge.stop();
  });

  // -------------------------------------------------------------------------
  // 4. node-suspected does NOT trigger cleanup when handleSuspected is false
  // -------------------------------------------------------------------------

  it('does not trigger cleanup on node-suspected when handleSuspected is false (default)', async () => {
    const detector = makeMockDetector();
    const { connRegistry } = await makeConnectionRegistry('node-local');
    connRegistries.push(connRegistry);

    await connRegistry.applyRemoteUpdate({
      entityId: 'c-suspect', ownerNodeId: 'node-suspect', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });

    const cleanupSpy = jest.fn();
    const bridge = new FailureDetectorBridge(detector, { connectionRegistry: connRegistry });
    bridge.on('cleanup:triggered', cleanupSpy);
    bridge.start();

    (detector as unknown as EventEmitter).emit('node-suspected', 'node-suspect');

    await new Promise(r => setImmediate(r));

    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(connRegistry.getAllConnections().map(c => c.connectionId)).toContain('c-suspect');

    bridge.stop();
  });

  // -------------------------------------------------------------------------
  // 5. node-suspected DOES trigger cleanup when handleSuspected is true
  // -------------------------------------------------------------------------

  it('triggers cleanup on node-suspected when handleSuspected is true', async () => {
    const detector = makeMockDetector();
    const { connRegistry } = await makeConnectionRegistry('node-local');
    connRegistries.push(connRegistry);

    await connRegistry.applyRemoteUpdate({
      entityId: 'c-suspect2', ownerNodeId: 'node-suspect2', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });

    const cleanupSpy = jest.fn();
    const bridge = new FailureDetectorBridge(
      detector,
      { connectionRegistry: connRegistry },
      { handleSuspected: true },
    );
    bridge.on('cleanup:triggered', cleanupSpy);
    bridge.start();

    (detector as unknown as EventEmitter).emit('node-suspected', 'node-suspect2');

    await new Promise(r => setImmediate(r));

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(connRegistry.getAllConnections().map(c => c.connectionId)).not.toContain('c-suspect2');

    bridge.stop();
  });

  // -------------------------------------------------------------------------
  // 6. stop() removes listeners; subsequent node-failed events are no-ops
  // -------------------------------------------------------------------------

  it('does not trigger cleanup after stop()', async () => {
    const detector = makeMockDetector();
    const { connRegistry } = await makeConnectionRegistry('node-local');
    connRegistries.push(connRegistry);

    await connRegistry.applyRemoteUpdate({
      entityId: 'c-post-stop', ownerNodeId: 'node-gone', version: 1,
      timestamp: Date.now(), operation: 'CREATE', metadata: {},
    });

    const cleanupSpy = jest.fn();
    const bridge = new FailureDetectorBridge(detector, { connectionRegistry: connRegistry });
    bridge.on('cleanup:triggered', cleanupSpy);
    bridge.start();
    bridge.stop();

    (detector as unknown as EventEmitter).emit('node-failed', 'node-gone', 'timeout');

    await new Promise(r => setImmediate(r));

    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(connRegistry.getAllConnections().map(c => c.connectionId)).toContain('c-post-stop');
  });

  // -------------------------------------------------------------------------
  // 7. Handler error → cleanup:error emitted; bridge does not crash
  // -------------------------------------------------------------------------

  it('emits cleanup:error when a target throws, and does not crash', async () => {
    const detector = makeMockDetector();

    const faultyRegistry = {
      getAllConnections: () => { throw new Error('registry exploded'); },
      handleRemoteNodeFailure: () => { throw new Error('registry exploded'); },
    } as any;

    const errors: Array<{ nodeId: string; error: Error }> = [];
    const bridge = new FailureDetectorBridge(detector, { connectionRegistry: faultyRegistry });
    bridge.on('cleanup:error', (nodeId: string, error: Error) => errors.push({ nodeId, error }));
    bridge.start();

    expect(() => {
      (detector as unknown as EventEmitter).emit('node-failed', 'node-bad', 'timeout');
    }).not.toThrow();

    await new Promise(r => setImmediate(r));

    expect(errors).toHaveLength(1);
    expect(errors[0].nodeId).toBe('node-bad');
    expect(errors[0].error.message).toContain('exploded');

    bridge.stop();
  });

  // -------------------------------------------------------------------------
  // 8. Empty targets — bridge is a no-op
  // -------------------------------------------------------------------------

  it('starts and stops cleanly with empty targets, emits nothing', async () => {
    const detector = makeMockDetector();
    const cleanupSpy = jest.fn();
    const errorSpy = jest.fn();

    const bridge = new FailureDetectorBridge(detector, {});
    bridge.on('cleanup:triggered', cleanupSpy);
    bridge.on('cleanup:error', errorSpy);

    expect(() => bridge.start()).not.toThrow();
    expect(bridge.isStarted()).toBe(true);

    (detector as unknown as EventEmitter).emit('node-failed', 'some-node', 'timeout');

    await new Promise(r => setImmediate(r));

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledWith('some-node', { orphanedResources: 0, expiredConnections: 0 });
    expect(errorSpy).not.toHaveBeenCalled();

    expect(() => bridge.stop()).not.toThrow();
    expect(bridge.isStarted()).toBe(false);
  });
});
