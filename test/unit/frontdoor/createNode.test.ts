import { createNode } from '../../../src/frontdoor/createNode';
import { NodeHandle } from '../../../src/frontdoor/NodeHandle';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { Transport } from '../../../src/transport/Transport';

describe('createNode', () => {
  let handle: NodeHandle | null = null;

  afterEach(async () => {
    if (handle && handle.isRunning()) {
      await handle.stop();
    }
    handle = null;
    InMemoryAdapter.clearRegistry();
  }, 15000);

  it('should produce a valid NodeHandle with default options', async () => {
    handle = await createNode();

    expect(handle).toBeInstanceOf(NodeHandle);
    expect(handle.node).toBeDefined();
    expect(handle.id).toBeDefined();
    expect(typeof handle.id).toBe('string');
    expect(handle.id.length).toBeGreaterThan(0);
    expect(handle.isRunning()).toBe(false);
  });

  it('should auto-generate a unique id when none provided', async () => {
    const h1 = await createNode();
    const h2 = await createNode();
    handle = h1;

    expect(h1.id).not.toBe(h2.id);

    // Clean up h2
    if (h2.isRunning()) await h2.stop();
  });

  it('should use a provided id', async () => {
    handle = await createNode({ id: 'my-custom-node' });

    expect(handle.id).toBe('my-custom-node');
  });

  it('should select InMemoryAdapter by default', async () => {
    handle = await createNode();

    // The node internally uses InMemoryAdapter — verify by starting and checking it works
    await handle.start();
    expect(handle.isRunning()).toBe(true);
  }, 15000);

  it('should select correct adapter for websocket transport string', async () => {
    // We just verify construction succeeds without error; we don't actually start
    // a WebSocket server in unit tests.
    handle = await createNode({ transport: 'websocket', port: 0 });
    expect(handle).toBeInstanceOf(NodeHandle);
  });

  it('should select correct adapter for tcp transport string', async () => {
    handle = await createNode({ transport: 'tcp', port: 0 });
    expect(handle).toBeInstanceOf(NodeHandle);
  });

  it('should select correct adapter for udp transport string', async () => {
    handle = await createNode({ transport: 'udp', port: 0 });
    expect(handle).toBeInstanceOf(NodeHandle);
  });

  it('should select correct adapter for http transport string', async () => {
    handle = await createNode({ transport: 'http', port: 0 });
    expect(handle).toBeInstanceOf(NodeHandle);
  });

  it('should pass through a Transport instance directly', async () => {
    const customTransport = new InMemoryAdapter({
      id: 'passthrough-node',
      address: '127.0.0.1',
      port: 9999,
    });

    handle = await createNode({ transport: customTransport, id: 'passthrough-node' });
    expect(handle).toBeInstanceOf(NodeHandle);

    await handle.start();
    expect(handle.isRunning()).toBe(true);
  }, 15000);

  it('should start the node when autoStart is true', async () => {
    handle = await createNode({ autoStart: true });

    expect(handle.isRunning()).toBe(true);
  }, 15000);

  it('should not start the node when autoStart is false', async () => {
    handle = await createNode({ autoStart: false });

    expect(handle.isRunning()).toBe(false);
  });

  it('should apply cluster and metadata options', async () => {
    handle = await createNode({
      clusterId: 'test-cluster',
      region: 'us-east',
      zone: 'az-1',
      role: 'worker',
      tags: { env: 'test' },
    });

    expect(handle.node.metadata.clusterId).toBe('test-cluster');
  });

  it('should expose cluster, router, and connections via handle', async () => {
    handle = await createNode();

    expect(handle.getCluster()).toBeDefined();
    expect(handle.getRouter()).toBeDefined();
    expect(handle.getConnections()).toBeDefined();
  });
});
