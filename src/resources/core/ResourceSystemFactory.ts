/**
 * Factory for creating configured resource management components with distributed semantics
 * Phase 0 - Baseline infrastructure with feature flags
 */

import { ResourceRegistry, ResourceRegistryConfig } from './ResourceRegistry';
import { ResourceDistributionEngine } from '../distribution/ResourceDistributionEngine';
import { DistributedSemanticsConfig } from '../../communication/semantics/DistributedSemanticsConfig';
import { ClusterManager } from '../../cluster/ClusterManager';
import { EntityRegistryType } from '../../cluster/core/entity/EntityRegistryFactory';

export interface ResourceSystemConfig {
  nodeId: string;
  entityRegistryType?: EntityRegistryType;
  semanticsConfig?: DistributedSemanticsConfig;
  clusterManager?: ClusterManager;
}

export class ResourceSystemFactory {
  /**
   * Create a fully configured resource system with distributed semantics
   */
  static create(config: ResourceSystemConfig) {
    const semanticsConfig = config.semanticsConfig || new DistributedSemanticsConfig();
    
    // Create ResourceRegistry with semantics config
    const resourceRegistryConfig: ResourceRegistryConfig = {
      nodeId: config.nodeId,
      entityRegistryType: config.entityRegistryType || 'memory',
      clusterManager: config.clusterManager,
      semanticsConfig
    };
    
    const resourceRegistry = new ResourceRegistry(resourceRegistryConfig);
    
    // Create ResourceDistributionEngine with semantics config
    let distributionEngine: ResourceDistributionEngine | undefined;
    if (config.clusterManager) {
      distributionEngine = new ResourceDistributionEngine(
        resourceRegistry,
        config.clusterManager,
        undefined, // use default StateReconciler
        semanticsConfig
      );
    }
    
    return {
      resourceRegistry,
      distributionEngine,
      semanticsConfig,
    };
  }
}

// Export for convenience
export { DistributedSemanticsConfig } from '../../communication/semantics/DistributedSemanticsConfig';
