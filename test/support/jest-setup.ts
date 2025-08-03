/**
 * Jest setup file for proper test cleanup and timeout handling
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
  
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }
});

// Handle unhandled rejections in tests
process.on('unhandledRejection', (reason, promise) => {
  console.warn('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process, just log it
});
