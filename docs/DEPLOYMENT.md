# Deployment

This guide is for teams building a service on top of distributed-core and
wanting to run that service in production. It is written honestly: limitations
are documented alongside capabilities, and features that do not exist yet are
called out as such rather than assumed.

---

## Operational model

**distributed-core is a library, not a runtime.** There is no standalone binary
to deploy. You write an application (like `examples/cluster-collab/`) that
imports distributed-core primitives, wires them together, and exposes whatever
HTTP, WebSocket, or gRPC surface your business logic requires.

What you deploy is your application container. distributed-core runs inside it.

The primitives are stateful (all implement `LifecycleAware`: `start()`,
`stop()`, `isStarted()`), but they hold state in process memory and optionally
on local disk (WAL). There is no separate database or coordination service to
run — the nodes coordinate with each other directly over PubSub.

**PubSub transport is your responsibility.** The library ships with an in-memory
PubSub bus (`InMemoryPubSubManager`) for tests and single-process demos. In a
real deployment you must bring a real PubSub transport: a Redis pub/sub channel,
a WebSocket mesh, NATS, or a custom `PubSubManager` implementation. The
`EntityRegistrySyncAdapter`, `SharedStateManager`, `EventBus`, and
`QuorumDistributedLock` all go through `PubSubManager` — every node in the
cluster must share the same logical bus.

---

## Minimal single-node

For local development or a single-instance deployment where you need the
distributed-core primitives but do not require multi-node coordination, the
simplest setup is:

```typescript
import { EntityRegistryFactory } from 'distributed-core';
import { EntityRegistrySyncAdapter } from 'distributed-core';
import { ResourceRouter } from 'distributed-core';
// Your PubSubManager: replace with a real transport in production
import { MyPubSubManager } from './transport';

const nodeId = process.env.NODE_ID ?? 'node-0';
const pubsub = new MyPubSubManager();

const registry = EntityRegistryFactory.createMemory(nodeId);
await registry.start();

const sync = new EntityRegistrySyncAdapter(registry, pubsub, nodeId, {
  topic: process.env.ENTITY_SYNC_TOPIC ?? 'entity-sync',
});
sync.start();

const router = new ResourceRouter(nodeId, registry, clusterManager, {
  metrics,
});
await router.start();
```

Run the built output with:

```bash
node dist/server.js
```

or using the reference Dockerfile:

```bash
docker build -t my-service .
docker run -p 8080:8080 -e NODE_ID=node-0 my-service
```

A single-node deployment survives process restarts if you use
`WriteAheadLogEntityRegistry` (see §Persistence). Without WAL, all ownership
state is lost on restart and clients must re-establish sessions.

---

## Three-node cluster in Kubernetes

The `k8s/` directory contains four manifests ready to apply:

```
k8s/
  namespace.yaml      — dedicated namespace
  configmap.yaml      — tuning parameters as env vars
  service.yaml        — headless Service (peer DNS) + ClusterIP Service (traffic)
  statefulset.yaml    — 3-replica StatefulSet with init container, probes, PVCs
```

Apply in order:

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/statefulset.yaml
```

Watch rollout:

```bash
kubectl rollout status statefulset/distributed-core-collab \
  -n distributed-core-demo
```

### Why StatefulSet and not Deployment

Deployments give Pods ephemeral names (`collab-x7f2q`) that change on every
reschedule. StatefulSets give Pods stable, predictable names (`collab-0`,
`collab-1`, `collab-2`) and stable DNS hostnames:

```
collab-0.distributed-core-svc.distributed-core-demo.svc.cluster.local
```

Stable DNS is required because:

- `ForwardingRouter` / `HttpForwardingTransport` look up peer addresses by
  hostname to forward requests to the owning node.
- The init container uses peer hostnames to verify DNS has propagated before
  the application starts.
- `ClusterLeaderElection` publishes the leader's route via `ResourceRouter`; the
  address stored in that route must remain valid across reschedules.

### How peers discover each other (headless service + DNS)

`service.yaml` creates a headless Service (`clusterIP: None`). Kubernetes DNS
returns individual Pod A records for the selector, not a single virtual IP.
Each Pod is addressable by ordinal:

```
collab-0.distributed-core-svc.<namespace>.svc.cluster.local → Pod IP
collab-1.distributed-core-svc.<namespace>.svc.cluster.local → Pod IP
collab-2.distributed-core-svc.<namespace>.svc.cluster.local → Pod IP
```

Your application receives these addresses via the `PEERS` environment variable
injected by the StatefulSet. Use them to populate the `ClusterManager`
membership table at startup.

### Rolling restarts and leader election implications

The StatefulSet uses `RollingUpdate` with `maxUnavailable: 1`. During a
rollout, at most one Pod is replaced at a time. The sequence for a 3-node
cluster is:

1. `collab-2` is terminated and replaced.
2. After `collab-2` passes its readiness probe, `collab-1` is replaced.
3. After `collab-1` passes, `collab-0` is replaced.

Implication for `ClusterLeaderElection`: if the current leader is on the Pod
being replaced, leadership is lost. The remaining two nodes will elect a new
leader within `leaseDurationMs + renewIntervalMs` (configured on
`LeaderElectionConfig`). Plan rolling restarts outside peak traffic windows or
ensure your application handles leader transitions gracefully.

`QuorumDistributedLock` requires `floor(N/2)+1` peers to grant a lock.
With `maxUnavailable: 1` on a 3-node cluster, 2 nodes are always alive, so
majority (2 of 3) is always satisfied during rollouts.

### What the init container is for

The init container (`wait-for-peers` in `statefulset.yaml`) runs before the
main container and loops over each peer hostname with `nslookup` until all
resolve. This solves a startup race:

- Kubernetes creates `collab-0` first (OrderedReady policy).
- `collab-1` and `collab-2` do not yet exist; their DNS entries are absent.
- Without waiting, `collab-0` might start, connect to peers, find none, and
  operate as a singleton even though peers are coming up seconds later.

The init container adds a few seconds to cold-start but prevents cluster
misconfiguration. `publishNotReadyAddresses: true` on the headless Service
ensures DNS entries exist before Pods pass readiness, which is what lets the
init container resolve them.

### Probe configuration

Both probes call `GET /health` on port 8080. Your application must expose this
endpoint. The simplest wiring using `ForwardingServer` (which already runs an
HTTP server for cross-node forwarding) is to add a `/health` route handler:

```typescript
// In your ForwardingServer handler, check for /health before routing:
const server = new ForwardingServer(router, async (resourceId, path, payload) => {
  if (path === '/health') {
    return { status: 'ok', nodeId };
  }
  // ... normal dispatch
}, { port: Number(process.env.PORT ?? 8080) });
```

Alternatively, run a minimal `http.createServer` alongside your application
that only handles `/health`.

**Liveness probe** (`initialDelaySeconds: 20`, `periodSeconds: 10`,
`failureThreshold: 3`): if the container stops responding for 30 seconds,
Kubernetes restarts it. Set `initialDelaySeconds` higher than your WAL replay
time — WAL replay on a large dataset can take several seconds.

**Readiness probe** (`initialDelaySeconds: 10`, `periodSeconds: 5`): if not
ready, Kubernetes removes the Pod from Service endpoints (no traffic) but does
not restart. During startup, reclaim storms, or leader elections, returning
503 from `/health` until the node has claimed its resources is a safe approach.

---

## Failure modes

### One node killed

When a node dies mid-cluster:

1. The PubSub transport stops delivering messages from/to that node.
2. Your `FailureDetector` (wired to your PubSub or heartbeat mechanism) emits
   a `node-failed` event.
3. `FailureDetectorBridge`, if wired, translates that event into:
   - `resource:orphaned` events on `ResourceRouter` for every resource the dead
     node owned.
   - `connection:expired` events on `ConnectionRegistry` for its connections.
4. `AutoReclaimPolicy` listens for `resource:orphaned` and, after a random
   jitter delay (`jitterMs`, default 300 ms), one surviving node claims each
   orphaned resource.

The cluster continues operating with the surviving nodes. No data is lost
assuming updates were applied to `DistributedSession` before the node died —
the session state lives in-process and is not automatically replicated to disk
on the dead node.

**Note**: `FailureDetector` and `FailureDetectorBridge` require wiring by the
caller. The library provides the primitives; it does not provide a built-in
heartbeat/gossip transport for detecting failures. In the cluster-collab
example, failure detection is simulated manually (`router.handleNodeLeft()`).
In production you need real failure detection driven by your PubSub or
a separate heartbeat mechanism.

### Full cluster restart

If all nodes restart simultaneously (e.g. a deploy or power event):

- **With `InMemoryEntityRegistry`**: all ownership state is lost. Clients must
  reconnect and re-subscribe. No crash recovery.
- **With `WriteAheadLogEntityRegistry`**: the WAL is replayed on startup. Each
  node reconstructs its ownership map from the WAL before accepting requests.
  Recovery time is proportional to WAL size; compact regularly (see §Persistence).
- **With `WALSnapshotVersionStore` for `SharedStateManager`**: session state
  snapshots survive the restart and are loaded during `subscribe()`.

For full cluster restart resilience, use WAL registries and snapshot stores, and
ensure PVCs are mounted (see `volumeClaimTemplates` in `statefulset.yaml`).

### Network partition

If a partition splits the 3-node cluster into a 1+2 group:

- Each side continues operating locally.
- `EntityRegistrySyncAdapter` delivers updates within each partition but not
  across it (best-effort PubSub delivery).
- **`ClusterLeaderElection`**: both sides can elect a leader. Split-brain is
  possible. This is a documented limitation — the library does not implement
  full consensus (no Raft/Paxos). If your application requires a single leader
  across a partition, add fencing tokens or an external lock service.
- **`QuorumDistributedLock`**: the side with 2 nodes (majority of original 3)
  can grant locks. The singleton side cannot reach majority and will time out.
  If both sides independently have a majority of their own shrinking membership
  view, both can grant the same lock. See `docs/ARCHITECTURE.md §Partition
  behavior` for the honest assessment.
- After healing, `applyRemoteUpdate()` replays missed updates with
  last-write-wins semantics. There is no reconciliation protocol beyond event
  replay; conflict resolution is caller-defined.

**Split-brain is a known non-goal** for the current version. For workloads that
require strict partition tolerance, distributed-core is not a sufficient
coordination layer on its own.

### Node added

Adding a fourth node:

1. Deploy the Pod. It starts with an empty or freshly-replayed WAL.
2. It joins the PubSub bus and starts receiving sync messages from existing
   nodes via `EntityRegistrySyncAdapter`.
3. It does not automatically receive a replay of all past events — only future
   updates propagate to it.
4. Resources are claimed by placement strategy. If using `HashPlacement`, some
   resources will rebalance to the new node as it joins the cluster membership.
5. The new node is visible to `ClusterManager` once it emits a membership event;
   `ResourceRouter` then includes it as a candidate for placement.

There is no automatic state bootstrap for a new node joining mid-stream.
If your application requires that a joining node knows the current state of all
resources, implement a snapshot transfer mechanism at the application layer
(e.g., expose a `GET /snapshot` endpoint and call it from the new node at
startup).

---

## Persistence

### WAL file location recommendations

Do not use `emptyDir` for WAL data in production. `emptyDir` is ephemeral —
it is wiped when the Pod is rescheduled or restarted. Use a `PersistentVolume`
(configured via `volumeClaimTemplates` in `statefulset.yaml`).

Recommended mount point: `/app/data`

Configure `WriteAheadLogEntityRegistry` to write to `/app/data/entity.wal`:

```typescript
const registry = EntityRegistryFactory.createWAL(nodeId, {
  filePath: '/app/data/entity.wal',
  // ... other WAL config
});
```

For `WALSnapshotVersionStore`:

```typescript
const snapshotStore = new WALSnapshotVersionStore({
  walPath: '/app/data/snapshots.wal',
});
```

### When to use WALSnapshotVersionStore vs in-memory

| Scenario | Recommendation |
|---|---|
| Single-node, process restarts acceptable | `InMemoryEntityRegistry` |
| Multi-node, sessions must survive Pod restarts | `WriteAheadLogEntityRegistry` + `WALSnapshotVersionStore` |
| Testing / CI | `InMemoryEntityRegistry` (zero-overhead) |
| CRDT multi-master scenarios | `CrdtEntityRegistry` |

### Backup strategy outline

The library does not include a backup coordinator. To back up WAL state:

1. **Periodic snapshot**: call `registry.compact()` on `WriteAheadLogEntityRegistry`
   to reduce WAL to one entry per surviving entity. Copy the compacted WAL file
   to object storage (S3, GCS) on a schedule.
2. **`WALSnapshotVersionStore.compact()`**: removes old snapshot versions,
   keeping only the latest N per key. Run this before backup to minimize file
   size.
3. **PVC snapshots**: use your cloud provider's volume snapshot feature
   (e.g., `VolumeSnapshot` on EKS/GKE) for crash-consistent backups at the
   storage layer. This captures the full WAL without application coordination.

WAL compaction frequency: compact when WAL file size exceeds ~10× the expected
number of entities × average entry size. For 1,000 entities at 200 bytes each,
compact at ~2 MB.

---

## Observability

### MetricsRegistry

Every distributed-core primitive accepts `metrics?: MetricsRegistry` in its
config. When wired, metrics accumulate in-process and can be exported via
`MetricsExporter`.

`MetricsExporter` supports Prometheus, JSON, InfluxDB, CloudWatch, and Datadog
export formats. Wire it to your metrics pipeline:

```typescript
import { MetricsRegistry } from 'distributed-core';
import { MetricsExporter } from 'distributed-core';

const metrics = new MetricsRegistry(nodeId);
const exporter = new MetricsExporter(metrics, {
  destinations: [{
    type: 'prometheus',
    endpoint: 'http://prometheus-pushgateway:9091/metrics/job/distributed-core',
  }],
  intervalMs: 15_000,
});
await exporter.start();
```

Key metrics emitted by the primitives (Prometheus-style dot-separated names):

| Metric | Type | Emitted by |
|---|---|---|
| `resource.claim.count` | counter | `ResourceRouter` |
| `resource.claim.latency_ms` | histogram | `ResourceRouter` |
| `resource.orphaned.count` | counter | `ResourceRouter` |
| `lock.acquire.count` | counter | `DistributedLock` |
| `lock.hold.gauge` | gauge | `DistributedLock` |
| `session.active.gauge` | gauge | `DistributedSession` |
| `session.evicted.count` | counter | `DistributedSession` |
| `connection.active.gauge` | gauge | `ConnectionRegistry` |
| `connection.expired.count` | counter | `ConnectionRegistry` |
| `event.published.count` | counter | `EventBus` |
| `bp.queue_depth.gauge` | gauge | `BackpressureController` |

Note: a dedicated `PrometheusExporter` convenience class does not yet exist as
a separate export. Use `MetricsExporter` with `type: 'prometheus'` as shown
above.

### EventBus as an audit log

`EventBus` is a typed, cluster-wide event stream backed by PubSub and
optionally by WAL. Wire it to emit business events (`client.joined`,
`counter.updated`, etc.) and subscribe from a separate audit consumer:

```typescript
const bus = new EventBus<MyEvents>(pubsub, nodeId, {
  topic: 'audit-events',
  walPath: '/app/data/audit.wal',  // durable — events survive restart
});
await bus.start();

bus.subscribe('client.joined', async (event) => {
  await auditLogger.write(event);
});
```

`EventBus.subscribeDurable()` replays from a stored checkpoint, useful for
audit consumers that process events at their own pace.

### Logging

The library uses `FrameworkLogger` (`src/common/logger.ts`) for internal
diagnostic output. Control verbosity via `LOG_LEVEL` (environment variable):
`debug`, `info`, `warn`, `error`. Default is `info`.

In the StatefulSet, `LOG_LEVEL` is set via the ConfigMap. Set it to `debug`
temporarily to trace ownership propagation or WAL replay during incidents.

---

## Capacity planning

These are rough guidance figures; profile your actual workload.

### Memory per node

Base overhead: ~10–30 MB for the Node.js runtime + library.

Per-entity in `InMemoryEntityRegistry`: ~200–400 bytes (entity metadata +
event listeners). For 10,000 entities: ~4 MB overhead.

Per open `DistributedSession`: ~1–10 KB depending on your state shape.
For 1,000 sessions at 5 KB each: ~5 MB.

Per connected client in `ConnectionRegistry`: ~200 bytes. For 10,000 clients:
~2 MB.

The StatefulSet manifest requests `128Mi` and limits at `512Mi` — appropriate
for small workloads. For 10,000+ sessions, increase the request to `512Mi` and
the limit to `1Gi` and monitor actual usage.

### WAL growth and compaction cadence

WAL entries are append-only. Every `create`, `update`, `delete`, and `transfer`
appends one record. Without compaction, the WAL grows without bound.

Compaction (`registry.compact()`) rewrites the WAL to one entry per surviving
entity. Run it:

- On a schedule (e.g. daily cron job or leader-triggered timer).
- When WAL file size exceeds your budget (monitor via filesystem metrics).
- Before taking a backup.

After compaction, WAL size = (surviving entity count) × (avg entry size).
With 1,000 entities and 200-byte entries, the compacted WAL is ~200 KB.

### Heartbeat overhead

`ClusterLeaderElection` renews its lease on a configurable interval
(`renewIntervalMs`, default typically 5 s). Each renewal is a lock acquire +
a PubSub message. For a 3-node cluster, this is ~3 messages per `renewIntervalMs`
across the cluster — negligible.

`ConnectionRegistry` TTLs trigger expiry checks internally. At 10,000
connections with a 120-second TTL, expiry sweeps are O(N) but run infrequently.

`EntityRegistrySyncAdapter` publishes one PubSub message per registry mutation.
At 1,000 mutations/second across the cluster, each node receives ~1,000
messages/second. Size per message depends on entity payload; plan for ~1–5 KB
per message.

---

## Upgrades

### Rolling restart during a lease window

To avoid leadership gaps during a rolling deploy:

1. Wait until the current leader has recently renewed its lease (within the last
   `renewIntervalMs`).
2. Begin the rolling restart (`kubectl rollout restart statefulset/...`).
3. `maxUnavailable: 1` ensures only one Pod restarts at a time; the remaining
   two nodes hold quorum.
4. When the leader Pod is replaced, the lease expires and surviving nodes elect a
   new leader within `leaseDurationMs + renewIntervalMs`.

If your application is sensitive to leader gaps, increase `leaseDurationMs`
before the deploy and reduce it after.

### Compatibility across versions

distributed-core does not yet have a formal compatibility policy. The library is
pre-1.0. As a practical guide:

- **Patch versions**: no breaking changes. Safe to roll one Pod at a time.
- **Minor versions**: may add new event types or metric names; existing
  contracts should be stable. Test with a single Pod before rolling the cluster.
- **Major versions** (when they occur): assume breaking changes in primitives
  and event shapes. Perform a full cluster drain and restart rather than a
  rolling update.

Cross-version clusters (different versions on different Pods simultaneously)
are a best-effort situation. PubSub message formats are plain JSON; as long
as new fields are additive and old fields are not removed, cross-version
delivery usually works. Do not run cross-version clusters in production for
more than one rolling-update window.

---

## Security

### SignedPubSubManager for message authentication

By default, any node that can write to the PubSub bus can inject arbitrary
ownership updates. `SignedPubSubManager` wraps any `PubSubManager` and HMAC-signs
every outgoing message; incoming messages with invalid or missing signatures are
rejected:

```typescript
import { SignedPubSubManager } from 'distributed-core';
import { KeyManager } from 'distributed-core';

const keyManager = new KeyManager({ privateKeyPath: '/run/secrets/node-key.pem' });
const signedPubSub = new SignedPubSubManager(rawPubSub, keyManager, {
  strictMode: true,  // reject all unsigned messages
});

// Pass signedPubSub to EntityRegistrySyncAdapter, EventBus, etc.
const sync = new EntityRegistrySyncAdapter(registry, signedPubSub, nodeId, {
  topic: 'entity-sync',
});
```

Each node needs its own key pair. Distribute public keys to all peers so they
can verify each other's signatures. Store private keys in Kubernetes Secrets,
not in ConfigMaps or container images.

### TLS for HTTP transport

`HttpForwardingTransport` (the default transport for `ForwardingRouter`) makes
plain HTTP POST requests to peer nodes. **distributed-core does not handle TLS.**

Terminate TLS at your ingress (e.g., Nginx, Envoy, or a service mesh like
Istio). For inter-Pod traffic inside a Kubernetes cluster, mTLS can be
transparently added by a service mesh without changing application code. If you
require encrypted peer-to-peer forwarding without a mesh, implement a custom
`ForwardingTransport` that wraps HTTPS and pass it to `ForwardingRouter`.

### Secrets in environment variables and Kubernetes Secrets

- Signing keys, TLS private keys, and any PubSub credentials must be stored in
  Kubernetes Secrets, not ConfigMaps.
- Reference them in the StatefulSet as `secretKeyRef` (analogous to
  `configMapKeyRef` in `statefulset.yaml`).
- Do not bake secrets into container images.
- Rotate secrets by updating the Kubernetes Secret and performing a rolling
  restart; Pods automatically pick up the new secret on restart.

---

## Feature gaps and productionization roadmap

The following gaps were identified while writing this guide:

1. **No built-in TLS for ForwardingRouter peer traffic.** Terminate at ingress
   or implement a custom `ForwardingTransport`. High priority for internal
   cluster traffic if you are not using a service mesh.

2. **No Prometheus scrape endpoint out of the box.** `MetricsExporter` can push
   to a Prometheus Pushgateway, but a pull-based `/metrics` HTTP endpoint
   (standard for Kubernetes + Prometheus scraping) does not exist yet. The
   metrics data model is ready; adding a `/metrics` route to `ForwardingServer`
   is a small addition.

3. **No built-in failure detection / heartbeat transport.** The library provides
   `FailureDetector` and `FailureDetectorBridge` but requires the caller to wire
   up actual heartbeating. In the cluster-collab example, failure is simulated
   manually. A WebSocket-based or PubSub-based heartbeat plugin would close this
   gap.

4. **No state bootstrap for joining nodes.** A new node joining a running cluster
   receives future updates but has no mechanism to request current state from
   peers. Applications that need this must implement a snapshot-transfer endpoint
   at the application layer.

5. **No adaptive quorum.** `QuorumDistributedLock` uses a fixed majority of the
   known membership set. If the membership set is stale (e.g. after a partition),
   both sides may independently reach "majority." Adaptive quorum (adjusting the
   threshold dynamically) is listed as a deferred follow-up in
   `docs/CLUSTER-READINESS-PLAN.md`.

6. **WAL compaction is not automatic.** `WriteAheadLogEntityRegistry.compact()`
   exists and works, but there is no built-in coordinator to trigger it on a
   schedule. Wire a leader-elected timer or an external cron job.
