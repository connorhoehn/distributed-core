import { CircuitBreaker, CircuitState } from '../../../src/transport/CircuitBreaker';

describe('Circuit Breaker', () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 1000,
      resetTimeout: 2000,
      halfOpenMaxCalls: 2,
      enableLogging: false
    });
  });

  afterEach(() => {
    circuitBreaker.destroy();
  });

  describe('Basic Circuit Breaker Functionality', () => {
    test('should start in CLOSED state', () => {
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
      expect(circuitBreaker.isCallAllowed()).toBe(true);
    });

    test('should execute successful functions', async () => {
      const successFn = jest.fn().mockResolvedValue('success');
      
      const result = await circuitBreaker.execute(successFn);
      
      expect(result).toBe('success');
      expect(successFn).toHaveBeenCalledTimes(1);
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    test('should handle function failures', async () => {
      const failureFn = jest.fn().mockRejectedValue(new Error('test error'));
      
      await expect(circuitBreaker.execute(failureFn)).rejects.toThrow('test error');
      expect(failureFn).toHaveBeenCalledTimes(1);
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('State Transitions', () => {
    test('should transition to OPEN after threshold failures', async () => {
      const failureFn = jest.fn().mockRejectedValue(new Error('failure'));
      
      // Trigger enough failures to open circuit
      for (let i = 0; i < 3; i++) {
        await expect(circuitBreaker.execute(failureFn)).rejects.toThrow();
      }
      
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
      expect(circuitBreaker.isCallAllowed()).toBe(false);
    });

    test('should reject calls when OPEN', async () => {
      // Force circuit to OPEN state
      circuitBreaker.forceOpen();
      
      const fn = jest.fn();
      await expect(circuitBreaker.execute(fn)).rejects.toThrow(/circuit breaker.*is OPEN/i);
      expect(fn).not.toHaveBeenCalled();
    });

    test('should reset to CLOSED state manually', async () => {
      circuitBreaker.forceOpen();
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
      
      circuitBreaker.reset();
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
      expect(circuitBreaker.isCallAllowed()).toBe(true);
    });
  });

  describe('Statistics', () => {
    test('should track call statistics', async () => {
      const successFn = jest.fn().mockResolvedValue('success');
      const failureFn = jest.fn().mockRejectedValue(new Error('failure'));
      
      await circuitBreaker.execute(successFn);
      await expect(circuitBreaker.execute(failureFn)).rejects.toThrow();
      
      const stats = circuitBreaker.getStats();
      expect(stats.totalCalls).toBe(2);
      expect(stats.successes).toBe(1);
      expect(stats.failures).toBe(1);
    });

    test('should calculate failure rate', async () => {
      const failureFn = jest.fn().mockRejectedValue(new Error('failure'));
      
      await expect(circuitBreaker.execute(failureFn)).rejects.toThrow();
      
      expect(circuitBreaker.getFailureRate()).toBe(1.0);
      expect(circuitBreaker.getSuccessRate()).toBe(0.0);
    });
  });

  describe('Health Check', () => {
    test('should provide health status', () => {
      const health = circuitBreaker.getHealthCheck();
      
      expect(health).toHaveProperty('healthy');
      expect(health).toHaveProperty('state');
      expect(health).toHaveProperty('details');
      expect(health.healthy).toBe(true);
      expect(health.state).toBe(CircuitState.CLOSED);
    });

    test('should report unhealthy when OPEN', () => {
      circuitBreaker.forceOpen();
      
      const health = circuitBreaker.getHealthCheck();
      expect(health.healthy).toBe(false);
      expect(health.state).toBe(CircuitState.OPEN);
    });
  });

  describe('Event Handling', () => {
    test('should emit state change events', (done) => {
      circuitBreaker.on('state-change', (event) => {
        expect(event.previousState).toBe(CircuitState.CLOSED);
        expect(event.newState).toBe(CircuitState.OPEN);
        done();
      });
      
      circuitBreaker.forceOpen();
    });

    test('should emit call success events', (done) => {
      circuitBreaker.on('call-success', (event) => {
        expect(event.result).toBe('success');
        expect(event.duration).toBeGreaterThan(0);
        done();
      });
      
      const successFn = jest.fn().mockResolvedValue('success');
      circuitBreaker.execute(successFn);
    });
  });
});
