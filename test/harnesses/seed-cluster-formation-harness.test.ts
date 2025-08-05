import { SeedClusterFormationHarness } from './seed-cluster-formation-harness';

/**
 * Example test demonstrating the Seed Cluster Formation Harness
 */
describe('Seed Cluster Formation Harness Examples', () => {
  let harness: SeedClusterFormationHarness;

  afterEach(async () => {
    if (harness) {
      await harness.shutdown();
    }
  });

  it('should demonstrate basic seed-based cluster formation', async () => {
    harness = new SeedClusterFormationHarness({
      seedNodes: 2,
      coordinatorNodes: 1,
      workerNodes: 2,
      enableLogging: true,
      useYamlConfig: true,
      joinTimeout: 3000,
      gossipInterval: 500
    });

    await harness.demonstrateClusterFormation();
    
    const healthSummary = harness.getClusterHealthSummary();
    console.log('Cluster Health Summary:', healthSummary);
    
    expect(healthSummary.totalNodes).toBe(5);
    expect(healthSummary.seedRegistries).toBeGreaterThan(0);
    expect(healthSummary.averageHealthRatio).toBeGreaterThan(0.5);
  }, 30000);

  it('should demonstrate large cluster formation', async () => {
    harness = new SeedClusterFormationHarness({
      seedNodes: 3,
      coordinatorNodes: 3,
      workerNodes: 6,
      enableLogging: false, // Reduce noise for large cluster
      useYamlConfig: true,
      joinTimeout: 5000,
      gossipInterval: 1000
    });

    await harness.demonstrateClusterFormation();
    
    const healthSummary = harness.getClusterHealthSummary();
    const formationLogs = harness.getFormationLogs();
    
    console.log('Large Cluster Health Summary:', healthSummary);
    console.log('Formation Events:', formationLogs.length);
    
    expect(healthSummary.totalNodes).toBe(12);
    expect(formationLogs.length).toBeGreaterThan(20); // Should have many events
  }, 60000);

  it('should demonstrate minimal cluster formation without YAML', async () => {
    harness = new SeedClusterFormationHarness({
      seedNodes: 1,
      coordinatorNodes: 1,
      workerNodes: 1,
      enableLogging: true,
      useYamlConfig: false, // No YAML configuration
      joinTimeout: 2000,
      gossipInterval: 300
    });

    await harness.demonstrateClusterFormation();
    
    const healthSummary = harness.getClusterHealthSummary();
    
    expect(healthSummary.totalNodes).toBe(3);
    expect(healthSummary.activeNodes).toBeGreaterThan(0);
  }, 20000);
});

/**
 * Standalone demonstration function for manual testing
 */
export async function runSeedClusterDemo() {
  console.log('🚀 Starting Seed Cluster Formation Demonstration...\n');
  
  const harness = new SeedClusterFormationHarness({
    seedNodes: 2,
    coordinatorNodes: 2,
    workerNodes: 3,
    enableLogging: true,
    useYamlConfig: true,
    basePort: 19100,
    healthCheckInterval: 5000,
    joinTimeout: 4000,
    gossipInterval: 800
  });

  try {
    await harness.demonstrateClusterFormation();
    
    console.log('\n📊 Final Statistics:');
    const healthSummary = harness.getClusterHealthSummary();
    console.log(JSON.stringify(healthSummary, null, 2));
    
    console.log('\n📋 Formation Log Summary:');
    const logs = harness.getFormationLogs();
    const eventTypes = logs.reduce((acc: Record<string, number>, log) => {
      acc[log.event] = (acc[log.event] || 0) + 1;
      return acc;
    }, {});
    console.log(JSON.stringify(eventTypes, null, 2));
    
  } catch (error) {
    console.error('❌ Demonstration failed:', error);
  } finally {
    await harness.shutdown();
    console.log('✅ Demonstration completed and cleaned up.');
  }
}

// Uncomment to run standalone demo
// runSeedClusterDemo().catch(console.error);
