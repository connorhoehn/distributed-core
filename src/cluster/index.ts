import { StateFingerprintGenerator } from './delta-sync/StateFingerprint';

// Main cluster manager
export { ClusterManager } from './ClusterManager';

// Cluster interfaces (for consumers that don't need the full ClusterManager)
export { IClusterEventBus, IClusterInfo, IClusterNode } from './ClusterEventBus';

// Core
export * from './core/IClusterManagerContext';
export * from './core/lifecycle/ClusterLifecycle';

// Membership
export * from './membership/MembershipTable';

// Quorum
export * from './quorum';

// Topology
export * from './topology/ClusterTopologyManager';
export * from './topology/ResourceLeaseManager';
export * from './topology/ResourceTopologyManager';

// Introspection
export * from './introspection/ClusterIntrospection';

// Reconciliation
export * from './reconciliation/AntiEntropyRepair';
export * from './reconciliation/StateReconciler';

// Delta sync
export * from './delta-sync/DeltaSync';
export * from './delta-sync/StateDelta';

// Entity management
export * from './core/entity/EntityRegistryFactory';
export * from './core/entity/InMemoryEntityRegistry';
export * from './core/entity/WriteAheadLogEntityRegistry';

// Operations
export * from './core/operations/DistributedOperationsFlags';
export * from './core/operations/OperationEnvelopeManager';
export * from './core/operations/DistributedOperationsSpec';

// Seeding
export * from './core/seeding/SeedNodeRegistry';

// Aggregation (selective export to avoid PartitionInfo collision with ./types)
export { StateAggregator, type AggregatedClusterState, type StateAggregatorConfig } from './aggregation/StateAggregator';

// Cluster types (canonical definitions)
export * from './types';

// Common types (NodeId, Message, MessageType, etc.) are exported from
// src/types.ts via the main index — no need to re-export here.
