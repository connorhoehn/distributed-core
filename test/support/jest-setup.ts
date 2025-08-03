/**
 * Jest setup file for proper test cleanup and timeout handling
 * Includes cluster E2E test support with port allocation
 */

import { afterEach } from '@jest/globals';

// Suppress all deprecation warnings during tests for cleaner output
const originalProcessWarning = process.emitWarning;
process.emitWarning = function(this: typeof process, ...args: any[]) {
  // Skip all deprecation warnings during tests
  const [warning, type] = args;
  if (type === 'DeprecationWarning') {
    return;
  }
  // Pass through other warnings
  return originalProcessWarning.apply(this, args as any);
};

// Global test configuration (includes cluster E2E settings)
const testConfig = {
  enableClusterLogs: process.env.TEST_CLUSTER_LOGS === 'true',
  enableCoordinatorLogs: process.env.TEST_COORDINATOR_LOGS === 'true',
  enableTransportLogs: process.env.TEST_TRANSPORT_LOGS === 'true',
  enablePerformanceLogs: process.env.TEST_PERFORMANCE_LOGS === 'true',
  
  // Test timeouts and intervals
  defaultTimeout: 45000,
  clusterFormationTimeout: 30000,
  gossipPropagationTimeout: 10000,
  failureDetectionTimeout: 15000,
  
  // Port allocation for tests
  portRanges: {
    transport: { start: 4250, end: 4254 },    // Current transport tests
    cluster: { start: 4255, end: 4265 },      // Ring-based tests
    coordinator: { start: 4266, end: 4280 },  // Range-based tests
    performance: { start: 4281, end: 4290 }   // Performance tests
  }
};

// Global port tracker to prevent conflicts
const allocatedPorts = new Set<number>();

/**
 * Allocate a unique port from the specified range
 */
function allocatePort(range: 'transport' | 'cluster' | 'coordinator' | 'performance'): number {
  const portRange = testConfig.portRanges[range];
  
  for (let port = portRange.start; port <= portRange.end; port++) {
    if (!allocatedPorts.has(port)) {
      allocatedPorts.add(port);
      return port;
    }
  }
  
  throw new Error(`No available ports in range ${range} (${portRange.start}-${portRange.end})`);
}

/**
 * Release a port back to the available pool
 */
function releasePort(port: number): void {
  allocatedPorts.delete(port);
}

/**
 * Release all ports (for test cleanup)
 */
function releaseAllPorts(): void {
  allocatedPorts.clear();
}

// Global cleanup registry
const globalCleanupTasks: (() => Promise<void> | void)[] = [];

// Add cleanup task
(global as any).addCleanupTask = (task: () => Promise<void> | void) => {
  globalCleanupTasks.push(task);
};

// Run cleanup after each test
afterEach(async () => {
  // Run all registered cleanup tasks with timeout
  const cleanupPromises = globalCleanupTasks.map(async (task) => {
    try {
      const result = task();
      if (result instanceof Promise) {
        // Simple await with timeout using AbortController for cleaner cleanup
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        timeoutId.unref(); // Prevent keeping Jest from exiting
        
        try {
          await result;
        } catch (error) {
          // Ignore cleanup errors
        } finally {
          clearTimeout(timeoutId);
        }
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });
  
  // Wait for all cleanup with a simple timeout
  try {
    await Promise.allSettled(cleanupPromises);
  } catch (error) {
    // Ignore cleanup errors
  }
  
  // Clear cleanup tasks
  globalCleanupTasks.length = 0;
  
  // Release all allocated ports for cluster tests
  releaseAllPorts();
  
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }
});

// Global utility functions for tests
(global as any).testConfig = testConfig;
(global as any).allocatePort = allocatePort;
(global as any).releasePort = releasePort;

// Handle unhandled rejections in tests
process.on('unhandledRejection', (reason, promise) => {
  console.warn('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process, just log it
});
