import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';

describe('WebSocket Adapter Basic', () => {
  test('should create adapter instance', () => {
    const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };
    const adapter = new WebSocketAdapter(nodeA, { port: 8081, enableLogging: false });
    
    expect(adapter).toBeDefined();
    expect(typeof adapter.start).toBe('function');
    expect(typeof adapter.stop).toBe('function');
  });

  test('should start and stop adapter', async () => {
    const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };
    const adapter = new WebSocketAdapter(nodeA, { port: 8083, enableLogging: false });
    
    await adapter.start();
    expect(adapter.getStats().isStarted).toBe(true);
    
    await adapter.stop();
    expect(adapter.getStats().isStarted).toBe(false);
  }, 10000);
});
