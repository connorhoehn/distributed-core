import { TCPAdapter } from '../../../src/transport/adapters/TCPAdapter';

describe('TCPAdapter', () => {
  let adapter: TCPAdapter;
  const nodeA = { id: 'node-a', address: '127.0.0.1', port: 8080 };

  beforeEach(() => {
    adapter = new TCPAdapter(nodeA, { 
      port: 9000, 
      enableLogging: false,
      maxRetries: 1,
      baseRetryDelay: 100
    });
  });

  afterEach(async () => {
    if (adapter.getStats().isStarted) {
      await adapter.stop();
    }
  });

  describe('Basic Operations', () => {
    it('should create adapter instance', () => {
      expect(adapter).toBeDefined();
      expect(typeof adapter.start).toBe('function');
      expect(typeof adapter.stop).toBe('function');
      expect(typeof adapter.send).toBe('function');
    });

    it('should start and stop adapter', async () => {
      await adapter.start();
      expect(adapter.getStats().isStarted).toBe(true);
      
      await adapter.stop();
      expect(adapter.getStats().isStarted).toBe(false);
    }, 10000);
  });
});