import { ResourceOperation } from './ResourceOperation';
import { ClusterRouting } from '../../routing/ClusterRouting';
import { ClusterManager } from '../ClusterManager';

// Node.js environment access
declare const console: any;

export interface NodeRoute {
  nodeId: string;
  resourcePlacement: 'primary' | 'replica';
  deliveryMethod: 'direct' | 'gossip';
  local: boolean; // Phase D: Add local flag for routing purity
}

export interface RoutingStrategy {
  preferPrimary: boolean;
  replicationFactor: number;
  useGossipFallback: boolean;
}

/**
 * ClusterFanoutRouter handles routing resource operations to appropriate cluster nodes
 * 
 * Phase D: Pure routing implementation - only uses clusterManager.getRouting() and semantics.routing
 * Returns NodeRoute[] with local:boolean flag, no side effects
 */
export class ClusterFanoutRouter {
  private clusterManager: ClusterManager;
  private defaultStrategy: RoutingStrategy;

  constructor(
    clusterManager: ClusterManager,
    strategy: Partial<RoutingStrategy> = {}
  ) {
    this.clusterManager = clusterManager;
    this.defaultStrategy = {
      preferPrimary: true,
      replicationFactor: 3,
      useGossipFallback: true,
      ...strategy
    };
  }

  /**
   * Pure routing function - determines target nodes without side effects
   * Phase D: Only uses clusterManager.getRouting() and semantics.routing
   */
  async route(resourceId: string, semantics: RoutingStrategy): Promise<NodeRoute[]> {
    const routes: NodeRoute[] = [];
    const routing = this.clusterManager.getRouting();
    const localNodeId = this.clusterManager.localNodeId;

    try {
      // Get primary node for resource
      const primaryNode = routing.getNodeForKey(resourceId);
      if (primaryNode) {
        routes.push({
          nodeId: primaryNode,
          resourcePlacement: 'primary',
          deliveryMethod: 'direct',
          local: primaryNode === localNodeId
        });
      }

      // Get replica nodes if replication is enabled
      if (semantics.replicationFactor > 1) {
        const replicaNodes = routing.getReplicaNodes(
          resourceId, 
          semantics.replicationFactor
        );

        for (const nodeId of replicaNodes) {
          // Skip primary node (already added)
          if (nodeId === primaryNode) continue;

          routes.push({
            nodeId,
            resourcePlacement: 'replica',
            deliveryMethod: 'direct',
            local: nodeId === localNodeId
          });
        }
      }

      console.log(`🧭 Routed operation for resource ${resourceId} to ${routes.length} nodes`);
      return routes;

    } catch (error) {
      console.error(`Failed to route operation for resource ${resourceId}:`, error);
      
      // Fallback to gossip if direct routing fails
      if (semantics.useGossipFallback) {
        return [{
          nodeId: '*', // Special marker for gossip broadcast
          resourcePlacement: 'replica',
          deliveryMethod: 'gossip',
          local: false // Gossip is always remote
        }];
      }

      return [];
    }
  }

  /**
   * Update routing strategy
   */
  updateStrategy(strategy: Partial<RoutingStrategy>): void {
    this.defaultStrategy = {
      ...this.defaultStrategy,
      ...strategy
    };
  }

  /**
   * Get current routing strategy
   */
  getStrategy(): RoutingStrategy {
    return { ...this.defaultStrategy };
  }
}