/**
 * TaskProducer -- generates tasks and enqueues them across range partitions
 * in the cluster.  Tasks are distributed across the ranges that nodes
 * actually own, using a hash of the task ID.
 */
import {
  RangeCoordinator,
  FrameworkClusterMessage as ClusterMessage,
} from 'distributed-core';
import { responseStore, Task } from './queue-handler';

let counter = 0;

function nextId(): string {
  return `msg-${Date.now()}-${++counter}`;
}

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

interface RangeOwnership {
  rangeId: string;
  node: RangeCoordinator;
}

export class TaskProducer {
  private nodes: RangeCoordinator[];

  constructor(nodes: RangeCoordinator[]) {
    this.nodes = nodes;
  }

  /**
   * Enqueue a task.  The task is assigned to a range using a hash of its ID.
   */
  async enqueue(taskId: string, data: any): Promise<void> {
    const { node, rangeId } = await this.findOwner(taskId);
    const msgId = nextId();
    const message: ClusterMessage = {
      id: msgId,
      type: 'ENQUEUE',
      payload: { taskId, data },
      sourceNodeId: 'producer',
      targetRangeId: rangeId,
      timestamp: Date.now(),
    };
    await node.sendMessage(message);
  }

  /**
   * Dequeue the next pending task from a specific range.
   */
  async dequeue(rangeId: string): Promise<Task | null> {
    const node = await this.findNodeForRange(rangeId);
    if (!node) return null;

    const msgId = nextId();
    const message: ClusterMessage = {
      id: msgId,
      type: 'DEQUEUE',
      payload: {},
      sourceNodeId: 'consumer',
      targetRangeId: rangeId,
      timestamp: Date.now(),
    };
    await node.sendMessage(message);
    const resp = responseStore.get(msgId);
    return resp?.task ?? null;
  }

  /**
   * Acknowledge a completed task.
   */
  async ack(rangeId: string, taskId: string): Promise<void> {
    const node = await this.findNodeForRange(rangeId);
    if (!node) return;

    const msgId = nextId();
    const message: ClusterMessage = {
      id: msgId,
      type: 'ACK',
      payload: { taskId },
      sourceNodeId: 'consumer',
      targetRangeId: rangeId,
      timestamp: Date.now(),
    };
    await node.sendMessage(message);
  }

  /**
   * Discover owned ranges and hash the key to find the right node+range.
   */
  private async findOwner(key: string): Promise<RangeOwnership> {
    const all = await this.getAllOwnership();
    if (all.length === 0) throw new Error('No ranges available');
    const idx = hashString(key) % all.length;
    return all[idx];
  }

  /**
   * Find the node that owns a specific range.
   */
  private async findNodeForRange(rangeId: string): Promise<RangeCoordinator | null> {
    for (const node of this.nodes) {
      const owned = await node.getOwnedRanges();
      if (owned.includes(rangeId)) return node;
    }
    return null;
  }

  /**
   * Collect deduplicated, sorted range ownership across all nodes.
   */
  private async getAllOwnership(): Promise<RangeOwnership[]> {
    const all: RangeOwnership[] = [];
    const seen = new Set<string>();
    for (const node of this.nodes) {
      const ranges = await node.getOwnedRanges();
      for (const rangeId of ranges) {
        if (!seen.has(rangeId)) {
          seen.add(rangeId);
          all.push({ rangeId, node });
        }
      }
    }
    all.sort((a, b) => a.rangeId.localeCompare(b.rangeId));
    return all;
  }
}
