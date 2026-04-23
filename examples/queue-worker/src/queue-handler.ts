/**
 * QueueHandler -- a RangeHandler that treats each range as a task queue
 * partition.  Workers dequeue tasks from ranges they own and acknowledge
 * completion.
 *
 * Message types:
 *   ENQUEUE  -- add a task to the queue partition identified by targetRangeId
 *   DEQUEUE  -- pull the next pending task from the partition
 *   ACK      -- mark a task as completed
 */
import {
  FrameworkRangeHandler as RangeHandler,
  FrameworkClusterMessage as ClusterMessage,
  ClusterInfo,
  RangeId,
} from 'distributed-core';

export interface Task {
  taskId: string;
  payload: any;
  status: 'pending' | 'processing' | 'completed';
  enqueuedAt: number;
  completedAt?: number;
}

/** Per-range queues accessible for tests and the demo script. */
export const rangeQueues = new Map<string, Task[]>();

/** Response accumulator for single-process messaging. */
export const responseStore = new Map<string, any>();

export class QueueHandler implements RangeHandler {
  async onJoin(rangeId: RangeId, _clusterInfo: ClusterInfo): Promise<void> {
    if (!rangeQueues.has(rangeId)) {
      rangeQueues.set(rangeId, []);
    }
  }

  async onMessage(message: ClusterMessage): Promise<void> {
    const { type, payload, id, targetRangeId } = message;
    const queue = targetRangeId ? rangeQueues.get(targetRangeId) : undefined;

    switch (type) {
      case 'ENQUEUE': {
        if (!queue) {
          responseStore.set(id, { ok: false, error: 'range not found' });
          return;
        }
        const task: Task = {
          taskId: payload.taskId,
          payload: payload.data,
          status: 'pending',
          enqueuedAt: Date.now(),
        };
        queue.push(task);
        responseStore.set(id, { ok: true, taskId: task.taskId });
        break;
      }

      case 'DEQUEUE': {
        if (!queue) {
          responseStore.set(id, { ok: false, error: 'range not found' });
          return;
        }
        const next = queue.find((t) => t.status === 'pending');
        if (next) {
          next.status = 'processing';
          responseStore.set(id, { ok: true, task: { ...next } });
        } else {
          responseStore.set(id, { ok: true, task: null });
        }
        break;
      }

      case 'ACK': {
        if (!queue) {
          responseStore.set(id, { ok: false, error: 'range not found' });
          return;
        }
        const task = queue.find((t) => t.taskId === payload.taskId);
        if (task) {
          task.status = 'completed';
          task.completedAt = Date.now();
          responseStore.set(id, { ok: true });
        } else {
          responseStore.set(id, { ok: false, error: 'task not found' });
        }
        break;
      }

      default:
        responseStore.set(id, { ok: false, error: `unknown command: ${type}` });
    }
  }

  async onLeave(rangeId: RangeId): Promise<void> {
    // In production we would migrate pending tasks to the new owner.
    // Here we leave them in the shared map for simplicity.
  }

  async onTopologyChange(clusterInfo: ClusterInfo): Promise<void> {
    // Could redistribute pending tasks here.
  }
}
