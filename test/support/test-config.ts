/**
 * Test configuration with optimized timeouts for faster test execution
 * 
 * Logging Configuration:
 * - enableLogging: false (default) - Completely clean output
 * - enableTestHarnessOnly: true - Test event logs only, no console debug noise  
 * - enableLogging: true - Full logging including debug console output
 * 
 * Examples:
 * const cluster = createTestCluster({ size: 3 }); // Clean output
 * const cluster = createTestCluster({ size: 3, enableTestHarnessOnly: true }); // Test logs only
 * const cluster = createTestCluster({ size: 3, enableLogging: true }); // Full debug output
 */

export const TestConfig = {
  // Fast timeouts for unit tests
  unit: {
    timeouts: { 
      test: 5000,           // 5s max per test
      setup: 1000,          // 1s for setup
      teardown: 1000        // 1s for teardown
    },
    cluster: {
      gossipInterval: 10,       // 10ms gossip (ludicrous speed)
      joinTimeout: 100,         // 100ms join timeout (ludicrous speed)
      failureTimeout: 50,       // 50ms to SUSPECT (ludicrous speed)
      deadTimeout: 100,         // 100ms to DEAD (ludicrous speed)
      heartbeatInterval: 10,    // 10ms heartbeats (ludicrous speed)
      shutdownTimeout: 500,     // 500ms shutdown timeout for tests
      maxShutdownWait: 200      // 200ms max shutdown wait for tests
    },
    logging: {
      enableDebugLogs: false,   // Disable debug logs for clean output
      suppressSkipMessages: true // Suppress test skip console messages for clean output
    }
  },

  // Medium timeouts for integration tests
  integration: {
    timeouts: {
      test: 8000,           // 8s max per test (reduced from 10s)
      setup: 1500,          // 1.5s for setup (reduced from 2s)
      teardown: 1000        // 1s for teardown (reduced from 1.5s)
    },
    cluster: {
      gossipInterval: 50,       // 50ms gossip (reduced from 100ms - more aggressive)
      joinTimeout: 800,         // 800ms join timeout (reduced from 1.5s)
      failureTimeout: 300,      // 300ms to SUSPECT (reduced from 600ms)
      deadTimeout: 600,         // 600ms to DEAD (reduced from 1.2s)
      heartbeatInterval: 50,    // 50ms heartbeats (reduced from 100ms)
      shutdownTimeout: 500,     // 500ms shutdown timeout (reduced from 800ms)
      maxShutdownWait: 200      // 200ms max shutdown wait (reduced from 400ms)
    },
    logging: {
      enableDebugLogs: false,   // Disable debug logs for clean output
      suppressSkipMessages: true  // Suppress skip messages for cleaner test output
    }
  },

  // Longer timeouts for scenario tests
  scenario: {
    timeouts: {
      test: 60000,          // 60s max per test
      setup: 10000,         // 10s for setup
      teardown: 5000        // 5s for teardown
    },
    cluster: {
      gossipInterval: 500,      // 500ms gossip
      joinTimeout: 3000,        // 3s join timeout
      failureTimeout: 2000,     // 2s to SUSPECT
      deadTimeout: 4000,        // 4s to DEAD
      heartbeatInterval: 500,   // 500ms heartbeats
      shutdownTimeout: 3000,    // 3s shutdown timeout for scenarios
      maxShutdownWait: 1000     // 1s max shutdown wait for scenarios
    },
    logging: {
      enableDebugLogs: true,     // Enable debug logs for detailed analysis
      suppressSkipMessages: false // Show skip messages for scenario debugging
    }
  },

  // Production-like timeouts for performance tests
  production: {
    timeouts: {
      test: 120000,         // 2 minutes max
      setup: 30000,         // 30s setup
      teardown: 10000       // 10s teardown
    },
    cluster: {
      gossipInterval: 1000,     // 1s gossip (production)
      joinTimeout: 5000,        // 5s join timeout
      failureTimeout: 3000,     // 3s to SUSPECT
      deadTimeout: 6000,        // 6s to DEAD
      heartbeatInterval: 1000,  // 1s heartbeats
      shutdownTimeout: 10000,   // 10s shutdown timeout for production
      maxShutdownWait: 5000     // 5s max shutdown wait for production
    },
    logging: {
      enableDebugLogs: true,    // Enable debug logs for production testing
      suppressSkipMessages: false // Show skip messages for production debugging
    }
  }
};

/**
 * Get test config based on test type
 */
export function getTestConfig(testType: 'unit' | 'integration' | 'scenario' | 'production' = 'integration') {
  return TestConfig[testType];
}

/**
 * Create a ClusterManager with test-optimized configuration
 */
export function createTestClusterConfig(testType: 'unit' | 'integration' | 'scenario' = 'unit') {
  const config = getTestConfig(testType);
  
  return {
    gossipInterval: config.cluster.gossipInterval,
    joinTimeout: config.cluster.joinTimeout,
    enableLogging: config.logging.enableDebugLogs, // Use centralized logging control
    seedNodes: [],
    
    // Fast KeyManager config for tests (EC keys are 10x faster than RSA)
    keyManager: {
      algorithm: 'ec' as const,
      curve: 'secp256k1',
      enableLogging: config.logging.enableDebugLogs
    },
    
    // Failure detector config
    failureDetector: {
      heartbeatInterval: config.cluster.heartbeatInterval,
      failureTimeout: config.cluster.failureTimeout,
      deadTimeout: config.cluster.deadTimeout,
      enableLogging: config.logging.enableDebugLogs  // Use centralized logging control
    },
    
    // Lifecycle config for fast test shutdown
    lifecycle: {
      shutdownTimeout: config.cluster.shutdownTimeout,
      drainTimeout: config.cluster.shutdownTimeout / 2,  // Half of shutdown timeout
      enableAutoRebalance: false,  // Disabled for tests to avoid complications
      rebalanceThreshold: 0.1,
      enableGracefulShutdown: true,
      maxShutdownWait: config.cluster.maxShutdownWait
    }
  };
}

/**
 * Create test cluster config with debug logging enabled
 */
export function createTestClusterConfigWithDebug(testType: 'unit' | 'integration' | 'scenario' = 'unit') {
  const config = createTestClusterConfig(testType);
  
  return {
    ...config,
    enableLogging: true,
    keyManager: {
      ...config.keyManager,
      enableLogging: true
    },
    failureDetector: {
      ...config.failureDetector,
      enableLogging: true
    }
  };
}
