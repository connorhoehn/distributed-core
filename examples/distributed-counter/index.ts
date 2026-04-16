/**
 * Distributed Counter Example
 *
 * Demonstrates: creating a shared resource (counter) on one node,
 * distributing it across the cluster, and updating it from different nodes.
 *
 * Run: npx ts-node examples/distributed-counter/index.ts
 */

import { ClusterManager } from '../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../src/config/BootstrapConfig';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';
import { ResourceRegistry, ResourceRegistryConfig } from '../../src/resources/core/ResourceRegistry';
import { EntityRegistryType } from '../../src/cluster/core/entity/EntityRegistryFactory';
import {
  ResourceMetadata,
  ResourceState,
  ResourceHealth,
  ResourceTypeDefinition,
} from '../../src/resources/types';
import { StateDeltaManager } from '../../src/cluster/delta-sync/StateDelta';
import { NodeId, Message } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll until a predicate is true, or throw after timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Node factory
// ---------------------------------------------------------------------------

interface NodeBundle {
  transport: InMemoryAdapter;
  clusterManager: ClusterManager;
  registry: ResourceRegistry;
}

function createNode(id: string, port: number, seedNodes: string[]): NodeBundle {
  const nodeId: NodeId = { id, address: '127.0.0.1', port };
  const transport = new InMemoryAdapter(nodeId);

  const config = new BootstrapConfig(
    seedNodes,
    5000, // joinTimeout
    200,  // gossipInterval (fast for demo)
    false // enableLogging
  );

  const clusterManager = new ClusterManager(id, transport, config, 100, {
    region: 'local',
    zone: 'zone-1',
    role: 'worker',
    tags: { example: 'distributed-counter' },
  });

  // NOTE: We intentionally do NOT pass clusterManager into ResourceRegistryConfig.
  // This avoids the feedback-loop issue where resource events bounce between the
  // registry and distribution layer. Instead we wire distribution manually below.
  const registryConfig: ResourceRegistryConfig = {
    nodeId: id,
    entityRegistryType: 'memory' as EntityRegistryType,
  };
  const registry = new ResourceRegistry(registryConfig);

  return { transport, clusterManager, registry };
}

// ---------------------------------------------------------------------------
// Counter resource type
// ---------------------------------------------------------------------------

const COUNTER_TYPE_DEF: ResourceTypeDefinition = {
  name: 'counter',
  typeName: 'counter',
  version: '1.0.0',
  schema: {
    description: 'A simple distributed counter',
    properties: {
      value: { type: 'number' },
    },
  },
};

function buildCounterResource(
  resourceId: string,
  nodeId: string,
  value: number
): ResourceMetadata {
  return {
    id: resourceId,
    resourceId,
    type: 'counter',
    resourceType: 'counter',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    timestamp: Date.now(),
    nodeId,
    state: ResourceState.ACTIVE,
    health: ResourceHealth.HEALTHY,
    applicationData: { value },
  };
}

// ---------------------------------------------------------------------------
// Manual distribution wiring (mirrors the e2e test pattern)
// ---------------------------------------------------------------------------

function setupDistribution(nodes: NodeBundle[]) {
  const deltaSyncManager = new StateDeltaManager({
    maxDeltaSize: 100,
    includeFullServices: true,
    enableCausality: true,
    compressionThreshold: 1024,
    enableEncryption: false,
  });

  // Per-node resource stores
  const resourceStores = new Map<string, Map<string, ResourceMetadata>>();
  for (const node of nodes) {
    resourceStores.set(node.clusterManager.localNodeId, new Map());
  }

  // Wire inbound delta handlers on each node's transport
  for (const node of nodes) {
    const localNodeId = node.clusterManager.localNodeId;
    const store = resourceStores.get(localNodeId)!;

    node.transport.onMessage(async (message: Message) => {
      const data = message.data as any;
      if (data?.type !== 'resource:delta') return;
      if (message.sender.id === localNodeId) return;

      const delta = data.payload;
      if (!delta || !delta.resources) return;

      for (const resourceOp of delta.resources) {
        if (!resourceOp.resource) continue;

        const resource = resourceOp.resource as ResourceMetadata;
        switch (resourceOp.operation) {
          case 'add':
          case 'modify':
            store.set(resourceOp.resourceId, resource);
            try {
              const existing = node.registry.getResource(resourceOp.resourceId);
              if (!existing) {
                await node.registry.createRemoteResource(resource);
              } else {
                // For updates, replace the entity in the registry
                await node.registry.updateResource(resourceOp.resourceId, resource);
              }
            } catch {
              // Resource may already exist; that is fine
            }
            break;
          case 'delete':
            store.delete(resourceOp.resourceId);
            break;
        }
      }
    });
  }

  /** Distribute a resource from a source node to all other cluster members. */
  async function distribute(
    sourceNode: NodeBundle,
    resource: ResourceMetadata,
    operation: 'add' | 'modify' | 'delete'
  ): Promise<void> {
    const sourceId = sourceNode.clusterManager.localNodeId;
    const sourceStore = resourceStores.get(sourceId)!;

    if (operation !== 'delete') {
      sourceStore.set(resource.resourceId, resource);
    } else {
      sourceStore.delete(resource.resourceId);
    }

    const delta = deltaSyncManager.generateResourceDelta(operation, resource, sourceId);

    const members = sourceNode.clusterManager
      .getAliveMembers()
      .filter((m) => m.id !== sourceId);

    if (members.length > 0) {
      await sourceNode.clusterManager.sendCustomMessage(
        'resource:delta',
        delta,
        members.map((m) => m.id)
      );
    }
  }

  return { distribute, resourceStores };
}

// ---------------------------------------------------------------------------
// Helper: read counter value from a node's registry
// ---------------------------------------------------------------------------

function getCounterValue(registry: ResourceRegistry, resourceId: string): number | undefined {
  const resource = registry.getResource(resourceId);
  if (!resource) return undefined;
  return resource.applicationData?.value;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log('=== Distributed Counter Example ===\n');

  // Clean any leftover in-memory transport state
  InMemoryAdapter.clearRegistry();

  // -----------------------------------------------------------------------
  // Step 1: Create 3 nodes
  // -----------------------------------------------------------------------
  log('Step 1: Creating 3 nodes with InMemoryAdapter + ResourceRegistry...');

  const node0 = createNode('node-0', 9000, []);
  const node1 = createNode('node-1', 9001, ['node-0']);
  const node2 = createNode('node-2', 9002, ['node-0']);

  const allNodes = [node0, node1, node2];

  // Register the counter resource type on all nodes
  for (const node of allNodes) {
    node.registry.registerResourceType(COUNTER_TYPE_DEF);
  }

  log('  Nodes created: node-0, node-1, node-2');

  // -----------------------------------------------------------------------
  // Step 2: Start transports, cluster managers, and registries
  // -----------------------------------------------------------------------
  log('Step 2: Starting transports and forming cluster...');

  for (const node of allNodes) {
    await node.transport.start();
  }
  for (const node of allNodes) {
    await node.clusterManager.start();
  }
  for (const node of allNodes) {
    await node.registry.start();
  }

  // Set up manual distribution wiring
  const { distribute, resourceStores } = setupDistribution(allNodes);

  // -----------------------------------------------------------------------
  // Step 3: Wait for full cluster formation
  // -----------------------------------------------------------------------
  log('Step 3: Waiting for cluster to form (3 members)...');

  await waitFor(
    () =>
      node0.clusterManager.getMemberCount() >= 3 &&
      node1.clusterManager.getMemberCount() >= 3 &&
      node2.clusterManager.getMemberCount() >= 3,
    8000
  );

  log(
    `  Cluster formed! Members: ${node0.clusterManager.getMemberCount()} | ` +
    `${node1.clusterManager.getMemberCount()} | ${node2.clusterManager.getMemberCount()}`
  );

  // -----------------------------------------------------------------------
  // Step 4: Create a counter resource on node-0 with initial value 0
  // -----------------------------------------------------------------------
  log('Step 4: Creating counter resource on node-0 with value = 0...');

  const counterMeta = buildCounterResource('shared-counter', 'node-0', 0);
  const createdCounter = await node0.registry.createResource(counterMeta);

  log(`  Created: ${createdCounter.resourceId} (value = ${createdCounter.applicationData?.value})`);

  // -----------------------------------------------------------------------
  // Step 5: Distribute counter to all nodes and wait for arrival
  // -----------------------------------------------------------------------
  log('Step 5: Distributing counter to node-1 and node-2...');

  await distribute(node0, createdCounter, 'add');

  const n1Store = resourceStores.get('node-1')!;
  const n2Store = resourceStores.get('node-2')!;

  await waitFor(
    () => n1Store.has('shared-counter') && n2Store.has('shared-counter'),
    5000
  );

  // Also wait for EntityRegistry integration
  await waitFor(
    () =>
      node1.registry.getResource('shared-counter') !== null &&
      node2.registry.getResource('shared-counter') !== null,
    2000
  );

  log('  Counter distributed to all nodes!');
  log(`    node-0 value: ${getCounterValue(node0.registry, 'shared-counter')}`);
  log(`    node-1 value: ${getCounterValue(node1.registry, 'shared-counter')}`);
  log(`    node-2 value: ${getCounterValue(node2.registry, 'shared-counter')}`);

  // -----------------------------------------------------------------------
  // Step 6: Increment the counter from node-1 (update the resource)
  // -----------------------------------------------------------------------
  log('\nStep 6: Incrementing counter from node-1 (value 0 -> 1)...');

  const currentOnNode1 = node1.registry.getResource('shared-counter')!;
  const newValue = (currentOnNode1.applicationData?.value ?? 0) + 1;

  const updatedCounter = await node1.registry.updateResource('shared-counter', {
    applicationData: { value: newValue },
    updatedAt: new Date(),
  });

  log(`  node-1 local value after increment: ${updatedCounter.applicationData?.value}`);

  // Distribute the update from node-1
  await distribute(node1, updatedCounter, 'modify');

  // Wait for the update to arrive at node-0 and node-2
  const n0Store = resourceStores.get('node-0')!;
  await waitFor(
    () =>
      n0Store.get('shared-counter')?.applicationData?.value === 1 &&
      n2Store.get('shared-counter')?.applicationData?.value === 1,
    5000
  );

  // -----------------------------------------------------------------------
  // Step 7: Show the counter value from all nodes
  // -----------------------------------------------------------------------
  log('\nStep 7: Counter values across all nodes after distribution:');
  log(`    node-0 value: ${n0Store.get('shared-counter')?.applicationData?.value}`);
  log(`    node-1 value: ${getCounterValue(node1.registry, 'shared-counter')}`);
  log(`    node-2 value: ${n2Store.get('shared-counter')?.applicationData?.value}`);

  // Bonus: increment again from node-2
  log('\n  Bonus: Incrementing counter from node-2 (value 1 -> 2)...');

  const currentOnNode2 = node2.registry.getResource('shared-counter')!;
  const newValue2 = (currentOnNode2.applicationData?.value ?? 0) + 1;

  const updatedCounter2 = await node2.registry.updateResource('shared-counter', {
    applicationData: { value: newValue2 },
    updatedAt: new Date(),
  });

  await distribute(node2, updatedCounter2, 'modify');

  await waitFor(
    () =>
      n0Store.get('shared-counter')?.applicationData?.value === 2 &&
      n1Store.get('shared-counter')?.applicationData?.value === 2,
    5000
  );

  log('\n  Final counter values across all nodes:');
  log(`    node-0 value: ${n0Store.get('shared-counter')?.applicationData?.value}`);
  log(`    node-1 value: ${n1Store.get('shared-counter')?.applicationData?.value}`);
  log(`    node-2 value: ${getCounterValue(node2.registry, 'shared-counter')}`);

  // -----------------------------------------------------------------------
  // Step 8: Graceful shutdown
  // -----------------------------------------------------------------------
  log('\nStep 8: Graceful shutdown...');

  for (const node of [...allNodes].reverse()) {
    await node.registry.stop();
  }
  for (const node of [...allNodes].reverse()) {
    await node.clusterManager.stop();
  }
  for (const node of [...allNodes].reverse()) {
    await node.transport.stop();
  }

  InMemoryAdapter.clearRegistry();

  log('\n=== Done! Counter was shared and updated across 3 distributed nodes. ===');
}

main().catch((err) => {
  console.error('Example failed:', err);
  process.exit(1);
});
