import { Node, NodeConfig } from '../src/common/Node';

/**
 * Demonstration of graceful node shutdown with cluster leave functionality.
 * This example shows how a Node now gracefully announces its departure 
 * before shutting down its subsystems.
 */
async function demonstrateGracefulShutdown() {
  console.log('=== Graceful Node Shutdown Demonstration ===\n');

  // Configure a test node
  const config: NodeConfig = {
    id: 'demo-node',
    clusterId: 'demo-cluster',
    service: 'graceful-demo',
    zone: 'demo-zone',
    region: 'demo-region',
    enableLogging: true,
    enableMetrics: false,
    enableChaos: false
  };

  // Create and start the node
  console.log('1. Creating and starting node...');
  const node = new Node(config);
  await node.start();
  console.log(`   ✓ Node ${node.id} started successfully\n`);

  // Simulate some cluster activity time
  console.log('2. Node is running and participating in cluster...');
  await new Promise<void>(resolve => {
    setTimeout(() => {
      console.log('   ✓ Node has been active for 1 second\n');
      resolve();
    }, 1000);
  });

  // Demonstrate graceful shutdown
  console.log('3. Initiating graceful shutdown...');
  console.log('   → This will:');
  console.log('     a) Announce departure to cluster members');
  console.log('     b) Wait for departure acknowledgments (with timeout)');
  console.log('     c) Mark self as dead in membership table');
  console.log('     d) Stop gossip protocol');
  console.log('     e) Shutdown subsystems in reverse order');
  console.log('     f) Close all connections');
  
  await node.stop();
  console.log('   ✓ Node shutdown completed gracefully\n');

  console.log('=== Demonstration Complete ===');
  console.log('The graceful leave functionality ensures that:');
  console.log('- Other cluster members are notified of intentional departure');
  console.log('- This prevents false failure detection');
  console.log('- Improves cluster stability during planned shutdowns');
}

export { demonstrateGracefulShutdown };
