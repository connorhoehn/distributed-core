import { RetryManager, RetryOptions } from '../../../src/transport/RetryManager';

describe('Retry Manager', () => {
  let retryManager: RetryManager;

  beforeEach(() => {
    retryManager = new RetryManager({
      enableLogging: false // Disable logging for cleaner test output
    });
  });

  afterEach(() => {
    retryManager.destroy();
  });

  describe('Basic Retry Logic', () => {
    test('should succeed on first try', async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        return 'success';
      };

      const result = await retryManager.execute(operation);
      expect(result).toBe('success');
      expect(callCount).toBe(1);
    });

    test('should retry on failure', async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error('temporary failure');
        }
        return 'success';
      };

      const result = await retryManager.execute(operation, undefined, {
        maxRetries: 3,
        baseDelay: 1 // Reduce delay for faster tests
      });
      expect(result).toBe('success');
      expect(callCount).toBe(3);
    });
  });

  describe('Statistics', () => {
    test('should provide stats', async () => {
      const operation = async () => 'success';
      await retryManager.execute(operation);
      
      const stats = retryManager.getStats();
      expect(typeof stats.activeRetries).toBe('number');
      expect(typeof stats.deadLetterCount).toBe('number');
    });
  });
});
