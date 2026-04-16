/**
 * Basic Cluster Example
 *
 * Demonstrates: creating 3 nodes, forming a cluster via gossip,
 * sending messages between nodes, and graceful shutdown.
 *
 * Run: npx ts-node examples/basic-cluster/index.ts
 */

import { Node } from '../../src/common/Node';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(step: string, detail: string): void {
  console.log(`\n[${'='.repeat(60)}]`);
  console.log(`  ${step}`);
  console.log(`  ${detail}`);
  console.log(`[${'='.repeat(60)}]`);
}

function info(msg: string): void {
  console.log(`  -> ${msg}`);
}

/**
 * Poll until a predicate is true, or throw after timeout.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 8000,
  intervalMs: number = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Clean any leftover in-memory adapters from previous runs
  InMemoryAdapter.clearRegistry();

  // ------------------------------------------------------------------
  // Step 1 - Create 3 nodes with InMemoryAdapter
  // ------------------------------------------------------------------
  log('Step 1', 'Creating 3 nodes with in-memory transport');

  const transport0 = new InMemoryAdapter({ id: 'node-0', address: '127.0.0.1', port: 4000 });
  const transport1 = new InMemoryAdapter({ id: 'node-1', address: '127.0.0.1', port: 4001 });
  const transport2 = new InMemoryAdapter({ id: 'node-2', address: '127.0.0.1', port: 4002 });

  const node0 = new Node({
    id: 'node-0',
    transport: transport0,
    seedNodes: [],               // node-0 is the seed
    region: 'us-east',
    zone: 'us-east-1a',
    role: 'leader',
  });

  const node1 = new Node({
    id: 'node-1',
    transport: transport1,
    seedNodes: ['node-0'],       // joins via node-0
    region: 'us-east',
    zone: 'us-east-1b',
    role: 'worker',
  });

  const node2 = new Node({
    id: 'node-2',
    transport: transport2,
    seedNodes: ['node-0'],       // joins via node-0
    region: 'us-west',
    zone: 'us-west-1a',
    role: 'worker',
  });

  info('node-0 created (seed node)');
  info('node-1 created (seed: node-0)');
  info('node-2 created (seed: node-0)');

  // ------------------------------------------------------------------
  // Step 2 - Start all nodes
  // ------------------------------------------------------------------
  log('Step 2', 'Starting all nodes -- cluster formation begins');

  await node0.start();
  info('node-0 started');

  await node1.start();
  info('node-1 started');

  await node2.start();
  info('node-2 started');

  // ------------------------------------------------------------------
  // Step 3 - Wait for membership propagation
  // ------------------------------------------------------------------
  log('Step 3', 'Waiting for gossip to propagate membership (all nodes see 3 members)');

  await waitFor(() => {
    return (
      node0.getMemberCount() >= 3 &&
      node1.getMemberCount() >= 3 &&
      node2.getMemberCount() >= 3
    );
  }, 10000);

  info(`Membership converged! All nodes see the full cluster.`);

  // ------------------------------------------------------------------
  // Step 4 - Print membership from each node's perspective
  // ------------------------------------------------------------------
  log('Step 4', 'Printing cluster membership from each node\'s perspective');

  for (const node of [node0, node1, node2]) {
    const membership = node.getMembership();
    const members = Array.from(membership.values());
    console.log(`\n  [${node.id}] sees ${members.length} members:`);
    for (const member of members) {
      const meta = member.metadata || {};
      console.log(
        `    - ${member.id}  status=${member.status}  role=${(meta as any).role ?? '?'}  region=${(meta as any).region ?? '?'}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // Step 5 & 6 - Register handler on node-1, then send message from node-0
  // ------------------------------------------------------------------
  log('Step 5', 'Registering a custom message handler on node-1');

  // We listen at the transport level for custom messages (same pattern as
  // the integration tests). The handler filters for our custom type.
  const receivedMessages: any[] = [];

  transport1.onMessage((message) => {
    const data = message.data as any;
    if (data && data.type === 'greeting') {
      receivedMessages.push(data);
      info(`node-1 RECEIVED message: type="${data.type}" payload=${JSON.stringify(data.payload)}`);
    }
  });

  info('Handler registered on node-1 for type "greeting"');

  log('Step 6', 'Sending a custom "greeting" message from node-0 to node-1');

  await node0.cluster.sendCustomMessage(
    'greeting',
    { text: 'Hello from node-0!', sentAt: new Date().toISOString() },
    ['node-1'],
  );

  info('Message sent from node-0 -> node-1');

  // Give the in-memory transport a moment to deliver
  await waitFor(() => receivedMessages.length > 0, 3000);

  info(`node-1 received ${receivedMessages.length} message(s) -- success!`);

  // ------------------------------------------------------------------
  // Step 7 - Graceful shutdown
  // ------------------------------------------------------------------
  log('Step 7', 'Graceful shutdown of all nodes');

  await node2.stop();
  info('node-2 stopped');

  await node1.stop();
  info('node-1 stopped');

  await node0.stop();
  info('node-0 stopped');

  InMemoryAdapter.clearRegistry();

  console.log('\nDone. Cluster example completed successfully.\n');
}

// Run and handle errors
main().catch((err) => {
  console.error('Example failed:', err);
  process.exit(1);
});
