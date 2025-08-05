// Main entry point for distributed-core library

// Types
export * from './types';

// Cluster Framework (New Range-based Coordination)
export { 
  createClusterNode, 
  createRangeHandler,
  RangeCoordinator,
  type ClusterNodeConfig,
  type RangeHandler as FrameworkRangeHandler,
  type ClusterMessage as FrameworkClusterMessage,
  type ClusterInfo,
  type RangeId,
  type RingId,
  type CoordinatorType,
  type TransportType
} from './coordinators';

// Cluster modules
export * from './cluster/ClusterManager';
export * from './cluster/membership/MembershipTable';
export * from './gossip/GossipStrategy';
export * from './monitoring/FailureDetector';
export * from './config/BootstrapConfig';

// Enhanced Observability 
export * from './cluster/introspection/ClusterIntrospection';
export * from './cluster/aggregation/StateAggregator';
export type { 
  PerformanceMetrics, 
  LogicalService, 
  ClusterState
} from './cluster/introspection/ClusterIntrospection';
export type {
  AggregatedClusterState,
  PartitionInfo,
  StateAggregatorConfig
} from './cluster/aggregation/StateAggregator';

// Transport modules
export * from './transport/Transport';
export { GossipMessage } from './gossip/transport/GossipMessage';
export * from './gossip/transport/GossipBackoff';
export * from './transport/MessageCache';
export * from './transport/Encryption';

// Metrics modules
export * from './monitoring/metrics/MetricsTracker';
export * from './monitoring/metrics/MetricsExporter';

// Diagnostics modules
export * from './diagnostics/DiagnosticTool';
export * from './diagnostics/ChaosInjector';

// Persistence modules
export * from './persistence/StateStore';
export * from './persistence/WriteAheadLog';
export * from './persistence/BroadcastBuffer';

// Identity modules
export * from './identity/NodeMetadata';
export * from './identity/KeyManager';

// Common modules
export * from './common/Node';
export * from './common/utils';

// Messaging modules
export * from './messaging';

// Connection modules
export * from './connections/Connection';
export * from './connections/ConnectionManager';
export * from './connections/Session';
export * from './connections/types';
