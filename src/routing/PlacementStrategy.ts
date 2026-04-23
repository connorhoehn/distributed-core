import { ConsistentHashRing } from './ConsistentHashRing';
import { PlacementStrategy, ResourceHandle } from './types';

/**
 * Always places resources on the local node.
 * Use this when each node is fully responsible for its own resources
 * (e.g. each node independently handles its own WebSocket clients).
 */
export class LocalPlacement implements PlacementStrategy {
  selectNode(_resourceId: string, localNodeId: string, _candidates: string[]): string {
    return localNodeId;
  }
}

/**
 * Assigns resources deterministically via consistent hashing.
 * The same resourceId always maps to the same node as long as cluster
 * membership is stable — good for stateless routing where requests can
 * arrive at any node and be forwarded.
 *
 * Ring is rebuilt from candidates on each call; the cost is proportional
 * to the number of nodes (typically <50), not the number of resources.
 */
export class HashPlacement implements PlacementStrategy {
  private readonly virtualNodesPerNode: number;

  constructor(virtualNodesPerNode = 100) {
    this.virtualNodesPerNode = virtualNodesPerNode;
  }

  selectNode(resourceId: string, localNodeId: string, candidates: string[]): string {
    if (candidates.length === 0) return localNodeId;
    const ring = new ConsistentHashRing(this.virtualNodesPerNode);
    for (const nodeId of candidates) ring.addNode(nodeId);
    return ring.getNode(resourceId) ?? localNodeId;
  }
}

/**
 * Assigns resources to the node that currently owns the fewest resources.
 * Useful for work distribution — rooms, pipelines, recording jobs.
 *
 * Requires access to the current resource list; pass a getter function
 * that returns all known ResourceHandles at call time.
 */
export class LeastLoadedPlacement implements PlacementStrategy {
  private readonly getAll: () => ResourceHandle[];

  constructor(getAll: () => ResourceHandle[]) {
    this.getAll = getAll;
  }

  selectNode(_resourceId: string, localNodeId: string, candidates: string[]): string {
    if (candidates.length === 0) return localNodeId;

    const counts = new Map<string, number>(candidates.map((id) => [id, 0]));
    for (const handle of this.getAll()) {
      const c = counts.get(handle.ownerNodeId);
      if (c !== undefined) counts.set(handle.ownerNodeId, c + 1);
    }

    let minLoad = Infinity;
    let selected = localNodeId;
    for (const [nodeId, load] of counts) {
      // Prefer local node on ties to avoid unnecessary cross-node hops
      if (load < minLoad || (load === minLoad && nodeId === localNodeId)) {
        minLoad = load;
        selected = nodeId;
      }
    }
    return selected;
  }
}

/**
 * Picks a random alive node on every call.
 * Useful for even distribution when resources are stateless and the
 * caller does not need stable affinity.
 */
export class RandomPlacement implements PlacementStrategy {
  selectNode(_resourceId: string, localNodeId: string, candidates: string[]): string {
    if (candidates.length === 0) return localNodeId;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
}
