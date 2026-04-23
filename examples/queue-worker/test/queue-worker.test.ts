import {
  createClusterNode,
  ClusterNodeConfig,
  RangeCoordinator,
} from 'distributed-core';
import { QueueHandler, rangeQueues, responseStore } from '../src/queue-handler';
import { TaskProducer } from '../src/task-producer';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeNode(id: string): RangeCoordinator {
  const config: ClusterNodeConfig = {
    ringId: 'test-queue-ring',
    rangeHandler: new QueueHandler(),
    coordinator: 'in-memory',
    transport: 'in-memory',
    nodeId: id,
    coordinatorConfig: {
      testMode: true,
      heartbeatIntervalMs: 100,
      leaseRenewalIntervalMs: 200,
      leaseTimeoutMs: 1000,
    },
    logging: {
      enableFrameworkLogs: false,
      enableCoordinatorLogs: false,
    },
  };
  return createClusterNode(config);
}

describe('queue-worker example', () => {
  let nodes: RangeCoordinator[];

  beforeEach(async () => {
    responseStore.clear();
    rangeQueues.clear();

    nodes = [makeNode('qw-0'), makeNode('qw-1'), makeNode('qw-2')];
    for (const n of nodes) {
      await n.start();
    }
    await sleep(600);
  });

  afterEach(async () => {
    for (const n of nodes) {
      try { await n.stop(); } catch { /* already stopped */ }
    }
  });

  it('enqueues and dequeues a task', async () => {
    const producer = new TaskProducer(nodes);
    await producer.enqueue('t-1', { work: 'do something' });

    // Find which range has the task
    let found = false;
    for (const [rangeId] of rangeQueues) {
      const task = await producer.dequeue(rangeId);
      if (task) {
        expect(task.taskId).toBe('t-1');
        expect(task.status).toBe('processing');
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('ACK marks a task as completed', async () => {
    const producer = new TaskProducer(nodes);
    await producer.enqueue('t-2', { work: 'finish me' });

    for (const [rangeId, queue] of rangeQueues) {
      const task = await producer.dequeue(rangeId);
      if (task) {
        await producer.ack(rangeId, task.taskId);
        const stored = queue.find((t) => t.taskId === 't-2');
        expect(stored?.status).toBe('completed');
        break;
      }
    }
  });

  it('processes multiple tasks across partitions', async () => {
    const producer = new TaskProducer(nodes);
    const count = 10;
    for (let i = 0; i < count; i++) {
      await producer.enqueue(`mt-${i}`, { index: i });
    }

    let processed = 0;
    for (const [rangeId] of rangeQueues) {
      while (true) {
        const task = await producer.dequeue(rangeId);
        if (!task) break;
        await producer.ack(rangeId, task.taskId);
        processed++;
      }
    }
    expect(processed).toBe(count);
  });

  it('dequeue returns null when queue is empty', async () => {
    const producer = new TaskProducer(nodes);

    // Try to dequeue from the first range (which should be empty)
    for (const [rangeId] of rangeQueues) {
      const task = await producer.dequeue(rangeId);
      expect(task).toBeNull();
      break;
    }
  });
});
