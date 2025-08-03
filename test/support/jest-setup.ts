/**
 * Jest setup file for proper test cleanup and timeout handling
 */

import '@jest/globals';

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
        // Add timeout to cleanup tasks
        await Promise.race([
          result,
          new Promise((resolve) => setTimeout(resolve, 5000)) // 5 second max per cleanup
        ]);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });
  
  // Wait for all cleanup with global timeout
  await Promise.race([
    Promise.allSettled(cleanupPromises),
    new Promise((resolve) => setTimeout(resolve, 10000)) // 10 second max total cleanup
  ]);
  
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
