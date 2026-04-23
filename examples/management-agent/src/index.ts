/**
 * management-agent example
 *
 * Demonstrates:
 *   - DiagnosticTool, MetricsTracker, ChaosInjector
 *   - Cluster health monitoring and dashboard rendering
 *   - Optional chaos injection and recovery observation
 *
 * Run with:  npx ts-node src/index.ts
 */
import { Node } from 'distributed-core';
import { AgentHandler } from './agent-handler';
import { renderDashboard } from './dashboard';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== Management Agent Example ===\n');

  // --- 1. Create a 3-node cluster ------------------------------------------
  console.log('1. Creating 3-node cluster...');
  const nodes: Node[] = [];

  for (let i = 0; i < 3; i++) {
    const node = new Node({
      id: `mgmt-node-${i}`,
      clusterId: 'mgmt-cluster',
      service: 'management-demo',
      region: 'us-east',
      zone: `zone-${i % 2}`,
      role: i === 0 ? 'leader' : 'follower',
      seedNodes: nodes.map((n) => n.id),
    });
    await node.start();
    nodes.push(node);
  }

  await sleep(300);

  // --- 2. Start the management agent ----------------------------------------
  console.log('2. Starting management agent...');
  const agent = new AgentHandler(nodes);
  await agent.start();

  // --- 3. Collect and display initial dashboard -----------------------------
  console.log('3. Initial cluster dashboard:\n');
  const snap1 = await agent.collectSnapshot();
  console.log(renderDashboard(snap1));

  // --- 4. Inject chaos (network latency) ------------------------------------
  console.log('\n4. Injecting 200ms network latency...');
  await agent.injectLatency(200);
  await sleep(100);

  const snap2 = await agent.collectSnapshot();
  console.log(renderDashboard(snap2));

  // --- 5. Stop chaos and observe recovery -----------------------------------
  console.log('\n5. Stopping chaos scenarios...');
  await agent.stopChaos();
  await sleep(100);

  const snap3 = await agent.collectSnapshot();
  console.log(renderDashboard(snap3));

  // --- 6. Print chaos statistics --------------------------------------------
  console.log('6. Chaos statistics:');
  console.log(`   ${JSON.stringify(agent.getChaosStats(), null, 2)}`);

  // --- 7. Shut down ---------------------------------------------------------
  console.log('\n7. Shutting down...');
  await agent.stop();
  for (const n of nodes) {
    await n.stop();
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
