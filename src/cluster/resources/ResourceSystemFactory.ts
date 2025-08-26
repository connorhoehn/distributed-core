/**
 * Factory for creating configured resource management components with distributed semantics
 * Phase 0 - Baseline infrastructure with feature flags
 */

import { ResourceRegistry, ResourceRegistryConfig } from './ResourceRegistry';
import { ResourceDistributionEngine } from './ResourceDistributionEngine';
import { DistributedSemanticsConfig } from './DistributedSemanticsConfig';
import { ClusterManager } from '../ClusterManager';
import { EntityRegistryType } from '../entity/EntityRegistryFactory';

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
      
      // Convenience methods for phase rollout
      enablePhase1() {
        semanticsConfig.enablePhase1();
        console.log('✅ Phase 1 enabled: Operation envelope + correlation tracing');
      },
      
      enablePhase2() {
        semanticsConfig.enablePhase2();
        console.log('✅ Phase 2 enabled: Idempotent operations');
      },
      
      enablePhase3() {
        semanticsConfig.enablePhase3();
        console.log('✅ Phase 3 enabled: Causal ordering');
      },
      
      enablePhase4() {
        semanticsConfig.enablePhase4();
        console.log('✅ Phase 4 enabled: Subscriber exactly-once delivery');
      },
      
      enablePhase5() {
        semanticsConfig.enablePhase5();
        console.log('✅ Phase 5 enabled: Backpressure and flow control');
      },
      
      enablePhase6() {
        semanticsConfig.enablePhase6();
        console.log('✅ Phase 6 enabled: Resource-level authorization');
      },
      
      getFlags() {
        return semanticsConfig.getFlags();
      }
    };
  }
  
  /**
   * Create a development instance with specific phase enabled
   */
  static createForPhase(nodeId: string, phase: number, clusterManager?: ClusterManager) {
    const semanticsConfig = new DistributedSemanticsConfig();
    
    // Enable up to the specified phase
    switch (phase) {
      case 6:
        semanticsConfig.enablePhase6();
        break;
      case 5:
        semanticsConfig.enablePhase5();
        break;
      case 4:
        semanticsConfig.enablePhase4();
        break;
      case 3:
        semanticsConfig.enablePhase3();
        break;
      case 2:
        semanticsConfig.enablePhase2();
        break;
      case 1:
        semanticsConfig.enablePhase1();
        break;
      default:
        // Phase 0 - all flags disabled
        break;
    }
    
    return this.create({
      nodeId,
      clusterManager,
      semanticsConfig
    });
  }
}

// Export for convenience
export { DistributedSemanticsConfig } from './DistributedSemanticsConfig';
