import { TCPAdapter, WebSocketAdapter } from '../../../src/transport/adapters';

describe('Transport Adapters Working Demo', () => {
  test('should demonstrate all adapters can start and stop', async () => {
    const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };

    // Test TCP Adapter
    const tcpAdapter = new TCPAdapter(nodeA, { 
      port: 9095, 
      enableLogging: false,
      connectionTimeout: 1000,
      maxRetries: 1,
      baseRetryDelay: 100,
      circuitBreakerTimeout: 1000
    });
    await tcpAdapter.start();
    expect(tcpAdapter.getStats().isStarted).toBe(true);
    await tcpAdapter.stop();
    expect(tcpAdapter.getStats().isStarted).toBe(false);

    // Test WebSocket Adapter
    const wsAdapter = new WebSocketAdapter(nodeA, { 
      port: 8085, 
      enableLogging: false 
    });
    await wsAdapter.start();
    expect(wsAdapter.getStats().isStarted).toBe(true);
    await wsAdapter.stop();
    expect(wsAdapter.getStats().isStarted).toBe(false);

    // Removed console.log for cleaner test output
  }, 10000);

  test('should provide consistent adapter interfaces', () => {
    const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };

    const adapters = [
      new TCPAdapter(nodeA, { 
        port: 9096, 
        enableLogging: false,
        connectionTimeout: 1000,
        maxRetries: 1,
        baseRetryDelay: 100,
        circuitBreakerTimeout: 1000
      }),
      new WebSocketAdapter(nodeA, { 
        port: 8086, 
        enableLogging: false 
      })
      // GRPCAdapter removed: not available in this build
    ];

    adapters.forEach(adapter => {
      expect(typeof adapter.start).toBe('function');
      expect(typeof adapter.stop).toBe('function');
      expect(typeof adapter.send).toBe('function');
      expect(typeof adapter.onMessage).toBe('function');
      expect(typeof adapter.getStats).toBe('function');
      expect(typeof adapter.getConnectedNodes).toBe('function');
    });

    // Removed console.log for cleaner test output
  });
});
