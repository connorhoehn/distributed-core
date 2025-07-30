import { createTestCluster } from '../harness/create-test-cluster';

describe('Debug Logging Examples', () => {
  it('should run without any logs (clean output)', async () => {
    // Default behavior - completely clean output for fast CI/CD runs
    const cluster = createTestCluster({ size: 2, enableLogging: false });
    
    await cluster.start();
    await cluster.stop();
    
    // No logs captured when enableLogging: false
    const logs = cluster.getLogs();
    expect(logs).toHaveLength(0);
  });

  it('should capture test harness logs but no debug console logs', async () => {
    // Test harness logs only - no console noise
    const cluster = createTestCluster({ size: 2, enableTestHarnessOnly: true });
    
    await cluster.start();
    await cluster.stop();
    
    // Test harness logs are captured, but no console debug noise
    const logs = cluster.getLogs();
    expect(logs.some(log => log.message?.includes('Starting test cluster'))).toBe(true);
    expect(logs.some(log => log.message?.includes('Stopping test cluster'))).toBe(true);
  });

  // This test intentionally shows debug logs for demonstration
  it.skip('should run with full debug logs when explicitly enabled', async () => {
    // Enable all logging (both test harness logs AND debug console logs)
    // Note: This test is skipped by default to avoid console noise
    const cluster = createTestCluster({ 
      size: 2, 
      enableLogging: true  // Single flag controls both test harness AND debug console logs
    });
    
    await cluster.start();
    // You should see FailureDetector console logs in the output when enableLogging: true
    await cluster.stop();
    
    const logs = cluster.getLogs();
    expect(logs.some(log => log.message?.includes('Starting test cluster'))).toBe(true);
  });
});
