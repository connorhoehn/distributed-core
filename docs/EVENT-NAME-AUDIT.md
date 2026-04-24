# Event Name Audit

Catalog of every event emitted by distributed-core primitives, with conformance
assessment against the target convention.

---

## Convention (proposed)

**Target shape:** `noun:verb` — colon-separated, all lowercase, single word on
each side where possible, hyphens allowed *within* a side for multi-word nouns
or verbs (e.g., `health-check:completed`).

### Rationale

The majority of newer primitives already follow this pattern:
- `resource:claimed`, `resource:released`, `resource:orphaned` (ResourceRouter)
- `entity:created`, `entity:updated`, `entity:deleted`, `entity:transferred`
- `cleanup:triggered`, `cleanup:error` (FailureDetectorBridge)
- `compact:completed`, `compact:error` (EventBus)
- `lock:acquired`, `lock:released`, `lock:denied` (QuorumDistributedLock)
- `session:created`, `session:evicted`, `session:orphaned` (DistributedSession)
- `connection:registered`, `connection:expired`, `connection:reconnected` (ConnectionRegistry)
- `topology:started`, `topology:stopped`, `topology:updated`, `topology:node-joined` (ResourceTopologyManager)

Three other patterns appear and are **non-conforming**:

| Pattern | Example | Problem |
|---------|---------|---------|
| bare word | `started`, `stopped`, `error`, `change` | No noun context; ambiguous when re-emitted |
| hyphen-only | `member-joined`, `member-left`, `leader-changed` | Pre-dates colon convention; widely subscribed |
| dot-separated | `pipeline.run.started`, `pipeline.llm.token` | Wrong separator; inconsistent with rest of codebase |
| camelCase | `sessionStarted`, `deltaTransmitted` | Not lowercase; JavaScript style mismatch |

**Verb tense guidance:**

- Completed/past state → past participle: `resource:claimed`, `session:created`
- In-progress → present participle: `module:initializing`, `module:stopping`
- Error outcomes → noun `error` as verb side: `cleanup:error`, `compact:error`

---

## Inventory

> **Key:** ✓ = conforms to `noun:verb` convention · ✗ = does not conform

### ApplicationModule (`src/applications/ApplicationModule.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `module:initializing` | `moduleId: string` | ✓ | — |
| `module:initialized` | `moduleId: string` | ✓ | — |
| `module:started` | `moduleId: string` | ✓ | — |
| `module:stopping` | `moduleId: string` | ✓ | — |
| `module:stopped` | `moduleId: string` | ✓ | — |
| `module:error` | `{ moduleId, error }` | ✓ | — |
| `module:configuration-updated` | `{ moduleId, config }` | ✓ | — |

### ApplicationRegistry (`src/applications/ApplicationRegistry.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `registry:started` | — | ✓ | — |
| `registry:stopped` | — | ✓ | — |
| `registry:module-registered` | `{ moduleId, config }` | ✓ | — |
| `registry:module-unregistered` | `{ moduleId }` | ✓ | — |
| `registry:module-error` | `{ moduleId, error }` | ✓ | — |
| `registry:module-stop-error` | `{ moduleId, error }` | ✓ | — |
| `registry:configuration-updated` | `newConfig` | ✓ | — |
| `registry:configuration-update-error` | `{ moduleId, error }` | ✓ | — |

### PipelineExecutor (`src/applications/pipeline/PipelineExecutor.ts`)

> **RENAMED** — All 22 pipeline events have been renamed from dot-separated to
> colon-separated form. A dual-emit deprecation bridge is active: the executor
> publishes both the canonical colon form and the deprecated dot form on every
> emit. The `PipelineEventMap` type in `src/applications/pipeline/types.ts`
> exposes both key sets with `@deprecated` JSDoc on the old names.
> Old dot-form names will be removed in a future release.
> See `test/unit/applications/pipeline/EventRenameDeprecation.test.ts`.

| Old name | New canonical name | Status |
|---|---|---|
| `pipeline.run.started` | `pipeline:run:started` | ✓ renamed, deprecated alias active |
| `pipeline.run.completed` | `pipeline:run:completed` | ✓ renamed, deprecated alias active |
| `pipeline.run.failed` | `pipeline:run:failed` | ✓ renamed, deprecated alias active |
| `pipeline.run.cancelled` | `pipeline:run:cancelled` | ✓ renamed, deprecated alias active |
| `pipeline.run.orphaned` | `pipeline:run:orphaned` | ✓ renamed, deprecated alias active |
| `pipeline.run.reassigned` | `pipeline:run:reassigned` | ✓ renamed, deprecated alias active |
| `pipeline.step.started` | `pipeline:step:started` | ✓ renamed, deprecated alias active |
| `pipeline.step.completed` | `pipeline:step:completed` | ✓ renamed, deprecated alias active |
| `pipeline.step.failed` | `pipeline:step:failed` | ✓ renamed, deprecated alias active |
| `pipeline.step.skipped` | `pipeline:step:skipped` | ✓ renamed, deprecated alias active |
| `pipeline.step.cancelled` | `pipeline:step:cancelled` | ✓ renamed, deprecated alias active |
| `pipeline.llm.prompt` | `pipeline:llm:prompt` | ✓ renamed, deprecated alias active |
| `pipeline.llm.token` | `pipeline:llm:token` | ✓ renamed, deprecated alias active |
| `pipeline.llm.response` | `pipeline:llm:response` | ✓ renamed, deprecated alias active |
| `pipeline.approval.requested` | `pipeline:approval:requested` | ✓ renamed, deprecated alias active |
| `pipeline.approval.recorded` | `pipeline:approval:recorded` | ✓ renamed, deprecated alias active |
| `pipeline.run.paused` | `pipeline:run:paused` | ✓ renamed, deprecated alias active |
| `pipeline.run.resumed` | `pipeline:run:resumed` | ✓ renamed, deprecated alias active |
| `pipeline.run.resumeFromStep` | `pipeline:run:resume-from-step` | ✓ renamed, deprecated alias active |
| `pipeline.run.retry` | `pipeline:run:retry` | ✓ renamed, deprecated alias active |
| `pipeline.join.waiting` | `pipeline:join:waiting` | ✓ renamed, deprecated alias active |
| `pipeline.join.fired` | `pipeline:join:fired` | ✓ renamed, deprecated alias active |

### ClusterManager (`src/cluster/ClusterManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `member-joined` | `NodeInfo` | ✗ | `member:joined` ✓ Renamed (dual-emit active) |
| `member-left` | `nodeId: string` | ✗ | `member:left` ✓ Renamed (dual-emit active) |
| `member-updated` | `NodeInfo` | ✗ | `member:updated` ✓ Renamed (dual-emit active) |
| `membership-updated` | `Map<string, MembershipEntry>` | ✗ | `membership:updated` ✓ Renamed (dual-emit active) |
| `started` | — | ✗ | `lifecycle:started` ✓ Renamed (dual-emit active) |
| `stopped` | — | ✗ | `lifecycle:stopped` ✓ Renamed (dual-emit active) |

### StateAggregator (`src/cluster/aggregation/StateAggregator.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `started` | — | ✗ | `aggregator:started` |
| `stopped` | — | ✗ | `aggregator:stopped` |
| `state-aggregated` | `aggregatedState` | ✗ | `state:aggregated` |
| `aggregation-error` | `error` | ✗ | `aggregation:error` |
| `node-collection-failed` | `{ nodeId, error }` | ✗ | `node-collection:failed` |
| `conflicts-detected` | `conflicts[]` | ✗ | `conflicts:detected` |
| `auto-resolution-failed` | `{ conflicts, error }` | ✗ | `auto-resolution:failed` |
| `conflict-detection-error` | `error` | ✗ | `conflict-detection:error` |
| `conflicts-resolved` | `results[]` | ✗ | `conflicts:resolved` |
| `resolution-error` | `{ conflicts, error }` | ✗ | `resolution:error` |
| `manual-resolution` | `result` | ✗ | `resolution:manual` |
| `manual-resolution-failed` | `{ conflict, strategy, error }` | ✗ | `manual-resolution:failed` |

### ConfigManager (`src/cluster/config/ConfigManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `change` | `event` | ✗ | `config:changed` |

### ClusterCommunication (`src/cluster/core/communication/ClusterCommunication.ts` and `src/messaging/cluster/ClusterCommunication.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `gossip-received` | `{ from, message }` | ✗ | `gossip:received` |
| `gossip-sent` | `{ to, message }` | ✗ | `gossip:sent` |
| `join-requested` | `{ nodeId, isResponse }` | ✗ | `join:requested` |
| `join-completed` | `{ nodeId, … }` | ✗ | `join:completed` |
| `anti-entropy-triggered` | `{ nodeId, … }` | ✗ | `anti-entropy:triggered` |
| `communication-error` | `{ nodeId, error, … }` | ✗ | `communication:error` |

### ClusterLifecycle (`src/cluster/core/lifecycle/ClusterLifecycle.ts` and `src/cluster/lifecycle/ClusterLifecycle.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `started` | `{ nodeId, timestamp }` | ✗ | `lifecycle:started` ✓ Renamed (dual-emit active) |
| `stopped` | `{ nodeId, timestamp }` | ✗ | `lifecycle:stopped` ✓ Renamed (dual-emit active) |
| `left` | `{ nodeId, timestamp }` | ✗ | `cluster:left` |
| `drained` | `{ nodeId, timestamp }` | ✗ | `cluster:drained` |
| `rebalanced` | `{ … }` | ✗ | `cluster:rebalanced` |
| `error` | `{ error, operation }` | ✗ | `lifecycle:error` — intentionally NOT dual-emitted; Node.js `error` semantics preserved |

### DeltaSyncEngine (`src/cluster/delta-sync/DeltaSync.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `sessionStarted` | `session` | ✗ | `session:started` |
| `sessionComplete` | `session` | ✗ | `session:completed` |
| `sessionError` | `session, error` | ✗ | `session:error` |
| `sessionCleaned` | `sessionId` | ✗ | `session:cleaned` |
| `deltaTransmitted` | `session, delta, stats` | ✗ | `delta:transmitted` |
| `deltaTransmissionError` | `session, delta, error` | ✗ | `delta:transmission-error` |

### ServiceRegistry (`src/cluster/discovery/ServiceRegistry.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `service:registered` | `endpoint` | ✓ | — |
| `service:unregistered` | `entityId, serviceName` | ✓ | — |
| `service:healthcheck-error` | `endpointId, serviceName, err` | ✓ | — |
| `service:unhealthy` | `endpointId, serviceName` | ✓ | — |
| `service:healthy` | `endpointId, serviceName` | ✓ | — |

### Entity Registries (`InMemoryEntityRegistry`, `WriteAheadLogEntityRegistry`, `CrdtEntityRegistry`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `entity:created` | `record` | ✓ | — |
| `entity:updated` | `entity` | ✓ | — |
| `entity:deleted` | `entity` | ✓ | — |
| `entity:transferred` | `entity` | ✓ | — |
| `checkpoint:created` | `{ lsn, entityCount }` | ✓ | — |

### FailureDetectorBridge (`src/cluster/failure/FailureDetectorBridge.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `cleanup:triggered` | `nodeId, { orphanedResources, expiredConnections, releasedLocks }` | ✓ | — |
| `cleanup:error` | `nodeId, Error` | ✓ | — |

### ClusterIntrospection (`src/cluster/introspection/ClusterIntrospection.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `metrics-updated` | `metrics` | ✗ | `metrics:updated` |
| `state-changed` | `currentState` | ✗ | `state:changed` |
| `topology-changed` | `topology` | ✗ | `topology:changed` |
| `health-changed` | `clusterHealth` | ✗ | `health:changed` |
| `service-registered` | `enhancedService` | ✗ | `service:registered` |
| `service-unregistered` | `service` | ✗ | `service:unregistered` |
| `service-updated` | `service` | ✗ | `service:updated` |

### LeaderElection / ClusterLeaderElection

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `elected` | — | ✗ | `leader:elected` |
| `deposed` | — | ✗ | `leader:deposed` |
| `leader-changed` | `nodeId \| null` | ✗ | `leader:changed` |

### QuorumDistributedLock (`src/cluster/locks/QuorumDistributedLock.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `lock:acquired` | `handle` | ✓ | — |
| `lock:released` | `lockId` | ✓ | — |
| `lock:denied` | `lockId, nodeId, reason` | ✓ | — |

### MembershipTable (`src/cluster/membership/MembershipTable.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `member-joined` | `NodeInfo` | ✗ | `member:joined` ✓ Renamed (dual-emit active) |
| `member-left` | `nodeId` | ✗ | `member:left` ✓ Renamed (dual-emit active) |
| `member-updated` | `NodeInfo` | ✗ | `member:updated` ✓ Renamed (dual-emit active) |
| `membership-updated` | `Map<string, MembershipEntry>` | ✗ | `membership:updated` ✓ Renamed (dual-emit active) |

### ObservabilityManager (`src/cluster/observability/ObservabilityManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `started` | — | ✗ | `lifecycle:started` ✓ Renamed (dual-emit active) |
| `stopped` | — | ✗ | `lifecycle:stopped` ✓ Renamed (dual-emit active) |
| `resource-metrics-updated` | `{ resourceId, metrics }` | ✗ | `resource-metrics:updated` |
| `node-capacity-registered` | `capacity` | ✗ | `node-capacity:registered` |
| `topology-changed` | `topology` | ✗ | `topology:changed` |
| `health-alert` | `{ … }` | ✗ | `health:alert` |
| `dashboard-updated` | `dashboard` | ✗ | `dashboard:updated` |
| `error` | `error` | ✗ | `lifecycle:error` — intentionally NOT dual-emitted; Node.js `error` semantics preserved |

### StateReconciler (`src/cluster/reconciliation/StateReconciler.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `conflict-resolved` | `result` | ✗ | `conflict:resolved` |
| `resolution-failed` | `{ conflict, error }` | ✗ | `resolution:failed` |
| `conflicts-batch-resolved` | `results[]` | ✗ | `conflicts:batch-resolved` |

### ProductionScaleResourceManager (`src/cluster/resources/ProductionScaleResourceManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `manager:started` | — | ✓ | — |
| `manager:stopped` | — | ✓ | — |
| `resource:scaled-up` | `resourceId, newReplicaCount` | ✓ | — |
| `resource:scaled-down` | `resourceId, newReplicaCount` | ✓ | — |
| `resource:unhealthy` | `resource, health` | ✓ | — |

### ResourceRegistry (`src/cluster/resources/ResourceRegistry.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `resource:created` | `resource, event` | ✓ | — |
| `resource:updated` | `resource, event` | ✓ | — |
| `resource:destroyed` | `resource, event` | ✓ | — |
| `resource:migrated` | `resource, event` | ✓ | — |

### ResourceTypeRegistry (`src/cluster/resources/ResourceTypeRegistry.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `registry:started` | — | ✓ | — |
| `registry:stopped` | — | ✓ | — |
| `resource-type:registered` | `definition` | ✓ | — |
| `resource-type:unregistered` | `typeName` | ✓ | — |

### SeedNodeRegistry (`src/cluster/seeding/SeedNodeRegistry.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `seed-added` | `{ seed }` | ✗ | `seed:added` |
| `seed-removed` | `{ seedId }` | ✗ | `seed:removed` |
| `seed-failed` | `{ seed, error }` | ✗ | `seed:failed` |
| `seed-degraded` | `{ seed, error, failures }` | ✗ | `seed:degraded` |
| `seed-recovered` | `{ seed }` | ✗ | `seed:recovered` |
| `seed-auto-recovered` | `{ seed }` | ✗ | `seed:auto-recovered` |
| `health-check-completed` | `{ … }` | ✗ | `health-check:completed` |

### DistributedSession (`src/cluster/sessions/DistributedSession.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `session:created` | `sessionId, state` | ✓ | — |
| `session:evicted` | `sessionId` | ✓ | — |
| `session:orphaned` | `resourceId` | ✓ | — |

### ClusterTopologyManager (`src/cluster/topology/ClusterTopologyManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `started` | — | ✗ | `lifecycle:started` ✓ Renamed (dual-emit active) |
| `stopped` | — | ✗ | `lifecycle:stopped` ✓ Renamed (dual-emit active) |
| `topology-updated` | `topology` | ✗ | `topology:updated` |
| `room-scaling-needed` | `{ … }` | ✗ | `room-scaling:needed` |
| `node-capacity-updated` | `capacity` | ✗ | `node-capacity:updated` |
| `error` | `error` | ✗ | `lifecycle:error` — intentionally NOT dual-emitted; Node.js `error` semantics preserved |

### ResourceTopologyManager (`src/cluster/topology/ResourceTopologyManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `topology:started` | — | ✓ | — |
| `topology:stopped` | — | ✓ | — |
| `topology:updated` | — | ✓ | — |
| `topology:optimization-recommendations` | `recommendations` | ✓ | — |
| `topology:node-joined` | `NodeInfo` | ✓ | — |
| `topology:node-left` | `nodeId` | ✓ | — |
| `topology:resource-created` | `resource` | ✓ | — |
| `topology:resource-destroyed` | `resource` | ✓ | — |
| `resource-type:topology-configured` | `{ typeName, config }` | ✓ | — |

### BootstrapConfig (`src/config/BootstrapConfig.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `seed-added` | `{ seed }` | ✗ | `seed:added` |
| `seed-removed` | `{ seedId }` | ✗ | `seed:removed` |
| `seed-success` | `{ seed }` | ✗ | `seed:succeeded` |
| `seed-failed` | `{ seed, error }` | ✗ | `seed:failed` |
| `seed-recovered` | `{ seed }` | ✗ | `seed:recovered` |

### YamlSeedConfiguration (`src/config/YamlSeedConfiguration.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `config-loaded` | `{ filePath, config }` | ✗ | `config:loaded` |
| `config-error` | `{ filePath, error }` | ✗ | `config:error` |
| `config-saved` | `{ filePath }` | ✗ | `config:saved` |

### Connection (`src/connections/Connection.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `message-sent` | `message` | ✗ | `message:sent` |
| `data-sent` | `data` | ✗ | `data:sent` |
| `message-received` | `message` | ✗ | `message:received` |
| `closed` | `reason` | ✗ | `connection:closed` |
| `timeout` | — | ✗ | `connection:timeout` |
| `error` | `error` | ✗ | `connection:error` |

### ConnectionManager (`src/connections/ConnectionManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `connection-created` | `connection` | ✗ | `connection:created` |
| `connection-removed` | `id` | ✗ | `connection:removed` |
| `connection-closed` | `{ connectionId, reason }` | ✗ | `connection:closed` |
| `connection-error` | `{ connectionId, error }` | ✗ | `connection:error` |
| `message-received` | `{ connectionId, message }` | ✗ | `message:received` |
| `broadcast-sent` | `{ message, sentCount }` | ✗ | `broadcast:sent` |
| `tag-broadcast-sent` | `{ tagKey, tagValue, message, sentCount }` | ✗ | `tag-broadcast:sent` |
| `tags-broadcast-sent` | `{ tags, message, sentCount }` | ✗ | `tags-broadcast:sent` |
| `broadcast-error` | `{ connectionId, error }` | ✗ | `broadcast:error` |
| `cleanup-completed` | `{ removed }` | ✗ | `cleanup:completed` |

### ConnectionPool (`src/connections/ConnectionPool.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `initialized` | `{ minConnections }` | ✗ | `pool:initialized` |
| `initialization-error` | `error` | ✗ | `pool:initialization-error` |
| `connection-acquired` | `{ … }` | ✗ | `connection:acquired` |
| `acquire-error` | `{ error, acquireTime }` | ✗ | `acquire:error` |
| `connection-released` | `{ … }` | ✗ | `connection:released` |
| `connection-created` | `{ … }` | ✗ | `connection:created` |
| `connection-creation-error` | `error` | ✗ | `connection-creation:error` |
| `connection-error` | `{ connectionId }` | ✗ | `connection:error` |
| `connection-closed` | `{ connectionId }` | ✗ | `connection:closed` |
| `connection-removed` | `{ … }` | ✗ | `connection:removed` |
| `cleanup-completed` | `{ removedCount }` | ✗ | `cleanup:completed` |
| `options-updated` | `{ options }` | ✗ | `options:updated` |
| `drained` | — | ✗ | `pool:drained` |
| `destroyed` | — | ✗ | `pool:destroyed` |

### ConnectionRegistry (`src/connections/ConnectionRegistry.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `connection:registered` | `handle` | ✓ | — |
| `connection:unregistered` | `entityId` | ✓ | — |
| `connection:expired` | `id` | ✓ | — |
| `connection:reconnected` | `handle` | ✓ | — |

### MockWebSocketEventEmitter (`src/connections/adapters/WebSocketConnection.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `sent` | `data` | ✗ | `message:sent` |
| `close` | — | ✗ | `connection:closed` |
| `message` | `Buffer` | ✗ | `message:received` |
| `pong` | — | ✗ | `ping:pong` |
| `error` | `Error` | ✗ | `connection:error` |

> Note: this is a mock/test adapter; bare Node.js WebSocket event names (`close`, `message`, `pong`, `error`) are intentional protocol-layer names and may reasonably be exempt from the convention.

### Coordinators — InMemoryCoordinator / GossipCoordinator / RangeCoordinator

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `node-joined` | `nodeId` | ✗ | `node:joined` |
| `node-left` | `nodeId` | ✗ | `node:left` |
| `range-acquired` | `rangeId` | ✗ | `range:acquired` |
| `range-released` | `rangeId` | ✗ | `range:released` |
| `lease-conflict` | `rangeId, existingOwnerNodeId` | ✗ | `lease:conflict` |
| `topology-changed` | `ClusterView \| void` | ✗ | `topology:changed` |
| `error` | `error` | ✗ | `coordinator:error` |

### ChaosInjector (`src/diagnostics/ChaosInjector.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `scenario-started` | `{ scenarioId, … }` | ✗ | `scenario:started` |
| `scenario-stopped` | `{ scenarioId, … }` | ✗ | `scenario:stopped` |

### DiagnosticTool (`src/diagnostics/DiagnosticTool.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `health-status-changed` | `{ … }` | ✗ | `health-status:changed` |
| `performance-alert` | `{ … }` | ✗ | `performance:alert` |

### ChannelManager (`src/gateway/channel/ChannelManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `channel-created` | `info` | ✗ | `channel:created` |
| `channel-destroyed` | `{ channelId }` | ✗ | `channel:destroyed` |
| `channel-broadcast` | `{ channelId, payload, excludeClientId }` | ✗ | `channel:broadcast` |
| `member-joined` | `{ channelId, clientId }` | ✗ | `member:joined` ✓ Renamed (dual-emit active) |
| `member-left` | `{ channelId, clientId }` | ✗ | `member:left` ✓ Renamed (dual-emit active) |
| `ownership-gained` | `{ channelId, previousOwner }` | ✗ | `ownership:gained` |
| `ownership-lost` | `{ channelId, newOwner }` | ✗ | `ownership:lost` |

### PresenceManager (`src/gateway/presence/PresenceManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `client-tracked` | `entry` | ✗ | `client:tracked` |
| `client-untracked` | `entry` | ✗ | `client:untracked` |
| `client-updated` | `entry` | ✗ | `client:updated` |
| `client-expired` | `entry` | ✗ | `client:expired` |
| `sync-sent` | — | ✗ | `sync:sent` |
| `sync-received` | `{ nodeId, count }` | ✗ | `sync:received` |

### DurableQueueManager (`src/gateway/queue/DurableQueueManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `message-enqueued` | `message` | ✗ | `message:enqueued` |
| `message-acked` | `message` | ✗ | `message:acked` |
| `message-nacked` | `message` | ✗ | `message:nacked` |
| `message-dead-lettered` | `message` | ✗ | `message:dead-lettered` |
| `message-dispatched` | `message` | ✗ | `message:dispatched` |

### PubSubManager (`src/gateway/pubsub/PubSubManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `member-left` | `nodeId` | ✗ | `member:left` ✓ Renamed (dual-emit active) |
| `subscription-added` | `{ id, topic }` | ✗ | `subscription:added` |
| `subscription-removed` | `{ id, topic }` | ✗ | `subscription:removed` |
| `message-published` | `{ topic, messageId }` | ✗ | `message:published` |
| `message-delivered` | `{ topic, subscriptionId }` | ✗ | `message:delivered` |

### SignedPubSubManager (`src/gateway/pubsub/SignedPubSubManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `message:rejected` | `{ topic, reason, publisherNodeId }` | ✓ | — |

### SharedStateManager (`src/gateway/state/SharedStateManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `state:updated` | `channelId, nextState` | ✓ | — |

### MessageRouter (`src/gateway/routing/MessageRouter.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `local-delivery` | `{ clientId, message }` | ✗ | `delivery:local` |
| `local-broadcast` | `{ clientIds, message }` | ✗ | `broadcast:local` |
| `delivery-failed` | `{ target, reason }` | ✗ | `delivery:failed` |

### GossipMessage (`src/transport/GossipMessage.ts` and `src/gossip/transport/GossipMessage.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `expired` | `this` (GossipMessage) | ✗ | `message:expired` |
| `delivered` | `this` (GossipMessage) | ✗ | `message:delivered` |
| `retry` | `retryCount: number` | ✗ | `message:retry` |

### EventBus (`src/messaging/EventBus.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `compact:completed` | `result` | ✓ | — |
| `compact:error` | `err` | ✓ | — |

### FailureDetector (`src/monitoring/FailureDetector.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `node-failed` | `nodeId, reason` | ✗ | `node:failed` |
| `node-suspected` | `nodeId` | ✗ | `node:suspected` |
| `node-recovered` | `nodeId` | ✗ | `node:recovered` |

### MetricsTracker (`src/monitoring/metrics/MetricsTracker.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `collection-started` | — | ✗ | `collection:started` |
| `collection-stopped` | — | ✗ | `collection:stopped` |
| `metrics-collected` | `unifiedMetrics` | ✗ | `metrics:collected` |
| `metrics-tracked` | `metrics` | ✗ | `metrics:tracked` |
| `counter-incremented` | `counterEvent` | ✗ | `counter:incremented` |
| `gauge-set` | `gaugeEvent` | ✗ | `gauge:set` |
| `alert` | `alert` | ✗ | `metrics:alert` |
| `trends-updated` | — | ✗ | `trends:updated` |
| `reset` | — | ✗ | `metrics:reset` |
| `config-updated` | `config` | ✗ | `config:updated` |
| `error` | `Error` | ✗ | `metrics:error` |

### MetricsExporter (`src/monitoring/metrics/MetricsExporter.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `export-success` | `{ metrics, alerts }` | ✗ | `export:succeeded` |
| `export-error` | `error` | ✗ | `export:error` |
| `export-attempted` | `{ … }` | ✗ | `export:attempted` |
| `flush-error` | `error` | ✗ | `flush:error` |
| `destination-added` | `destination` | ✗ | `destination:added` |
| `destination-removed` | `{ type, endpoint }` | ✗ | `destination:removed` |
| `config-updated` | `config` | ✗ | `config:updated` |

### CompactionCoordinator (`src/persistence/compaction/CompactionCoordinator.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `coordinator:started` | `{ … }` | ✓ | — |
| `coordinator:stopped` | — | ✓ | — |
| `strategy:changed` | `{ … }` | ✓ | — |
| `compaction:started` | `{ … }` | ✓ | — |
| `compaction:completed` | `{ … }` | ✓ | — |
| `compaction:failed` | `{ … }` | ✓ | — |
| `error` | `error` | ✗ | `compaction:error` |

### AutoReclaimPolicy (`src/routing/AutoReclaimPolicy.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `reclaim:attempted` | `resourceId` | ✓ | — |
| `reclaim:skipped` | `resourceId, reason` | ✓ | — |
| `reclaim:succeeded` | `newHandle` | ✓ | — |
| `reclaim:failed` | `resourceId, Error` | ✓ | — |

### ResourceRouter (`src/routing/ResourceRouter.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `resource:claimed` | `handle` | ✓ | — |
| `resource:transferred` | `handle` | ✓ | — |
| `resource:released` | `handle` | ✓ | — |
| `resource:orphaned` | `handle` | ✓ | — |

### CircuitBreaker (`src/transport/CircuitBreaker.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `call-started` | `{ state, totalCalls }` | ✗ | `call:started` |
| `call-success` | `{ result, duration, state }` | ✗ | `call:succeeded` |
| `call-failure` | `{ error, duration, state }` | ✗ | `call:failed` |
| `call-rejected` | `{ reason, error }` | ✗ | `call:rejected` |
| `success` | `{ duration, state, successCount }` | ✗ | `call:succeeded` *(duplicate of `call-success`; resolve at same time)* |
| `failure` | `{ error, duration, state, failureCount }` | ✗ | `call:failed` *(duplicate of `call-failure`; resolve at same time)* |
| `state-change` | `{ from, to, … }` | ✗ | `state:changed` |
| `manual-reset` | `{ timestamp }` | ✗ | `breaker:reset` |
| `forced-open` | `{ timestamp }` | ✗ | `breaker:forced-open` |
| `options-updated` | `{ options }` | ✗ | `options:updated` |
| `destroyed` | `{ name }` | ✗ | `breaker:destroyed` |

### CircuitBreakerManager (`src/transport/CircuitBreaker.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `breaker-created` | `{ name, options }` | ✗ | `breaker:created` |
| `breaker-removed` | `{ name }` | ✗ | `breaker:removed` |
| `breaker-state-change` | `{ name, from, to }` | ✗ | `breaker:state-changed` |
| `breaker-call-failure` | `{ name, … }` | ✗ | `breaker:call-failed` |
| `breaker-call-success` | `{ name, … }` | ✗ | `breaker:call-succeeded` |
| `all-breakers-reset` | — | ✗ | `breakers:reset` |
| `manager-destroyed` | — | ✗ | `manager:destroyed` |

### Encryption (`src/transport/Encryption.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `initialized` | — | ✗ | `encryption:initialized` |
| `destroyed` | — | ✗ | `encryption:destroyed` |
| `key-generated` | `{ keyId }` | ✗ | `key:generated` |
| `key-added` | `{ keyId, version }` | ✗ | `key:added` |
| `key-removed` | `{ keyId, version }` | ✗ | `key:removed` |
| `key-rotated` | `{ newKeyId, oldKeyId }` | ✗ | `key:rotated` |
| `key-rotation-error` | `error` | ✗ | `key-rotation:error` |
| `key-imported` | `{ keyId }` | ✗ | `key:imported` |
| `key-destroyed` | `{ keyId }` | ✗ | `key:destroyed` |

### MessageAuth (`src/transport/MessageAuth.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `initialized` | `{ keyVersion }` | ✗ | `auth:initialized` |
| `destroyed` | — | ✗ | `auth:destroyed` |
| `key-generated` | `{ keyVersion }` | ✗ | `key:generated` |
| `key-added` | `{ keyVersion }` | ✗ | `key:added` |
| `key-removed` | `{ keyVersion }` | ✗ | `key:removed` |
| `key-destroyed` | `{ keyVersion }` | ✗ | `key:destroyed` |
| `verification-success` | `{ … }` | ✗ | `verification:succeeded` |
| `verification-failed` | `{ … }` | ✗ | `verification:failed` |
| `verification-error` | `error` | ✗ | `verification:error` |
| `nonces-cleaned` | `{ removedCount, totalNonces }` | ✗ | `nonces:cleaned` |

### MessageBatcher (`src/transport/MessageBatcher.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `message-queued` | `{ messageId, destination, priority, queueSize }` | ✗ | `message:queued` |
| `bulk-messages-added` | `{ count, messageIds }` | ✗ | `messages:bulk-added` |
| `batch-ready` | `batch` | ✗ | `batch:ready` |
| `urgent-batch-ready` | `batch` | ✗ | `batch:urgent-ready` |
| `priority-batch-ready` | `batch` | ✗ | `batch:priority-ready` |
| `priority-flush-complete` | `{ minPriority, batchesFlushed }` | ✗ | `priority-flush:completed` |
| `all-flushed` | `{ destinationCount }` | ✗ | `flush:completed` |
| `compression-error` | `{ error, destination, batchId }` | ✗ | `compression:error` |
| `cleared` | — | ✗ | `batcher:cleared` |
| `options-updated` | `{ options }` | ✗ | `options:updated` |
| `destroyed` | — | ✗ | `batcher:destroyed` |

### RetryManager (`src/transport/RetryManager.ts`)

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `operation-success` | `{ operationId, result, … }` | ✗ | `operation:succeeded` |
| `operation-failed` | `{ operationId, error, … }` | ✗ | `operation:failed` |
| `attempt-start` | `{ operationId, attempt, totalElapsed }` | ✗ | `attempt:started` |
| `attempt-success` | `{ operationId, attempt, result }` | ✗ | `attempt:succeeded` |
| `attempt-failure` | `{ operationId, attempt, error }` | ✗ | `attempt:failed` |
| `retry-scheduled` | `{ operationId, attempt, delay, error }` | ✗ | `retry:scheduled` |
| `cache-hit` | `{ operationId }` | ✗ | `cache:hit` |
| `batch-start` | `{ batchId, operationCount }` | ✗ | `batch:started` |
| `batch-complete` | `{ … }` | ✗ | `batch:completed` |
| `dead-letter-reprocessing` | `{ messageId, deadLetter }` | ✗ | `dead-letter:reprocessing` |
| `dead-letter-success` | `{ messageId, result }` | ✗ | `dead-letter:succeeded` |
| `dead-letter-failed` | `{ messageId, error }` | ✗ | `dead-letter:failed` |
| `dead-letter-cleared` | `{ count }` | ✗ | `dead-letter:cleared` |
| `options-updated` | `{ options }` | ✗ | `options:updated` |
| `cleared` | — | ✗ | `manager:cleared` |
| `destroyed` | — | ✗ | `manager:destroyed` |

### Transport Adapters (ClientWebSocketAdapter, GRPCAdapter, HTTPAdapter, InMemoryAdapter, TCPAdapter, UDPAdapter, WebSocketAdapter)

Common adapter events (all adapters follow the same pattern):

| Event name | Payload | Conformance | Proposed rename |
|---|---|---|---|
| `started` | `{ port, host }` | ✗ | `adapter:started` |
| `stopped` | — | ✗ | `adapter:stopped` |
| `start-error` | `error` | ✗ | `adapter:start-error` |
| `stop-error` | `error` | ✗ | `adapter:stop-error` |
| `server-closed` | — | ✗ | `server:closed` |
| `server-error` | `error` | ✗ | `server:error` |
| `connection-established` | `nodeId` | ✗ | `connection:established` |
| `connection-received` | `nodeId` | ✗ | `connection:received` |
| `connection-closed` | `nodeId \| { nodeId, … }` | ✗ | `connection:closed` |
| `connection-error` | `{ nodeId, error }` | ✗ | `connection:error` |
| `message-sent` | `{ nodeId }` | ✗ | `message:sent` |
| `message-received` | `message, nodeId` | ✗ | `message:received` |
| `message-parse-error` | `{ error, connection }` | ✗ | `message:parse-error` |
| `broadcast-sent` | `{ … }` | ✗ | `broadcast:sent` |
| `broadcast-error` | `{ connection, error }` | ✗ | `broadcast:error` |
| `broadcast-no-connections` | `message` | ✗ | `broadcast:no-connections` |
| `handler-error` | `{ error, connection }` | ✗ | `handler:error` |
| `circuit-breaker-state-change` | `data` | ✗ | `breaker:state-changed` |
| `disconnection` | `{ nodeId, … }` | ✗ | `connection:disconnected` |
| `client-connected` | `{ clientId, connection }` | ✗ | `client:connected` |
| `client-disconnected` | `{ clientId, … }` | ✗ | `client:disconnected` |
| `client-message` | `{ clientId, message, connection }` | ✗ | `client:message` |
| `send-error` | `{ clientId, error, message }` | ✗ | `send:error` |
| `message-parse-error` | `{ … }` | ✗ | `message:parse-error` |
| `socket-error` | `error` | ✗ | `socket:error` |
| `multicast-sent` | `{ message, size }` | ✗ | `multicast:sent` |
| `multicast-received` | `{ … }` | ✗ | `multicast:received` |
| `multicast-parse-error` | `{ … }` | ✗ | `multicast:parse-error` |
| `multicast-error` | `error` | ✗ | `multicast:error` |

---

## Non-conforming names

### 1. `member-joined` / `member-left` / `member-updated` / `membership-updated` (MembershipTable, ClusterManager)

**Why non-conforming:** Hyphen-only separator — no colon dividing noun from verb.

**Proposed renames:** `member:joined`, `member:left`, `member:updated`, `membership:updated`

**Breaking-change impact — HIGH.** These are the highest-traffic events in the codebase. Callers found across 12 source files:
- `ClusterTopologyManager`, `ResourceTopologyManager`, `ClusterIntrospection`, `GossipCoordinator`, `ClusterCompactionBridge`, `PipelineModule`, `FailureDetector`, `ChannelManager` (via `membership-updated`), `PresenceManager`, `PubSubManager`, `ResourceRouter`, plus `ClusterManager` itself re-emitting from `MembershipTable`.

**Migration strategy:** Emit both old and new names for one minor version (dual-emit bridge), then remove old names in the following major. Document in CHANGELOG as a deprecation.

---

### 2. `pipeline.run.*` / `pipeline.step.*` / `pipeline.llm.*` / `pipeline.join.*` / `pipeline.approval.*` (PipelineExecutor)

> **COMPLETED** — All 22 pipeline events renamed. See the updated table above.

All 22 events renamed from dot-separated to colon-separated form using a three-segment canonical form (`pipeline:run:started`, `pipeline:step:failed`, etc.).

**Dual-emit bridge is ACTIVE.** The executor publishes both names simultaneously. `PipelineModule` internal subscribers were migrated to the new names. The `PipelineEventMap` type retains both key sets with `@deprecated` on the old names.

**Limitation:** The dual-emit bridge only fires from the executor's internal `emit()` helper. External callers that `publish` the old dot-form directly will NOT automatically bridge to the colon form. They must be migrated explicitly.

**Removal:** Old dot-form names will be removed in a future major release. Remove `CANONICAL_TO_DEPRECATED` from `PipelineExecutor.ts` and remove the `@deprecated` entries from `PipelineEventMap` at that time.

---

### 3. `sessionStarted` / `sessionComplete` / `sessionError` / `sessionCleaned` / `deltaTransmitted` / `deltaTransmissionError` (DeltaSyncEngine)

**Why non-conforming:** camelCase — not lowercase, no separator.

**Proposed renames:** `session:started`, `session:completed`, `session:error`, `session:cleaned`, `delta:transmitted`, `delta:transmission-error`

**Breaking-change impact — LOW.** No listeners found in `src/` outside of `DeltaSync.ts` itself. The events appear to be self-contained internal signals.

**Migration strategy:** Rename outright with no deprecation period.

---

### 4. Bare lifecycle words: `started`, `stopped`, `error`, `left`, `drained`, `rebalanced`, `change`, `initialized`, `destroyed`, `drained`, `cleared`, `reset`

**Why non-conforming:** No noun. These are emitted by a dozen different classes; when events are forwarded or logged they lose their origin.

**Proposed renames:** Qualify with the class noun — e.g., `cluster:started`, `aggregator:stopped`, `config:changed`, `pool:drained`, `encryption:initialized`.

**Breaking-change impact — LOW to MEDIUM.** Most bare-word events are only subscribed within the same module or in tests. `error` is the notable exception — Node's built-in `EventEmitter` treats `error` specially (it throws if unhandled). Renaming it removes that safety; consider keeping `error` as a passthrough alias on any class that today emits it.

**Migration strategy:** Rename per-class across a single release. Add a note in each class's JSDoc for the transition cycle.

---

### 5. `elected` / `deposed` / `leader-changed` (LeaderElection / ClusterLeaderElection)

**Why non-conforming:** `elected` and `deposed` have no noun; `leader-changed` has no colon.

**Proposed renames:** `leader:elected`, `leader:deposed`, `leader:changed`

**Breaking-change impact — LOW.** Only `ClusterLeaderElection` listens to `LeaderElection`'s `elected`/`deposed`. No external callers found.

**Migration strategy:** Rename outright.

---

### 6. `node-failed` / `node-suspected` / `node-recovered` (FailureDetector); `node-joined` / `node-left` (coordinators)

**Why non-conforming:** Hyphen-only.

**Proposed renames:** `node:failed`, `node:suspected`, `node:recovered`, `node:joined`, `node:left`

**Breaking-change impact — LOW.** `FailureDetectorBridge` listens to `node-failed` and `node-suspected` (2 callers). Coordinator events are internal.

**Migration strategy:** Rename outright with simultaneous listener update.

---

### 7. `CircuitBreaker` duplicate semantics: `success` / `call-success` and `failure` / `call-failure`

**Why non-conforming:** Two events convey the same outcome from the same class with different names. Neither follows the convention.

**Proposed renames:** Collapse to `call:succeeded` and `call:failed`. Remove the shorter aliases.

**Breaking-change impact — MEDIUM.** `CircuitBreakerManager` re-emits `call-failure` and `call-success` as `breaker-call-failure` / `breaker-call-success`. All four names need updating together.

**Migration strategy:** Rename in tandem; update `CircuitBreakerManager`'s forwarding at the same time.

---

## Conforming names (sample)

These events correctly follow `noun:verb` and serve as the reference for future contributors:

| Primitive | Event | Why it's right |
|---|---|---|
| `ResourceRouter` | `resource:claimed` | Clear noun + past-participle verb |
| `ResourceRouter` | `resource:orphaned` | Clear noun + state-describing past participle |
| `QuorumDistributedLock` | `lock:acquired` | Unambiguous noun + past participle |
| `QuorumDistributedLock` | `lock:denied` | Rejection outcome clearly named |
| `ConnectionRegistry` | `connection:expired` | Noun + past participle; no ambiguity |
| `ConnectionRegistry` | `connection:reconnected` | Noun + specific lifecycle verb |
| `FailureDetectorBridge` | `cleanup:triggered` | Action noun + past participle |
| `DistributedSession` | `session:orphaned` | Noun + semantic past participle |
| `EventBus` | `compact:completed` | Noun + past participle |
| `CompactionCoordinator` | `compaction:started` | Noun + in-progress participle |
| `AutoReclaimPolicy` | `reclaim:succeeded` | Noun + outcome verb |
| `SignedPubSubManager` | `message:rejected` | Noun + past participle |

---

## Recommendations

### Priority 1 — Must rename (highest caller impact)

1. **`member-joined` / `member-left` / `member-updated` / `membership-updated`**
   — 23 listener sites across 12 files. Use dual-emit bridge for one minor version.
2. **`pipeline.run.*` / `pipeline.step.*` / `pipeline.llm.*`** (16 event names)
   — Active API consumed by `PipelineModule`; rename colon-separated in one coordinated PR updating `PipelineEventMap` type and all emit/subscribe sites.
3. **`started` / `stopped` / `error` (bare) emitted by `ClusterManager`, `ClusterLifecycle`, `ObservabilityManager`, `ClusterTopologyManager`**
   — These are the outermost cluster primitives; qualifying them prevents log/trace confusion when events bubble.

### Priority 2 — Should rename

4. **`leader-changed` / `elected` / `deposed`** — small blast radius, easy win.
5. **`node-failed` / `node-suspected` / `node-recovered`** — only 2 listener sites; rename outright.
6. **`sessionStarted` / `sessionComplete` / `deltaTransmitted` etc.** (DeltaSyncEngine camelCase) — zero external listeners; rename outright.
7. **`CircuitBreaker` duplicate pairs** (`success`/`call-success`, `failure`/`call-failure`) — consolidate while renaming.

### Priority 3 — Nice to have

8. All remaining hyphen-only names in lower-priority primitives (transport adapters, connection pool, diagnostics tools, config loaders). These have no external callers found in `src/` and can be cleaned up on a rolling basis as those files are touched.

### Suggested phasing

| Release | Changes |
|---|---|
| **v-next patch** | Add deprecation comments on all non-conforming names; no code change |
| **v-next minor** | Rename Priority 2 + 3 items (low blast radius). Dual-emit `member:*` alongside legacy names. Rename all `pipeline.*` events atomically. |
| **v-next major** | Remove legacy `member-*` / `membership-*` names. Rename Priority 1 bare lifecycle words. |
