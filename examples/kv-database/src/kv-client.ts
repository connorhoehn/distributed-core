/**
 * KVClient -- thin client that sends SET / GET / DELETE messages to the
 * cluster by constructing ClusterMessages and delivering them through a
 * RangeCoordinator node.
 *
 * Key routing: the client discovers which ranges are actually owned across
 * the cluster, hashes the key into one of them, and sends the message to
 * the owning node.
 */
import {
  RangeCoordinator,
  FrameworkClusterMessage as ClusterMessage,
} from 'distributed-core';
import { responseStore } from './kv-handler';

let messageCounter = 0;

function nextMessageId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}

/**
 * Simple hash of a string to a non-negative integer.
 */
function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * A mapping from rangeId to the node that owns it.
 */
interface RangeOwnership {
  rangeId: string;
  node: RangeCoordinator;
}

export class KVClient {
  private nodes: RangeCoordinator[];

  constructor(nodes: RangeCoordinator[]) {
    this.nodes = nodes;
  }

  /**
   * Store a key-value pair.
   */
  async set(key: string, value: string): Promise<void> {
    const { node, rangeId } = await this.findOwner(key);
    const msgId = nextMessageId();
    const message: ClusterMessage = {
      id: msgId,
      type: 'SET',
      payload: { key, value },
      sourceNodeId: 'client',
      targetRangeId: rangeId,
      timestamp: Date.now(),
    };
    await node.sendMessage(message);
    const resp = responseStore.get(msgId);
    if (resp && !resp.ok) {
      throw new Error(`SET failed: ${resp.error}`);
    }
  }

  /**
   * Retrieve the value for a key, or null if it does not exist.
   */
  async get(key: string): Promise<string | null> {
    const { node, rangeId } = await this.findOwner(key);
    const msgId = nextMessageId();
    const message: ClusterMessage = {
      id: msgId,
      type: 'GET',
      payload: { key },
      sourceNodeId: 'client',
      targetRangeId: rangeId,
      timestamp: Date.now(),
    };
    await node.sendMessage(message);
    const resp = responseStore.get(msgId);
    return resp?.value ?? null;
  }

  /**
   * Delete a key. Returns true if the key existed.
   */
  async delete(key: string): Promise<boolean> {
    const { node, rangeId } = await this.findOwner(key);
    const msgId = nextMessageId();
    const message: ClusterMessage = {
      id: msgId,
      type: 'DELETE',
      payload: { key },
      sourceNodeId: 'client',
      targetRangeId: rangeId,
      timestamp: Date.now(),
    };
    await node.sendMessage(message);
    const resp = responseStore.get(msgId);
    return resp?.deleted ?? false;
  }

  /**
   * Discover all ranges owned across the cluster and hash the key to
   * one of them, returning the owning node and range ID.
   */
  private async findOwner(key: string): Promise<RangeOwnership> {
    const allOwnership: RangeOwnership[] = [];
    for (const node of this.nodes) {
      const ranges = await node.getOwnedRanges();
      for (const rangeId of ranges) {
        allOwnership.push({ rangeId, node });
      }
    }

    if (allOwnership.length === 0) {
      throw new Error('No ranges available in the cluster');
    }

    // Deduplicate by rangeId (prefer first node listed)
    const seen = new Set<string>();
    const unique: RangeOwnership[] = [];
    for (const entry of allOwnership) {
      if (!seen.has(entry.rangeId)) {
        seen.add(entry.rangeId);
        unique.push(entry);
      }
    }

    // Sort for deterministic routing
    unique.sort((a, b) => a.rangeId.localeCompare(b.rangeId));

    const idx = hashString(key) % unique.length;
    return unique[idx];
  }
}
