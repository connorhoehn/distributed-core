// Resource system exports
export { ResourceRegistry } from './ResourceRegistry';
export { ResourceDistributionEngine } from './ResourceDistributionEngine';
export { ResourceQueryEngine } from './ResourceQueryEngine';
export { ResourceSubscriptionManager } from './ResourceSubscriptionManager';
export { ResourceLifecycleEventSystem } from './ResourceLifecycleEventSystem';
export { ResourceMonitoringSystem } from './ResourceMonitoringSystem';
export { ResourceOptimizationEngine } from './ResourceOptimizationEngine';
export { ResourceManagementFactory, createFullResourceManagementSystem } from './ResourceManagementFactory';

// Glue Layer Components
export { ResourceAttachmentService } from './ResourceAttachmentService';
export { ClusterFanoutRouter } from './ClusterFanoutRouter';
export { DeliveryGuard } from './DeliveryGuard';

// Distributed Semantics Components
export { 
  DistributedSemanticsConfig,
  DistributedSemanticsFlags,
  globalSemanticsConfig
} from './DistributedSemanticsConfig';

export {
  OpType,
  VectorClock,
  ResourceOperation,
  CorrelationContext,
  OperationResult,
  createResourceOperation,
  generateCorrelationContext,
  generateUuidV7
} from './ResourceOperation';

export {
  OperationDeduplicator,
  DeduplicationEntry,
  DeduplicationConfig
} from './OperationDeduplicator';

export {
  CausalOrderingEngine,
  BufferedOperation,
  CausalOrderingConfig
} from './CausalOrderingEngine';

export {
  SubscriptionDeduplicator,
  Subscription,
  SubscriptionConfig,
  SubscriptionDelivery
} from './SubscriptionDeduplicator';

export {
  ResourceAuthorizationService,
  Permission,
  Principal,
  Role,
  AuthCondition,
  AuthContext,
  AuthResult,
  Policy,
  AuthorizationConfig
} from './ResourceAuthorizationService';

export {
  DistributedResourceManager,
  DistributedResourceConfig,
  ResourceChangeEvent
} from './DistributedResourceManager';

// Type exports
export * from './types';

// Re-export enhanced query and subscription types
export type { 
  ResourceQuery, 
  QueryResult, 
  PerformanceCriteria 
} from './ResourceQueryEngine';

export type { 
  SubscriptionFilter, 
  ResourceSubscription, 
  SubscriptionEvent 
} from './ResourceSubscriptionManager';

export type { 
  ResourceLifecycleEventType, 
  ResourceLifecycleEvent, 
  EventFilter 
} from './ResourceLifecycleEventSystem';

export type { 
  HealthCheck, 
  PerformanceMetrics, 
  ResourceAlert 
} from './ResourceMonitoringSystem';

export type { 
  OptimizationRecommendation, 
  OptimizationAction, 
  ClusterOptimizationStrategy 
} from './ResourceOptimizationEngine';
