import { Node } from '../../src/common/Node';

describe('Node Graceful Shutdown Integration', () => {
  let node: Node;

  afterEach(async () => {
    if (node && node.isRunning()) {
      await node.stop();
    }
  });

  it('should gracefully leave cluster during stop', async () => {
    // Configure a test node
    const config = {
      id: 'test-node-graceful',
      clusterId: 'test-cluster',
      service: 'test-service',
      zone: 'test-zone',
      region: 'test-region',
      enableLogging: false,
      enableMetrics: false,
      enableChaos: false
    };

    node = new Node(config);
    await node.start();
    
    // Verify node is started
    expect(node.isRunning()).toBe(true);

    // Mock the cluster leave method to verify it's called
    const leaveSpy = jest.spyOn(node.cluster, 'leave').mockResolvedValue();

    // Stop the node
    await node.stop();

    // Verify graceful leave was attempted
    expect(leaveSpy).toHaveBeenCalledWith(5000);
    expect(node.isRunning()).toBe(false);

    leaveSpy.mockRestore();
  });

  it('should continue shutdown even if graceful leave fails', async () => {
    const config = {
      id: 'test-node-error',
      clusterId: 'test-cluster',
      service: 'test-service',
      zone: 'test-zone',
      region: 'test-region',
      enableLogging: false,
      enableMetrics: false,
      enableChaos: false
    };

    node = new Node(config);
    await node.start();

    // Mock cluster leave to throw an error
    const leaveSpy = jest.spyOn(node.cluster, 'leave').mockRejectedValue(new Error('Leave failed'));

    // Stop should complete successfully despite leave failure
    await expect(node.stop()).resolves.toBeUndefined();
    expect(node.isRunning()).toBe(false);

    leaveSpy.mockRestore();
  });

  it('should handle cluster without leave method gracefully', async () => {
    const config = {
      id: 'test-node-no-leave',
      clusterId: 'test-cluster',
      service: 'test-service',
      zone: 'test-zone',
      region: 'test-region',
      enableLogging: false,
      enableMetrics: false,
      enableChaos: false
    };

    node = new Node(config);
    await node.start();

    // Remove leave method from cluster
    delete (node.cluster as any).leave;

    // Stop should complete successfully
    await expect(node.stop()).resolves.toBeUndefined();
    expect(node.isRunning()).toBe(false);
  });

  it('should not attempt leave when already stopped', async () => {
    const config = {
      id: 'test-node-stopped',
      clusterId: 'test-cluster',
      service: 'test-service',
      zone: 'test-zone',
      region: 'test-region',
      enableLogging: false,
      enableMetrics: false,
      enableChaos: false
    };

    node = new Node(config);
    await node.start();
    await node.stop();
    expect(node.isRunning()).toBe(false);

    // Mock leave to verify it's not called
    const leaveSpy = jest.spyOn(node.cluster, 'leave').mockResolvedValue();

    // Second stop should not call leave
    await node.stop();
    expect(leaveSpy).not.toHaveBeenCalled();

    leaveSpy.mockRestore();
  });
});