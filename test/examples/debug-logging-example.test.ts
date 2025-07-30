import { createTestCluster } from '../harness/create-test-cluster';

describe('Debug Logging Examples', () => {
  it('should run without debug logs (clean output)', async () => {
    // Default behavior - clean output for fast CI/CD runs
    const cluster = createTestCluster({ size: 2, enableLogging: true });
    
    await cluster.start();
    await cluster.stop();
    
    // Test harness logs are captured, but no console debug noise
    const logs = cluster.getLogs();
    expect(logs.some(log => log.message?.includes('Starting test cluster'))).toBe(true);
  });

  // This test intentionally shows debug logs for demonstration
  it.skip('should run with debug logs when explicitly enabled', async () => {
    // Enable debug logs for detailed troubleshooting
    // Note: This test is skipped by default to avoid console noise
    const cluster = createTestCluster({ 
      size: 2, 
      enableLogging: true,        // Test harness logging
      enableDebugLogs: true       // System debug console logs
    });
    
    await cluster.start();
    // You should see FailureDetector console logs in the output when enableDebugLogs: true
    await cluster.stop();
    
    const logs = cluster.getLogs();
    expect(logs.some(log => log.message?.includes('Starting test cluster'))).toBe(true);
  });

  // This test intentionally shows debug logs for demonstration
  it.skip('should use scenario config for debug logs by default', async () => {
    // Scenario tests have debug logs enabled by default
    // Note: This test is skipped by default to avoid console noise
    const cluster = createTestCluster({ 
      size: 2, 
      enableLogging: true,
      testType: 'scenario'  // This test type has enableDebugLogs: true by default
    });
    
    await cluster.start();
    // You should see FailureDetector console logs in the output
    await cluster.stop();
  });
});
