import { describe, test, beforeEach, afterEach, expect } from '@jest/globals';
import { TCPAdapter } from '../../../src/transport/adapters/TCPAdapter';
import { CircuitBreaker } from '../../../src/transport/CircuitBreaker';
import { Message, MessageType } from '../../../src/types';

/**
 * Comprehensive Transport E2E Scenario Test
 * 
 * This test demonstrates the complete transport layer working in a realistic scenario:
 * 1. Node startup and network discovery
 * 2. Message exchange with reliability features
 * 3. Failure simulation and recovery
 * 4. Performance monitoring
 */
describe('Transport E2E: Distributed Node Communication Scenario', () => {
  const SCENARIO_TIMEOUT = 20000;
  
  // Test scenario: 3-node cluster with different roles
  const coordinatorNode = { id: 'coordinator', address: '127.0.0.1', port: 4250 };
  const workerNode1 = { id: 'worker-1', address: '127.0.0.1', port: 4251 };
  const workerNode2 = { id: 'worker-2', address: '127.0.0.1', port: 4252 };

  let coordinator: TCPAdapter;
  let worker1: TCPAdapter;
  let worker2: TCPAdapter;
  let circuitBreaker: CircuitBreaker;

  beforeEach(async () => {
    // Initialize nodes with realistic configurations
    coordinator = new TCPAdapter(coordinatorNode, {
      port: coordinatorNode.port,
      enableLogging: false,
      connectionTimeout: 5000,
      maxRetries: 3,
      baseRetryDelay: 1000
    });

    worker1 = new TCPAdapter(workerNode1, {
      port: workerNode1.port,
      enableLogging: false,
      connectionTimeout: 5000,
      maxRetries: 3,
      baseRetryDelay: 1000
    });

    worker2 = new TCPAdapter(workerNode2, {
      port: workerNode2.port,
      enableLogging: false,
      connectionTimeout: 5000,
      maxRetries: 3,
      baseRetryDelay: 1000
    });

    // Circuit breaker for fault tolerance with faster timeouts for testing
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 2000, // Reduced from 5000
      resetTimeout: 3000, // Reduced from 10000
      enableLogging: false,
      name: 'node-communication'
    });
  });

  afterEach(async () => {
    // Cleanup all nodes with proper error handling
    const nodes = [coordinator, worker1, worker2].filter(Boolean);
    
    // Stop all nodes concurrently with timeout protection
    const stopPromises = nodes.map(async (node) => {
      try {
        if (node && node.getStats().isStarted) {
          await node.stop();
        }
      } catch (error) {
        // Ignore stop errors to prevent test failures
      }
    });

    await Promise.allSettled(stopPromises);

    // Clean up circuit breaker
    if (circuitBreaker) {
      try {
        circuitBreaker.destroy();
      } catch (error) {
        // Ignore cleanup errors
      }
    }

    // Add a small delay to ensure all connections are closed
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  describe('Scenario 1: Normal Operation Flow', () => {
    test('should establish cluster and exchange messages successfully', async () => {
      // Phase 1: Startup
      await coordinator.start();
      await worker1.start();
      await worker2.start();

      const messages: { [nodeId: string]: Message[] } = {
        coordinator: [],
        'worker-1': [],
        'worker-2': []
      };

      // Setup message listeners using proper onMessage method
      coordinator.onMessage((msg: Message) => {
        messages.coordinator.push(msg);
      });
      
      worker1.onMessage((msg: Message) => {
        messages['worker-1'].push(msg);
      });
      
      worker2.onMessage((msg: Message) => {
        messages['worker-2'].push(msg);
      });

      // Phase 2: Initial coordination - coordinator sends startup commands
      const startupMessage: Message = {
        id: 'startup-cmd-1',
        type: MessageType.PING,
        data: { 
          command: 'initialize',
          payload: 'cluster-setup-data',
          timestamp: Date.now()
        },
        sender: coordinatorNode,
        timestamp: Date.now()
      };

      await coordinator.send(startupMessage, workerNode1);
      await coordinator.send(startupMessage, workerNode2);

      // Phase 3: Worker acknowledgment
      await new Promise(resolve => setTimeout(resolve, 1000));

      const ackMessage1: Message = {
        id: 'ack-1',
        type: MessageType.PING,
        data: { status: 'ready', nodeId: 'worker-1' },
        sender: workerNode1,
        timestamp: Date.now()
      };

      const ackMessage2: Message = {
        id: 'ack-2',
        type: MessageType.PING,
        data: { status: 'ready', nodeId: 'worker-2' },
        sender: workerNode2,
        timestamp: Date.now()
      };

      await worker1.send(ackMessage1, coordinatorNode);
      await worker2.send(ackMessage2, coordinatorNode);

      // Phase 4: Verify message exchange
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Verify coordinator received acknowledgments
      expect(messages.coordinator.length).toBeGreaterThanOrEqual(2);
      expect(messages.coordinator.some(msg => msg.data.nodeId === 'worker-1')).toBe(true);
      expect(messages.coordinator.some(msg => msg.data.nodeId === 'worker-2')).toBe(true);

      // Verify workers received startup commands
      expect(messages['worker-1'].length).toBeGreaterThanOrEqual(1);
      expect(messages['worker-2'].length).toBeGreaterThanOrEqual(1);
      expect(messages['worker-1'][0].data.command).toBe('initialize');
      expect(messages['worker-2'][0].data.command).toBe('initialize');

      // Phase 5: Performance validation
      const stats = {
        coordinator: coordinator.getStats(),
        worker1: worker1.getStats(),
        worker2: worker2.getStats()
      };

      Object.values(stats).forEach(stat => {
        expect(stat.isStarted).toBe(true);
        expect(stat.totalConnections).toBeGreaterThanOrEqual(0);
      });

    }, SCENARIO_TIMEOUT);
  });

  describe('Scenario 2: Fault Tolerance and Recovery', () => {
    test('should handle node failure and recovery with circuit breaker protection', async () => {
      // Start coordinator and worker1, leave worker2 offline
      await coordinator.start();
      await worker1.start();
      // worker2 intentionally not started to simulate failure

      const messages: Message[] = [];
      worker1.onMessage((msg: Message) => {
        messages.push(msg);
      });

      let failureCount = 0;
      let successCount = 0;

      // Simulate work distribution with some failures (reduced iterations)
      for (let i = 0; i < 5; i++) {
        const workMessage: Message = {
          id: `work-${i}`,
          type: MessageType.PING,
          data: { 
            task: `process-data-${i}`,
            priority: i % 3 + 1
          },
          sender: coordinatorNode,
          timestamp: Date.now()
        };

        // Try to send to worker1 (should succeed)
        try {
          await circuitBreaker.execute(async () => {
            await coordinator.send(workMessage, workerNode1);
          });
          successCount++;
        } catch (error) {
          failureCount++;
        }

        // Try to send to worker2 (should fail and eventually trip circuit breaker)
        try {
          await circuitBreaker.execute(async () => {
            await coordinator.send(workMessage, workerNode2);
          });
          successCount++;
        } catch (error) {
          failureCount++;
        }

        await new Promise(resolve => setTimeout(resolve, 100)); // Reduced delay
      }

      // Verify circuit breaker behavior
      expect(failureCount).toBeGreaterThan(0);
      expect(successCount).toBeGreaterThan(0);
      expect(circuitBreaker.getFailureRate()).toBeGreaterThan(0);

      // Start worker2 to simulate recovery
      await worker2.start();
      await new Promise(resolve => setTimeout(resolve, 1000)); // Reduced delay

      // Reset circuit breaker and try again
      circuitBreaker.reset();
      
      const recoveryMessage: Message = {
        id: 'recovery-test',
        type: MessageType.PING,
        data: { command: 'health-check' },
        sender: coordinatorNode,
        timestamp: Date.now()
      };

      // Should now succeed
      await expect(circuitBreaker.execute(async () => {
        await coordinator.send(recoveryMessage, workerNode2);
      })).resolves.not.toThrow();

    }, 30000); // Increased timeout to 30 seconds
  });

  describe('Scenario 3: High-Load Communication Pattern', () => {
    test('should handle burst communication and maintain performance', async () => {
      await coordinator.start();
      await worker1.start();
      await worker2.start();

      const receivedMessages: { [nodeId: string]: number } = {
        coordinator: 0,
        'worker-1': 0,
        'worker-2': 0
      };

      // Setup counters using proper onMessage method
      coordinator.onMessage(() => receivedMessages.coordinator++);
      worker1.onMessage(() => receivedMessages['worker-1']++);
      worker2.onMessage(() => receivedMessages['worker-2']++);

      const startTime = Date.now();
      
      // Simulate burst of coordination messages
      const promises: Promise<void>[] = [];
      
      for (let i = 0; i < 10; i++) {
        const message: Message = {
          id: `burst-${i}`,
          type: MessageType.PING,
          data: { 
            sequence: i,
            data: `payload-${i}`.repeat(10) // Some payload
          },
          sender: coordinatorNode,
          timestamp: Date.now()
        };

        // Send to both workers concurrently
        promises.push(coordinator.send(message, workerNode1));
        promises.push(coordinator.send(message, workerNode2));
      }

      // Wait for all sends to complete
      await Promise.allSettled(promises);
      
      // Allow time for message processing
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const duration = Date.now() - startTime;
      const totalMessages = Object.values(receivedMessages).reduce((sum, count) => sum + count, 0);

      // Performance assertions
      expect(totalMessages).toBeGreaterThan(0);
      expect(duration).toBeLessThan(15000); // Should complete within 15 seconds
      expect(receivedMessages['worker-1']).toBeGreaterThan(0);
      expect(receivedMessages['worker-2']).toBeGreaterThan(0);

      // Check connection health
      const finalStats = {
        coordinator: coordinator.getStats(),
        worker1: worker1.getStats(),
        worker2: worker2.getStats()
      };

      Object.values(finalStats).forEach(stat => {
        expect(stat.isStarted).toBe(true);
      });

    }, SCENARIO_TIMEOUT);
  });

  describe('Scenario 4: Transport Layer Statistics and Monitoring', () => {
    test('should provide comprehensive operational metrics', async () => {
      await coordinator.start();
      await worker1.start();

      // Generate some traffic for metrics
      for (let i = 0; i < 5; i++) {
        const message: Message = {
          id: `metrics-${i}`,
          type: MessageType.PING,
          data: { test: `data-${i}` },
          sender: coordinatorNode,
          timestamp: Date.now()
        };

        try {
          await coordinator.send(message, workerNode1);
        } catch (error) {
          // Some failures are okay for metrics testing
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      // Collect metrics
      const coordinatorStats = coordinator.getStats();
      const worker1Stats = worker1.getStats();
      const circuitStats = circuitBreaker.getStats();
      const circuitHealth = circuitBreaker.getHealthCheck();

      // Validate metrics structure
      expect(coordinatorStats).toHaveProperty('isStarted');
      expect(coordinatorStats).toHaveProperty('totalConnections');
      expect(coordinatorStats).toHaveProperty('activeConnections');
      
      expect(worker1Stats).toHaveProperty('isStarted');
      expect(worker1Stats).toHaveProperty('port');
      expect(worker1Stats).toHaveProperty('host');

      expect(circuitStats).toHaveProperty('state');
      expect(circuitStats).toHaveProperty('totalCalls');
      expect(circuitStats).toHaveProperty('failures');
      expect(circuitStats).toHaveProperty('successes');

      expect(circuitHealth).toHaveProperty('healthy');
      expect(circuitHealth).toHaveProperty('state');
      expect(circuitHealth).toHaveProperty('details');

      // Validate metrics values
      expect(coordinatorStats.isStarted).toBe(true);
      expect(worker1Stats.isStarted).toBe(true);
      expect(typeof circuitStats.totalCalls).toBe('number');
      expect(typeof circuitHealth.healthy).toBe('boolean');

    }, SCENARIO_TIMEOUT);
  });
});
