/**
 * kv-database example
 *
 * Demonstrates:
 *   - RangeCoordinator + RangeHandler for distributed key-value storage
 *   - StateStore for per-range persistence
 *   - Consistent-hash key routing via KVClient
 *   - Range rebalancing when a node leaves
 *
 * Run with:  npx ts-node src/index.ts
 */
import { createClusterNode, ClusterNodeConfig, RangeCoordinator } from 'distributed-core';
import { KVHandler, responseStore, rangeStores } from './kv-handler';
import { KVClient } from './kv-client';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== Distributed KV Database Example ===\n');

  // --- 1. Create a 3-node cluster -----------------------------------------
  console.log('1. Creating 3-node cluster...');
  const nodes: RangeCoordinator[] = [];

  for (let i = 0; i < 3; i++) {
    const config: ClusterNodeConfig = {
      ringId: 'kv-ring',
      rangeHandler: new KVHandler(),
      coordinator: 'in-memory',
      transport: 'in-memory',
      nodeId: `kv-node-${i}`,
      coordinatorConfig: {
        testMode: true,
        heartbeatIntervalMs: 200,
        leaseRenewalIntervalMs: 400,
        leaseTimeoutMs: 2000,
      },
      logging: {
        enableFrameworkLogs: false,
        enableCoordinatorLogs: false,
      },
    };
    const node = createClusterNode(config);
    await node.start();
    nodes.push(node);
  }

  // Allow time for range acquisition
  await sleep(600);

  const client = new KVClient(nodes);

  // --- 2. SET several keys -------------------------------------------------
  console.log('2. Setting keys...');
  const kvPairs: [string, string][] = [
    ['user:1', 'Alice'],
    ['user:2', 'Bob'],
    ['user:3', 'Charlie'],
    ['config:theme', 'dark'],
    ['config:lang', 'en'],
  ];

  for (const [k, v] of kvPairs) {
    await client.set(k, v);
    console.log(`   SET ${k} = ${v}`);
  }

  // --- 3. GET keys back ----------------------------------------------------
  console.log('\n3. Getting keys...');
  for (const [k] of kvPairs) {
    const value = await client.get(k);
    console.log(`   GET ${k} => ${value}`);
  }

  // --- 4. DELETE a key -----------------------------------------------------
  console.log('\n4. Deleting user:2...');
  const deleted = await client.delete('user:2');
  console.log(`   DELETE user:2 => existed: ${deleted}`);
  const afterDelete = await client.get('user:2');
  console.log(`   GET user:2 => ${afterDelete}`);

  // --- 5. Remove a node and verify keys -----------------------------------
  console.log('\n5. Stopping kv-node-2 and verifying keys...');
  await nodes[2].stop();
  // Remove the stopped node from the client's node list
  const remainingNodes = nodes.slice(0, 2);
  const clientAfter = new KVClient(remainingNodes);

  // Keys whose range was on a surviving node should still be accessible
  await sleep(300);
  for (const [k, expected] of kvPairs) {
    if (k === 'user:2') continue; // was deleted
    try {
      const value = await clientAfter.get(k);
      console.log(`   GET ${k} => ${value ?? '(not on surviving nodes)'}`);
    } catch {
      console.log(`   GET ${k} => (range unavailable on surviving nodes)`);
    }
  }

  // --- 6. Print range distribution ----------------------------------------
  console.log('\n6. Range distribution:');
  for (const node of remainingNodes) {
    const ranges = await node.getOwnedRanges();
    console.log(`   ${(node as any).nodeId ?? 'node'}: ${ranges.join(', ') || '(none)'}`);
  }

  // --- 7. Shut down -------------------------------------------------------
  console.log('\n7. Shutting down cluster...');
  for (const n of remainingNodes) {
    await n.stop();
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
