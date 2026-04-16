import { ResourceOperation } from '../core/ResourceOperation';
import { ClusterRouting } from '../../routing/ClusterRouting';
import { ClusterManager } from '../../cluster/ClusterManager';


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

  /**
   * Sends a ResourceOperation to a specific node.
   * Implement actual network delivery logic here.
   */
  public async sendToNode(nodeId: string, operation: ResourceOperation): Promise<void> {
    // TODO: Replace with actual network delivery logic
    console.log(`Sending operation to node ${nodeId}:`, operation);
    // Simulate async delivery
    return Promise.resolve();
  }

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

  async fanoutRemote(routes: NodeRoute[], operation: ResourceOperation): Promise<void> {
    // Iterate routes and send operation to remote nodes using sendToNode
    for (const route of routes) {
      if (!route.local) {
        await this.sendToNode(route.nodeId, operation);
      }
    }
    // Optionally, return a result or throw on failure
  }


  /**
   * Fanout operation to all nodes determined by routing strategy.
   * This method combines routing and remote fanout.
   */
  async fanout(resourceId: string, operation: ResourceOperation, semantics?: Partial<RoutingStrategy>): Promise<void> {
    const strategy = { ...this.defaultStrategy, ...semantics };
    const routes = await this.route(resourceId, strategy);
    await this.fanoutRemote(routes, operation);
  }
}