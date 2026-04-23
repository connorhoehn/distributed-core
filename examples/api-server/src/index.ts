/**
 * api-server example
 *
 * Demonstrates:
 *   - Node class with Router, ConnectionManager, and message handlers
 *   - Registering HTTP-like routes on a cluster of nodes
 *   - StateStore for data persistence
 *   - Sending messages and reading responses
 *
 * Run with:  npx ts-node src/index.ts
 */
import { Node, StateStore } from 'distributed-core';
import { registerApiHandlers, sendApiRequest, apiResponses } from './api-handler';
import { routes } from './routes';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== Distributed API Server Example ===\n');

  // --- 1. Create a 3-node cluster ------------------------------------------
  console.log('1. Creating 3-node API cluster...');
  const stores: StateStore[] = [];
  const nodes: Node[] = [];

  for (let i = 0; i < 3; i++) {
    const node = new Node({
      id: `api-node-${i}`,
      clusterId: 'api-cluster',
      service: 'api-server',
      region: 'us-east',
      zone: `zone-${i % 2}`,
      role: i === 0 ? 'primary' : 'replica',
      seedNodes: nodes.map((n) => n.id),
    });
    const store = new StateStore();
    registerApiHandlers(node, store);
    await node.start();
    nodes.push(node);
    stores.push(store);
  }

  await sleep(300);

  // --- 2. List available routes ---------------------------------------------
  console.log('2. Available routes:');
  for (const route of routes) {
    console.log(`   ${route.messageType} - ${route.description}`);
  }

  // --- 3. Health check ------------------------------------------------------
  console.log('\n3. GET:/health on api-node-0:');
  const health = sendApiRequest(nodes[0], 'GET:/health');
  console.log(`   ${JSON.stringify(health, null, 2)}`);

  // --- 4. List members ------------------------------------------------------
  console.log('\n4. GET:/members on api-node-1:');
  const members = sendApiRequest(nodes[1], 'GET:/members');
  console.log(`   ${JSON.stringify(members, null, 2)}`);

  // --- 5. Store and retrieve data -------------------------------------------
  console.log('\n5. POST:/data and GET:/data on api-node-0:');
  const storeResult = sendApiRequest(nodes[0], 'POST:/data', {
    key: 'session:abc',
    value: { user: 'alice', loggedIn: true },
  });
  console.log(`   POST result: ${JSON.stringify(storeResult)}`);

  const getResult = sendApiRequest(nodes[0], 'GET:/data', { key: 'session:abc' });
  console.log(`   GET  result: ${JSON.stringify(getResult)}`);

  // --- 6. Cluster info ------------------------------------------------------
  console.log('\n6. GET:/info on api-node-2:');
  const info = sendApiRequest(nodes[2], 'GET:/info');
  console.log(`   ${JSON.stringify(info, null, 2)}`);

  // --- 7. Shut down ---------------------------------------------------------
  console.log('\n7. Shutting down cluster...');
  for (const n of nodes) {
    await n.stop();
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
