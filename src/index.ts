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
export { Cluster } from './cluster/Cluster';
export type {
  ClusterConfig,
  TransportConfig,
  RegistryConfig,
  ClusterFailureDetectionConfig,
  ClusterAutoReclaimConfig,
  ClusterLocksConfig,
  Logger,
} from './cluster/Cluster';
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

// Pipeline application module
export * from './applications/pipeline';

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
export type { LifecycleAware } from './common/LifecycleAware';
export { CoreError, NotStartedError, AlreadyStartedError, ConflictError, TimeoutError as CoreTimeoutError, EntityNotFoundError, EntityAlreadyExistsError, MetricConflictError, NotOwnedByNodeError } from './common/errors';

// Messaging modules
export * from './messaging';

// Connection modules
export * from './connections/Connection';
export * from './connections/ConnectionManager';
export * from './connections/ConnectionRegistry';
export * from './connections/Session';
export * from './connections/types';

// Routing — ResourceRouter, placement strategies, consistent hashing, cross-node sync, forwarding, auto-reclaim
export {
  ResourceRouter,
  ResourceRouterFactory,
  ResourceRouterSyncAdapter,
  AutoReclaimPolicy,
  LocalPlacement,
  HashPlacement,
  LeastLoadedPlacement,
  RandomPlacement,
  ForwardingRouter,
  LocalResourceError,
  UnroutableResourceError,
  HttpForwardingTransport,
  MisdirectedError,
  TimeoutError,
  ForwardingServer,
  HttpsForwardingTransport,
  HttpsForwardingServer,
} from './routing';
export type {
  RouteTarget,
  ResourceHandle,
  ClaimOptions,
  ResourceRouterConfig,
  PlacementStrategy,
  ResourceRouterSyncAdapterConfig,
  AutoReclaimPolicyConfig,
  ForwardingTransport,
  ForwardingRouterConfig,
  HttpForwardingTransportConfig,
  ForwardingServerConfig,
  ForwardingHandler,
  HttpsForwardingTransportConfig,
  HttpsForwardingServerConfig,
} from './routing';
export { RebalancePolicy } from './routing/RebalancePolicy';
export type { RebalancePolicyConfig, RebalanceTrigger } from './routing/RebalancePolicy';

// Entity registries — cross-node sync adapter + bootstrap
export { EntityRegistrySyncAdapter } from './cluster/entity/EntityRegistrySyncAdapter';
export type { EntityRegistrySyncAdapterConfig } from './cluster/entity/EntityRegistrySyncAdapter';
export { EntityRegistryBootstrapper } from './cluster/entity/EntityRegistryBootstrapper';
export type { EntityRegistryBootstrapperConfig, BootstrapResult } from './cluster/entity/EntityRegistryBootstrapper';

// Distributed coordination — locks, leader election, sessions, quorum, failure
export { DistributedLock, LeaderElection, ClusterLeaderElection, QuorumDistributedLock } from './cluster/locks';
export type { LockHandle, DistributedLockConfig, LeaderElectionConfig, ClusterLeaderElectionConfig, QuorumDistributedLockConfig } from './cluster/locks';
export { DistributedSession } from './cluster/sessions';
export type { DistributedSessionConfig, SessionInfo } from './cluster/sessions';
export { FailureDetectorBridge, PubSubHeartbeatSource } from './cluster/failure';
export type { FailureDetectorBridgeTargets, FailureDetectorBridgeConfig, PubSubHeartbeatSourceConfig, HeartbeatPayload } from './cluster/failure';

// Persistence atomicity helpers
export { atomicWriteFile, fsyncFile } from './persistence/atomicWrite';

// Distributed configuration and service discovery
export { ConfigManager, ConfigValidationError, UnknownConfigKeyError } from './cluster/config';
export type { ConfigValidator, ConfigKeyDefinition, ConfigChangeEvent, ConfigManagerConfig } from './cluster/config';
export { ServiceRegistry, UnknownServiceError } from './cluster/discovery';
export type { ServiceEndpoint, SelectionStrategy, ServiceRegistryConfig } from './cluster/discovery';

// Gateway domain — PubSub, Presence, Channel, Queue, MessageRouter
export * from './gateway';
