# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `ModernDistributedNodeFactory` — alternative factory with improved ergonomics
- `SimpleDistributedNodeFactory` — minimal factory for quick cluster setup
- `TransportFactory` — standalone factory for creating transport instances

### Changed
- Refactored `DistributedNodeFactory` internals

## [phases-6-9-complete] - Logging, Type Safety, Compaction, Lifecycle

### Added
- Structured `Logger` class with `LogLevel` enum and context-prefixed output
- `LeveledCompactionStrategy` — LSM-tree style level merging
- `SizeTieredCompactionStrategy` — bucket-based merging
- `VacuumBasedCompactionStrategy` — dead tuple and fragmentation cleanup
- `WALMetricsProvider` — reads real WAL/checkpoint state from disk
- `ResourceManager.getResourceRegistry()` public accessor
- `isNodeError()` type guard for WAL error handling

### Changed
- Replaced all 362 `console.log/warn/error` calls with structured Logger
- Eliminated all 36 `as any` casts across source code
- Cluster lifecycle now properly rebuilds hash ring, joins cluster, starts gossip, runs anti-entropy, and migrates workloads on drain
- `StateAggregator` uses real membership lookups instead of hardcoded `localhost:8080`

### Fixed
- `IClusterManagerContext` interface now includes `communication`, `hashRing`, `migrateWorkloads`
- `CompactionStrategyType` inconsistency (`vacuum` renamed to `vacuum-based`)
- Node nullable fields (`MetricsTracker`, `ChaosInjector`) properly typed

### Removed
- Duplicate `StateAggregator` in reconciliation directory
- All `console.log` statements from library source

## [phase-5-complete] - Front Door, Examples, Documentation

### Added
- `examples/basic-cluster/` — 3-node cluster formation and message passing
- `examples/distributed-counter/` — shared resource across nodes
- `examples/chat-room/` — chat application example
- JSDoc documentation on public API (`Node`, `ClusterManager`, `ResourceRegistry`, `Transport`, `DistributedNodeFactory`)
- Rewritten README with quick start and architecture overview

### Fixed
- `ResourceDistributionEngine` feedback loop (create -> distribute -> apply -> infinite) via `isApplyingRemoteOperation` guard

### Removed
- `ChatRoomCoordinator` moved out of `src/` into examples (business logic removed from core)

## [phase-4-complete] - Resource System

### Added
- `DeliveryTracker` with ACK/NACK/timeout protocol for operation delivery
- `ResourceRegistry.createResourceOnNode()` with confirmation and 5s timeout (was fire-and-forget)
- Cross-cluster subscription notifications via `remote-resource-operation` events
- `connectDistributionEngine()` for late-binding resource wiring
- Resource WAL persistence — CREATE/UPDATE/DELETE automatically written to WAL
- `recoverFromWAL()` to replay entries and restore resource state on restart

### Changed
- `ClusterFanoutRouter.sendToNode()` now performs actual network delivery (was a `console.log` stub)
- `ClusterFanoutRouter` uses `IClusterNode` interface instead of `ClusterManager`

### Fixed
- Outbound causal clock increment (was missing, causing stale vectors)

## [phase-3-complete] - Architecture Cleanup

### Changed
- All cluster code uses `IResourceRegistry`, `IResourceTypeRegistry`, `IResourceDistributionEngine` interfaces instead of concrete classes
- `ResourceRegistry` stripped of 18 delegating methods — now focused on CRUD only
- `ClusterCoordinator` renamed to `ClusterFacade`
- `CompactionCoordinator` renamed to `CompactionScheduler`
- `IClusterEventBus` and `IClusterInfo` interfaces introduced for resource layer decoupling
- ESLint layering rules enforce architectural boundaries

### Removed
- Circular dependencies between Cluster and Resources layers
- 8 unused interfaces from `src/types.ts`
- Dead exports from `messaging/types.ts` and coordinator barrel

## [phase-2-complete] - Transport and Persistence Hardening

### Added
- `EncryptedTransport` wrapper — transparent encrypt/decrypt on any transport
- `MessageBatcher.wrapTransport()` — optional batching middleware for any transport
- WAL segment rotation (auto-rotate when `maxFileSize` exceeded)
- `WALReader` reads across multiple segments transparently
- `AutoCheckpointer` — triggers checkpoint on LSN threshold or time interval
- `RecoveryManager` — checkpoint read + WAL replay in one composable class

### Changed
- `HTTPAdapter` supports multiple message handlers (was single handler)
- `CompactionCoordinator` accepts `CompactionMetricsProvider` interface (backward compatible via `StubMetricsProvider`)

### Removed
- `GRPCAdapter` stub and `@grpc/grpc-js` dependency (no proto definitions existed)

## [phase-1-complete] - Foundation Integrity

### Added
- Live message routing: `transport.onMessage()` wired to `Node.routeMessage()`
- `sendCustomMessage()` resolves real addresses from membership table
- Barrel files for `factories/` and `services/`
- `.eslintrc.js`, `LICENSE`, CI workflow with build/typecheck/lint jobs

### Changed
- Consolidated `NodeInfo` (was 2 definitions) and `ClusterMessage` (was 2 conflicting shapes)
- Cluster-level `ClusterMessage` union renamed to `GossipProtocolMessage`

### Removed
- `SubscriptionDeduplicator`, `DeliveryGuard`, standalone `ResourcePublisher`/`ResourceSubscriber`
- 25 `declare const any` statements across 20 files
- Dead `communication/types.ts` interfaces
- 33,000+ lines of dead code, unused files, and broken compilation paths (pre-phase cleanup)
