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
export * from './cluster/observability/ObservabilityManager';
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
export type {
  ClusterDashboard,
  TopologyQuery,
  ClusterScalingAnalysis,
  ResourcePlacementRecommendation
} from './cluster/observability/ObservabilityManager';

// Generic Resource System
export * from './cluster/resources/ResourceRegistry';
export * from './cluster/resources/ResourceTypeRegistry';
export * from './cluster/resources/types';
export * from './cluster/topology/ResourceTopologyManager';

// Application Framework
export { ApplicationModule } from './applications/ApplicationModule';
export { ApplicationRegistry } from './applications/ApplicationRegistry';
export * from './applications/types';

// Transport modules
export * from './transport/Transport';
export { GossipMessage } from './gossip/transport/GossipMessage';
export * from './gossip/transport/GossipBackoff';
export * from './transport/MessageCache';
export * from './transport/Encryption';

// Metrics modules
export * from './monitoring/metrics/MetricsTracker';
export * from './monitoring/metrics/MetricsExporter';
export { MetricsRegistry } from './monitoring/metrics/MetricsRegistry';
export type { MetricLabels, MetricSample, HistogramSnapshot, RegistrySnapshot } from './monitoring/metrics/MetricsRegistry';

// Diagnostics modules
export * from './diagnostics/DiagnosticTool';
export * from './diagnostics/ChaosInjector';

// Persistence modules
export * from './persistence/StateStore';
export * from './persistence/WriteAheadLog';
export * from './persistence/BroadcastBuffer';
export { UnifiedPersistenceFactory, createPersistenceLayer } from './persistence/PersistenceFactory';
export type { PersistenceLayer, StateStoreConfig } from './persistence/PersistenceFactory';
export { WALWriterImpl, WALReaderImpl, WALFileImpl, WALCoordinatorImpl } from './persistence/wal';
export type { WALEntry, EntityUpdate, WALConfig, WALWriter, WALReader, WALFile, WALCoordinator } from './persistence/wal';
export { InMemorySnapshotVersionStore, WALSnapshotVersionStore } from './persistence/snapshot';
export type { SnapshotEntry, SnapshotType, StoreSnapshotOptions, ISnapshotVersionStore } from './persistence/snapshot';

// Identity modules
export * from './identity/NodeMetadata';
export * from './identity/KeyManager';

// Common modules
export * from './common/Node';
export * from './common/utils';
export { RateLimiter } from './common/RateLimiter';
export type { RateLimiterConfig, RateLimitResult } from './common/RateLimiter';

// Messaging modules
export * from './messaging';

// Connection modules
export * from './connections/Connection';
export * from './connections/ConnectionManager';
export * from './connections/ConnectionRegistry';
export * from './connections/Session';
export * from './connections/types';

// Routing — ResourceRouter, placement strategies, consistent hashing, cross-node sync
export {
  ResourceRouter,
  ResourceRouterFactory,
  ResourceRouterSyncAdapter,
  LocalPlacement,
  HashPlacement,
  LeastLoadedPlacement,
  RandomPlacement,
} from './routing';
export type {
  RouteTarget,
  ResourceHandle,
  ClaimOptions,
  ResourceRouterConfig,
  PlacementStrategy,
  ResourceRouterSyncAdapterConfig,
} from './routing';

// Distributed coordination — locks, leader election, sessions
export { DistributedLock, LeaderElection, ClusterLeaderElection } from './cluster/locks';
export type { LockHandle, DistributedLockConfig, LeaderElectionConfig, ClusterLeaderElectionConfig } from './cluster/locks';
export { DistributedSession } from './cluster/sessions';
export type { DistributedSessionConfig, SessionInfo } from './cluster/sessions';

// Gateway domain — PubSub, Presence, Channel, Queue, MessageRouter
export * from './gateway';
