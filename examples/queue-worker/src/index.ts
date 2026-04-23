/**
 * queue-worker example
 *
 * Demonstrates:
 *   - RangeCoordinator for work partitioning
 *   - Ranges as queue partitions
 *   - Producing, consuming, and acknowledging tasks
 *
 * Run with:  npx ts-node src/index.ts
 */
import { createClusterNode, ClusterNodeConfig, RangeCoordinator } from 'distributed-core';
import { QueueHandler, rangeQueues, responseStore } from './queue-handler';
import { TaskProducer } from './task-producer';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== Distributed Queue Worker Example ===\n');

  // --- 1. Create a 3-worker cluster ----------------------------------------
  console.log('1. Creating 3-worker cluster...');
  const nodes: RangeCoordinator[] = [];

  for (let i = 0; i < 3; i++) {
    const config: ClusterNodeConfig = {
      ringId: 'queue-ring',
      rangeHandler: new QueueHandler(),
      coordinator: 'in-memory',
      transport: 'in-memory',
      nodeId: `worker-${i}`,
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

  await sleep(600);

  const producer = new TaskProducer(nodes);

  // --- 2. Produce 10 tasks --------------------------------------------------
  console.log('2. Producing 10 tasks...');
  for (let i = 0; i < 10; i++) {
    const taskId = `task-${i}`;
    await producer.enqueue(taskId, { description: `Process item #${i}` });
    console.log(`   Enqueued ${taskId}`);
  }

  // --- 3. Workers consume tasks ---------------------------------------------
  console.log('\n3. Workers consuming tasks...');
  let processed = 0;

  // Iterate over ranges that actually have tasks
  for (const [rangeId, queue] of rangeQueues) {
    while (true) {
      const task = await producer.dequeue(rangeId);
      if (!task) break;
      console.log(`   Processing ${task.taskId} from ${rangeId}: ${JSON.stringify(task.payload)}`);
      await producer.ack(rangeId, task.taskId);
      processed++;
    }
  }

  console.log(`\n   Total tasks processed: ${processed}`);

  // --- 4. Show queue state --------------------------------------------------
  console.log('\n4. Queue state:');
  for (const [rangeId, queue] of rangeQueues) {
    const pending = queue.filter((t) => t.status === 'pending').length;
    const completed = queue.filter((t) => t.status === 'completed').length;
    console.log(`   ${rangeId}: ${completed} completed, ${pending} pending`);
  }

  // --- 5. Shut down ---------------------------------------------------------
  console.log('\n5. Shutting down cluster...');
  for (const n of nodes) {
    await n.stop();
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
