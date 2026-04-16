import { Node } from '../../../src/common/Node';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { ResourceRegistry } from '../../../src/resources/core/ResourceRegistry';
import { ResourceState, ResourceHealth } from '../../../src/resources/types';
import { Session } from '../../../src/connections/Session';

beforeEach(() => {
  InMemoryAdapter.clearRegistry();
});

afterEach(() => {
  InMemoryAdapter.clearRegistry();
});

describe('Example smoke tests', () => {
  /**
   * Basic cluster pattern (basic-cluster example):
   * Create a node, start it, verify it registers itself in membership, then stop.
   * Uses a single node to avoid slow gossip propagation in unit tests.
   */
  it('basic cluster — node starts, joins membership, and stops', async () => {
    const t0 = new InMemoryAdapter({ id: 'n0', address: '127.0.0.1', port: 5000 });
    const node = new Node({
      id: 'n0', transport: t0, seedNodes: [], region: 'us-east', role: 'worker',
      lifecycle: { enableGracefulShutdown: false },
    });

    await node.start();

    expect(node.isRunning()).toBe(true);
    expect(node.getMemberCount()).toBe(1);
    const membership = node.getMembership();
    expect(membership.has('n0')).toBe(true);
    expect(membership.get('n0')?.status).toBe('ALIVE');

    await node.stop();
    expect(node.isRunning()).toBe(false);
  });

  /**
   * Resource pattern (distributed-counter example):
   * Create a ResourceRegistry, register a type, create a resource, verify it exists.
   */
  it('resource registry — register type, create resource, read it back', async () => {
    const registry = new ResourceRegistry({
      nodeId: 'test-node',
      entityRegistryType: 'memory',
    });
    await registry.start();

    registry.registerResourceType({
      name: 'counter',
      typeName: 'counter',
      version: '1.0.0',
      schema: {},
    });

    const created = await registry.createResource({
      id: 'ctr-1',
      resourceId: 'ctr-1',
      type: 'counter',
      resourceType: 'counter',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      nodeId: 'test-node',
      state: ResourceState.ACTIVE,
      health: ResourceHealth.HEALTHY,
    });

    expect(created.resourceId).toBe('ctr-1');

    const fetched = await registry.getResource('ctr-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.resourceType).toBe('counter');

    await registry.stop();
  });

  /**
   * Handler registration pattern (message-passing core):
   * Register a handler on a node, route a message to it, verify it fires.
   */
  it('handler registration — register handler and route a message', async () => {
    const transport = new InMemoryAdapter({ id: 'h0', address: '127.0.0.1', port: 5010 });
    const node = new Node({ id: 'h0', transport, seedNodes: [] });

    const received: unknown[] = [];
    node.registerHandler('test-action', (msg) => {
      received.push(msg);
    });

    const session = new Session('s1', {});
    node.routeMessage({ type: 'test-action', payload: 'hello' }, session);

    expect(received).toHaveLength(1);
    expect((received[0] as any).payload).toBe('hello');
  });
});
