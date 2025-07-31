import { Node } from '../../src/common/Node';

describe('Node Graceful Shutdown Integration', () => {
  let node: Node;

  // Fast test lifecycle configuration to prevent timeouts
  const testLifecycleConfig = {
    shutdownTimeout: 1000,     // 1s shutdown timeout
    drainTimeout: 500,         // 500ms drain timeout
    enableAutoRebalance: false,
    rebalanceThreshold: 0.1,
    enableGracefulShutdown: true,
    maxShutdownWait: 500       // 500ms max shutdown wait
  };

  afterEach(async () => {
    if (node && node.isRunning()) {
      try {
        await node.stop();
      } catch (error) {
        // Force cleanup if normal stop fails
        console.warn('Forced cleanup due to stop failure:', error);
      }
    }
    node = null as any;
  }, 3000); // Increased to 3s but should be much faster now

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
      enableChaos: false,
      lifecycle: testLifecycleConfig
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
      enableChaos: false,
      lifecycle: testLifecycleConfig
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
      enableChaos: false,
      lifecycle: testLifecycleConfig
    };

    node = new Node(config);
    await node.start();

    // Mock leave method to throw error (simulating missing method)
    const leaveSpy = jest.spyOn(node.cluster, 'leave').mockRejectedValue(new Error('Method not available'));

    // Stop should complete successfully despite leave failure
    await expect(node.stop()).resolves.toBeUndefined();
    expect(node.isRunning()).toBe(false);

    leaveSpy.mockRestore();
  }, 3000);

  it('should not attempt leave when already stopped', async () => {
    const config = {
      id: 'test-node-stopped',
      clusterId: 'test-cluster',
      service: 'test-service',
      zone: 'test-zone',
      region: 'test-region',
      enableLogging: false,
      enableMetrics: false,
      enableChaos: false,
      lifecycle: testLifecycleConfig
    };

    node = new Node(config);
    await node.start();
    await node.stop();
    expect(node.isRunning()).toBe(false);

    // Mock leave to ensure it's not called
    const leaveSpy = jest.spyOn(node.cluster, 'leave').mockResolvedValue();

    // Stop again should not call leave
    await node.stop();
    expect(leaveSpy).not.toHaveBeenCalled();

    leaveSpy.mockRestore();
  }, 3000);
});