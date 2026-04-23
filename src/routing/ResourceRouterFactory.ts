import { ClusterManager } from '../cluster/ClusterManager';
import { EntityRegistryFactory } from '../cluster/entity/EntityRegistryFactory';
import { WALConfig } from '../persistence/wal/types';
import { LeastLoadedPlacement } from './PlacementStrategy';
import { ResourceRouter } from './ResourceRouter';
import { ResourceRouterConfig } from './types';

export class ResourceRouterFactory {
  /**
   * In-memory registry — no persistence, suitable for testing or ephemeral
   * resources that don't need to survive restarts.
   */
  static createInMemory(
    nodeId: string,
    cluster: ClusterManager,
    config?: ResourceRouterConfig
  ): ResourceRouter {
    const registry = EntityRegistryFactory.createMemory(nodeId, { enableTestMode: false });
    return new ResourceRouter(nodeId, registry, cluster, config);
  }

  /**
   * WAL-backed registry — ownership survives node restarts.
   * Use for rooms, pipelines, or any resource whose assignment must
   * persist across process restarts.
   */
  static createWAL(
    nodeId: string,
    cluster: ClusterManager,
    walConfig?: WALConfig,
    config?: ResourceRouterConfig
  ): ResourceRouter {
    const registry = EntityRegistryFactory.createWAL(nodeId, walConfig);
    return new ResourceRouter(nodeId, registry, cluster, config);
  }

  /**
   * CRDT registry — last-write-wins merge semantics.
   * Use for scenarios where multiple nodes may concurrently claim resources
   * and you need conflict-free convergence rather than strict exclusivity.
   */
  static createCRDT(
    nodeId: string,
    cluster: ClusterManager,
    config?: ResourceRouterConfig
  ): ResourceRouter {
    const registry = EntityRegistryFactory.create({ type: 'crdt', nodeId });
    return new ResourceRouter(nodeId, registry, cluster, config);
  }

  /**
   * Convenience: in-memory registry with LeastLoaded placement pre-wired.
   * Common starting point for work-distribution scenarios (rooms, pipelines).
   */
  static createLeastLoaded(
    nodeId: string,
    cluster: ClusterManager
  ): ResourceRouter {
    const registry = EntityRegistryFactory.createMemory(nodeId, { enableTestMode: false });
    // Use a late-binding closure so the placement references the final router instance.
    let router: ResourceRouter;
    const placement = new LeastLoadedPlacement(() => router.getAllResources());
    router = new ResourceRouter(nodeId, registry, cluster, { placement });
    return router;
  }
}
