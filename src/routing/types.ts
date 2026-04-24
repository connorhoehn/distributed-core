import { EntityUpdate } from '../cluster/entity/types';
import { MetricsRegistry } from '../monitoring/metrics/MetricsRegistry';

/**
 * Resolved routing target for a resource.
 * isLocal === true means this node is the owner — no network hop needed.
 */
export interface RouteTarget {
  nodeId: string;
  address: string;
  port: number;
  isLocal: boolean;
}

/**
 * A claimed resource from the perspective of the caller.
 * Mirrors EntityRecord but uses domain-neutral naming.
 */
export interface ResourceHandle {
  resourceId: string;
  ownerNodeId: string;
  metadata: Record<string, unknown>;
  claimedAt: number;
  version: number;
}

export interface ClaimOptions {
  metadata?: Record<string, unknown>;
}

export interface ResourceRouterConfig {
  /**
   * Determines which node should own a resource when claim() is first called.
   * Default: LocalPlacement (always this node).
   */
  placement?: PlacementStrategy;
  metrics?: MetricsRegistry;
}

/**
 * Decides which cluster node should own a given resource.
 *
 * Receives the resource ID, the local node's ID, and the current list of
 * alive node IDs. Returns the nodeId that should own the resource.
 *
 * When the selected node is not the local node, the caller is responsible
 * for forwarding the claim request to the target node — ResourceRouter
 * always claims on the local node.
 */
export interface PlacementStrategy {
  selectNode(
    resourceId: string,
    localNodeId: string,
    candidates: string[]
  ): string;
}

export { EntityUpdate };
