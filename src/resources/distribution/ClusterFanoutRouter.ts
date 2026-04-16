import { ResourceOperation } from '../core/ResourceOperation';
import { IClusterNode } from '../../cluster/ClusterEventBus';
import { DeliveryTracker, DeliveryReceipt } from './DeliveryTracker';


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
  private clusterNode: IClusterNode;
  private defaultStrategy: RoutingStrategy;
  public readonly deliveryTracker: DeliveryTracker;

  constructor(
    clusterNode: IClusterNode,
    strategy: Partial<RoutingStrategy> = {},
    deliveryTracker?: DeliveryTracker
  ) {
    this.clusterNode = clusterNode;
    this.defaultStrategy = {
      preferPrimary: true,
      replicationFactor: 3,
      useGossipFallback: true,
      ...strategy
    };
    this.deliveryTracker = deliveryTracker ?? new DeliveryTracker();
  }

  /**
   * Sends a ResourceOperation to a specific remote node via cluster messaging.
   */
  public async sendToNode(nodeId: string, operation: ResourceOperation): Promise<void> {
    await this.clusterNode.sendCustomMessage('resource-operation', {
      opId: operation.opId,
      resourceId: operation.resourceId,
      type: operation.type,
      payload: operation.payload,
      version: operation.version,
      timestamp: operation.timestamp,
      originNodeId: operation.originNodeId,
      correlationId: operation.correlationId
    }, [nodeId]);
  }

  /**
   * Pure routing function - determines target nodes without side effects
   * Phase D: Only uses clusterManager.getRouting() and semantics.routing
   */
  async route(resourceId: string, semantics: RoutingStrategy): Promise<NodeRoute[]> {
    const routes: NodeRoute[] = [];
    const localNodeId = this.clusterNode.localNodeId;

    try {
      // Get primary node for resource
      const primaryNode = this.clusterNode.getNodeForKey(resourceId);
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
        const replicaNodes = this.clusterNode.getReplicaNodes(
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

  async fanoutRemote(routes: NodeRoute[], operation: ResourceOperation): Promise<DeliveryReceipt[] | null> {
    const remoteRoutes = routes.filter(r => !r.local);

    // Send the operation to each remote node
    for (const route of remoteRoutes) {
      await this.sendToNode(route.nodeId, operation);
    }

    // Track delivery if there are remote targets
    if (remoteRoutes.length > 0) {
      const targetNodeIds = remoteRoutes.map(r => r.nodeId);
      // Fire-and-forget tracking -- callers can await the returned promise
      // but the fanout itself does not block on ACKs
      return this.deliveryTracker.trackDelivery(operation.opId, targetNodeIds);
    }

    return null;
  }


  /**
   * Fanout operation to all nodes determined by routing strategy.
   * Local routes are returned so the caller can apply them directly;
   * remote routes are sent via sendToNode().
   * Returns the local NodeRoute entries (if any) for the caller to handle.
   */
  async fanout(resourceId: string, operation: ResourceOperation, semantics?: Partial<RoutingStrategy>): Promise<NodeRoute[]> {
    const strategy = { ...this.defaultStrategy, ...semantics };
    const routes = await this.route(resourceId, strategy);

    const localRoutes: NodeRoute[] = [];

    for (const route of routes) {
      if (route.local) {
        localRoutes.push(route);
      } else {
        await this.sendToNode(route.nodeId, operation);
      }
    }

    // Track remote delivery
    const remoteRoutes = routes.filter(r => !r.local);
    if (remoteRoutes.length > 0) {
      const targetNodeIds = remoteRoutes.map(r => r.nodeId);
      this.deliveryTracker.trackDelivery(operation.opId, targetNodeIds);
    }

    return localRoutes;
  }
}