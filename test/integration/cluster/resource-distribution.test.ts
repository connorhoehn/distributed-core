import { ResourceDistributionEngine } from '../../../src/cluster/resources/ResourceDistributionEngine';
import { ResourceRegistry } from '../../../src/cluster/resources/ResourceRegistry';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';
import { ResourceMetadata, ResourceState, ResourceHealth } from '../../../src/cluster/resources/types';

/**
 * Integration test demonstrating resource distribution across cluster nodes
 * 
 * This test shows how ResourceDistributionEngine connects ResourceRegistry
 * to your existing cluster infrastructure for cluster-wide resource sharing.
 */
describe('ResourceDistributionEngine Integration', () => {
  const setupClusterNode = async (nodeId: string, seedNodes: string[] = []) => {
    // Create transport layer
    const transport = new InMemoryAdapter({ id: nodeId } as any);
    
    // Create bootstrap config
    const bootstrapConfig = BootstrapConfig.create({
      seedNodes,
      gossipInterval: 100,
      enableLogging: false,
      joinTimeout: 5000
    });

    // Create cluster manager
    const clusterManager = new ClusterManager(
      nodeId,
      transport,
      bootstrapConfig,
      100,
      { role: 'test-node' }
    );

    // Create resource registry using the correct constructor
    const resourceRegistry = new ResourceRegistry({
      nodeId,
      entityRegistryType: 'memory',
      entityRegistryConfig: { enableTestMode: true }
    });

    // Create resource distribution engine
    const distributionEngine = new ResourceDistributionEngine(
      resourceRegistry,
      clusterManager
    );

    return {
      nodeId,
      transport,
      clusterManager,
      resourceRegistry,
      distributionEngine
    };
  };

  const createTestResource = (nodeId: string, resourceType: string, suffix: string): ResourceMetadata => ({
    resourceId: `test-${resourceType}-${suffix}`,
    resourceType,
    nodeId,
    timestamp: Date.now(),
    capacity: {
      current: 10,
      maximum: 100,
      unit: 'connections'
    },
    performance: {
      latency: 50,
      throughput: 1000,
      errorRate: 0.1
    },
    distribution: {
      shardCount: 1,
      replicationFactor: 3
    },
    applicationData: {
      testData: `created-on-${nodeId}`,
      suffix
    },
    state: ResourceState.ACTIVE,
    health: ResourceHealth.HEALTHY
  });

  test('distributes resources across cluster nodes', async () => {
    // Setup 3-node cluster
    const node1 = await setupClusterNode('node-1');
    const node2 = await setupClusterNode('node-2', ['node-1']);
    const node3 = await setupClusterNode('node-3', ['node-1']);

    const nodes = [node1, node2, node3];

    try {
      // Start all nodes
      for (const node of nodes) {
        await node.clusterManager.start();
        await node.resourceRegistry.start();
        await node.distributionEngine.start();
      }

      // Register resource types on all nodes
      for (const node of nodes) {
        node.resourceRegistry.registerResourceType({
          typeName: 'TestResource',
          description: 'Test resource for distribution testing',
          requiredCapacityFields: ['connections'],
          onResourceCreated: async (resource) => {
            console.log(`✅ ${node.nodeId}: Resource created callback for ${resource.resourceId}`);
          }
        });
      }

      // Wait for cluster formation
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Track resource events
      const resourceEvents: Array<{ nodeId: string, event: string, resource: ResourceMetadata }> = [];
      
      nodes.forEach(node => {
        node.distributionEngine.on('resource:distributed', (resource, targetNodes) => {
          resourceEvents.push({
            nodeId: node.nodeId,
            event: 'distributed',
            resource
          });
        });

        node.distributionEngine.on('resource:received', (resource, sourceNodeId) => {
          resourceEvents.push({
            nodeId: node.nodeId,
            event: 'received',
            resource
          });
        });
      });

      // Create a resource on node1
      console.log('\\n🎯 Creating test resource on node1...');
      const testResource1 = createTestResource('node-1', 'TestResource', '1');
      await node1.resourceRegistry.createResource(testResource1);

      // Wait for distribution
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify resource was distributed
      console.log('\\n📊 Checking resource distribution...');
      
      // All nodes should have the resource
      nodes.forEach(node => {
        const resources = node.distributionEngine.getAllResources();
        expect(resources).toHaveLength(1);
        expect(resources[0].resourceType).toBe('TestResource');
        expect(resources[0].applicationData.testData).toBe('created-on-node-1');
        console.log(`✅ ${node.nodeId}: Found resource ${resources[0].resourceId}`);
      });

      // Register another resource type
      for (const node of nodes) {
        await node.resourceRegistry.registerResourceType('AnotherResource', {
          description: 'Another test resource type'
        });
      }

      // Create another resource on node2
      console.log('\\n🎯 Creating second resource on node2...');
      const testResource2 = createTestResource('node-2', 'AnotherResource', '2');
      await node2.resourceRegistry.createResource(testResource2);

      // Wait for distribution
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify both resources are on all nodes
      console.log('\\n📊 Checking final resource state...');
      
      nodes.forEach(node => {
        const allResources = node.distributionEngine.getAllResources();
        const testResources = node.distributionEngine.getResourcesByType('TestResource');
        const anotherResources = node.distributionEngine.getResourcesByType('AnotherResource');
        
        expect(allResources).toHaveLength(2);
        expect(testResources).toHaveLength(1);
        expect(anotherResources).toHaveLength(1);
        
        console.log(`✅ ${node.nodeId}: Has ${allResources.length} total resources`);
        console.log(`   - TestResource: ${testResources.length}`);
        console.log(`   - AnotherResource: ${anotherResources.length}`);
      });

      // Print events for verification
      console.log('\\n📋 Resource Distribution Events:');
      resourceEvents.forEach(event => {
        console.log(`   ${event.nodeId}: ${event.event} ${event.resource.resourceType}/${event.resource.resourceId}`);
      });

      // Should have distribution and reception events
      expect(resourceEvents.filter(e => e.event === 'distributed')).toHaveLength(2);
      expect(resourceEvents.filter(e => e.event === 'received').length).toBeGreaterThan(0);

    } finally {
      // Cleanup
      for (const node of nodes) {
        await node.distributionEngine.stop();
        await node.resourceRegistry.stop();
        await node.clusterManager.stop();
      }
    }
  });

  test('syncs resources with newly joined nodes', async () => {
    // Start with 2 nodes
    const node1 = await setupClusterNode('node-1');
    const node2 = await setupClusterNode('node-2', ['node-1']);

    try {
      // Start initial nodes
      await node1.clusterManager.start();
      await node1.resourceRegistry.start();
      await node1.distributionEngine.start();
      await node2.clusterManager.start();
      await node2.resourceRegistry.start();
      await node2.distributionEngine.start();

      // Register resource type on initial nodes
      for (const node of [node1, node2]) {
        await node.resourceRegistry.registerResourceType('PreExisting', {
          description: 'Pre-existing resource type'
        });
      }

      // Wait for initial cluster formation
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Create resources on existing nodes
      const resource1 = createTestResource('node-1', 'PreExisting', 'from-node1');
      const resource2 = createTestResource('node-2', 'PreExisting', 'from-node2');
      
      await node1.resourceRegistry.createResource(resource1);
      await node2.resourceRegistry.createResource(resource2);

      // Wait for distribution
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify initial state
      expect(node1.distributionEngine.getAllResources()).toHaveLength(2);
      expect(node2.distributionEngine.getAllResources()).toHaveLength(2);

      // Now add a third node
      console.log('\\n🔄 Adding new node3 to existing cluster...');
      const node3 = await setupClusterNode('node-3', ['node-1']);
      
      await node3.clusterManager.start();
      await node3.resourceRegistry.start();
      
      // Register resource type on new node
      await node3.resourceRegistry.registerResourceType('PreExisting', {
        description: 'Pre-existing resource type'
      });
      
      await node3.distributionEngine.start();

      // Wait for sync
      await new Promise(resolve => setTimeout(resolve, 1500));

      // New node should have all existing resources
      const node3Resources = node3.distributionEngine.getAllResources();
      console.log(`✅ node3 received ${node3Resources.length} resources after joining`);
      
      expect(node3Resources).toHaveLength(2);
      expect(node3Resources.map(r => r.applicationData.suffix)).toEqual(
        expect.arrayContaining(['from-node1', 'from-node2'])
      );

    } finally {
      // Cleanup
      await node1.distributionEngine.stop();
      await node1.resourceRegistry.stop();
      await node1.clusterManager.stop();
      await node2.distributionEngine.stop();
      await node2.resourceRegistry.stop();
      await node2.clusterManager.stop();
    }
  });
});
