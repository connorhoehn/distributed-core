/**
 * CollabNode.ts — the composition layer for the cluster-collab example.
 *
 * This file is the heart of the pedagogical example. It shows how six primitives
 * from distributed-core are wired together into one cohesive service:
 *
 *   1. EntityRegistry (InMemory)        — stores who owns what resource
 *   2. EntityRegistrySyncAdapter        — propagates registry mutations over PubSub
 *      so every node sees the same ownership picture
 *   3. ResourceRouter                   — "which node owns counter X?" / claim / release
 *   4. DistributedSession               — per-counter state lifecycle (create, apply, evict)
 *   5. SharedStateManager               — coordinates subscribe/apply/unsubscribe with
 *      cross-node pubsub fanout; wraps DistributedSession for ease of use
 *   6. AutoReclaimPolicy                — when a node dies, surviving nodes compete (with
 *      jitter) to reclaim its orphaned counters
 *   7. ConnectionRegistry               — tracks which clients are connected to this node
 *   8. EventBus                         — typed cluster-wide event stream (observability)
 *   9. MetricsRegistry                  — per-node counters / gauges / histograms
 *
 * The public API is intentionally thin:
 *   - clientJoin / clientLeave   — simulate WebSocket connect/disconnect
 *   - subscribeToCounter         — make a counter live on this node (or join remotely)
 *   - applyCounterUpdate         — mutate a locally-owned counter
 *   - getCounter                 — read current state from local view
 *
 * Nothing in this file is production-ready: there is no auth, no retry logic,
 * no persistence to disk. The goal is clarity of composition, not robustness.
 */

import { EventEmitter } from 'events';
import { EntityRegistryFactory } from '../../src/cluster/entity/EntityRegistryFactory';
import { EntityRegistry } from '../../src/cluster/entity/types';
import { EntityRegistrySyncAdapter } from '../../src/cluster/entity/EntityRegistrySyncAdapter';
import { ResourceRouter } from '../../src/routing/ResourceRouter';
import { DistributedSession } from '../../src/cluster/sessions/DistributedSession';
import { SharedStateManager } from '../../src/gateway/state/SharedStateManager';
import { AutoReclaimPolicy } from '../../src/routing/AutoReclaimPolicy';
import { ConnectionRegistry } from '../../src/connections/ConnectionRegistry';
import { EventBus } from '../../src/messaging/EventBus';
import { MetricsRegistry } from '../../src/monitoring/metrics/MetricsRegistry';

import { CounterAdapter } from './CounterAdapter';
import { CounterState, CounterUpdate, ClientSession, CollabNodeStats } from './types';

// ---------------------------------------------------------------------------
// The event map that CollabNode publishes over its local EventBus.
// Using a typed EventMap lets callers subscribe with full inference, e.g.:
//   bus.subscribe('client.joined', async (event) => { event.payload.clientId })
// ---------------------------------------------------------------------------

export type CollabEvents = {
  'client.joined':     { clientId: string; nodeId: string };
  'client.left':       { clientId: string; nodeId: string };
  'counter.updated':   { counterId: string; update: CounterUpdate; state: CounterState };
  'counter.evicted':   { counterId: string; reason: string };
};

// ---------------------------------------------------------------------------
// Minimal PubSub interface that CollabNode needs — satisfied by both
// the real PubSubManager and the SimulatedPubSub from the test harness.
// This avoids pulling in Transport/ClusterManager dependencies in the example.
// ---------------------------------------------------------------------------

export interface SimplePubSub {
  subscribe(
    topic: string,
    handler: (topic: string, payload: unknown, meta: { publisherNodeId: string; messageId: string; timestamp: number; topic: string }) => void
  ): string;
  unsubscribe(id: string): void;
  publish(topic: string, payload: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Minimal ClusterManager interface needed by ResourceRouter.
// In production this would be the real ClusterManager; in the demo we use
// FakeClusterManager from ClusterSimulator which satisfies this shape.
// ---------------------------------------------------------------------------

export interface SimpleClusterManager extends EventEmitter {
  getMembership(): Map<string, { id: string; status: string; lastSeen: number; version: number; lastUpdated: number; metadata?: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------
// CollabNode
// ---------------------------------------------------------------------------

export class CollabNode {
  // ---------------------------------------------------------------------------
  // Public primitives — exposed so run.ts can read stats, debug, or extend
  // ---------------------------------------------------------------------------
  readonly nodeId: string;
  readonly registry: EntityRegistry;         // shared registry for routing + sessions
  readonly connRegistry: EntityRegistry;     // separate registry for connection tracking
  readonly sync: EntityRegistrySyncAdapter;
  readonly router: ResourceRouter;
  readonly session: DistributedSession<CounterState, CounterUpdate>;
  readonly stateMgr: SharedStateManager<CounterState, CounterUpdate>;
  readonly connReg: ConnectionRegistry;
  readonly eventBus: EventBus<CollabEvents>;
  readonly autoReclaim: AutoReclaimPolicy;
  readonly metrics: MetricsRegistry;

  // ---------------------------------------------------------------------------
  // Private bookkeeping
  // ---------------------------------------------------------------------------
  private readonly clientSessions = new Map<string, ClientSession>();
  private updatesApplied = 0;
  private reclaimedCounters = 0;

  constructor(
    nodeId: string,
    pubsub: SimplePubSub,
    cluster: SimpleClusterManager,
  ) {
    this.nodeId = nodeId;
    this.metrics = new MetricsRegistry(nodeId);

    // -------------------------------------------------------------------------
    // PRIMITIVE 1: EntityRegistry
    // Each node owns its own in-memory registry. The registry is the authoritative
    // store for "which entity is owned by which node" on this node's view.
    //
    // We use two separate registries:
    //   - `registry`     — for resource routing / session ownership (the core one)
    //   - `connRegistry` — for connection tracking
    //
    // Separation is important because ConnectionRegistry.stop() calls
    // registry.stop() internally. If we shared one registry, stopping
    // ConnectionRegistry would pull the rug out from the router mid-teardown.
    // -------------------------------------------------------------------------
    this.registry = EntityRegistryFactory.createMemory(nodeId);
    this.connRegistry = EntityRegistryFactory.createMemory(`${nodeId}-conn`);

    // -------------------------------------------------------------------------
    // PRIMITIVE 2: EntityRegistrySyncAdapter
    // Bridges the registry to PubSub. Local mutations (claim/release) are
    // published to the 'entity-sync' topic; remote messages are applied back
    // to the registry. With one adapter, EVERY primitive that reads the same
    // registry automatically gets cross-node visibility.
    // -------------------------------------------------------------------------
    this.sync = new EntityRegistrySyncAdapter(
      this.registry as any,  // cast: EntityRegistry satisfies the adapter's interface
      pubsub as any,         // cast: SimplePubSub satisfies the adapter's interface
      nodeId,
      { topic: 'entity-sync' },
    );

    // -------------------------------------------------------------------------
    // PRIMITIVE 3: ResourceRouter
    // Answers "who owns counter X?", handles claims and releases, and emits
    // resource:orphaned when a node that owned resources leaves the cluster.
    // We pass ownsRouter:false to DistributedSession below so the router
    // lifecycle is managed here, not duplicated inside the session.
    // -------------------------------------------------------------------------
    this.router = new ResourceRouter(nodeId, this.registry, cluster as any, {
      metrics: this.metrics,
    });

    // -------------------------------------------------------------------------
    // PRIMITIVE 4: DistributedSession
    // Manages per-counter state (create, apply update, evict on idle timeout).
    // ownsRouter:false because we start/stop the router in CollabNode.start/stop.
    // -------------------------------------------------------------------------
    const adapter = new CounterAdapter();
    this.session = new DistributedSession<CounterState, CounterUpdate>(
      nodeId,
      this.router,
      adapter,
      {
        ownsRouter: false,      // router lifecycle is managed by CollabNode
        idleTimeoutMs: 60_000,  // evict idle counters after 1 minute
        metrics: this.metrics,
      },
    );

    // -------------------------------------------------------------------------
    // PRIMITIVE 5: SharedStateManager
    // Coordinates subscribe/apply/unsubscribe across nodes. When a client on
    // node B subscribes to counter 'c1' that lives on node A, SharedStateManager
    // sets up a cross-node PubSub subscription so B gets state updates.
    // Wraps DistributedSession so we don't have to reimplement pubsub fanout.
    // -------------------------------------------------------------------------
    this.stateMgr = new SharedStateManager<CounterState, CounterUpdate>(
      this.session,
      pubsub as any,  // cast: SimplePubSub satisfies PubSubManager's subscribe/publish contract
      adapter,
      { topicPrefix: 'counter-state' },
    );

    // -------------------------------------------------------------------------
    // PRIMITIVE 6: AutoReclaimPolicy
    // Listens for resource:orphaned events from ResourceRouter and re-claims
    // counters after a random jitter delay. The jitter is critical: without it,
    // all surviving nodes would race to claim at the same instant (thundering herd).
    // -------------------------------------------------------------------------
    this.autoReclaim = new AutoReclaimPolicy(this.router, {
      jitterMs: 300,           // up to 300ms random delay before attempting reclaim
      maxClaimAttempts: 2,     // retry once if the first claim attempt conflicts
    });

    // -------------------------------------------------------------------------
    // PRIMITIVE 7: ConnectionRegistry
    // Tracks which clients are "connected" to this node. In a real service this
    // would track WebSocket connections. Here it tracks our simulated clients.
    // Uses a dedicated `connRegistry` (not the shared routing registry) so that
    // ConnectionRegistry's internal lifecycle calls don't interfere with the
    // router's registry.
    // -------------------------------------------------------------------------
    this.connReg = new ConnectionRegistry(this.connRegistry, nodeId, {
      ttlMs: 120_000, // connections auto-expire after 2 minutes without heartbeat
      metrics: this.metrics,
    });

    // -------------------------------------------------------------------------
    // PRIMITIVE 8: EventBus
    // Typed cluster-wide event stream. Used here for observability — run.ts
    // subscribes to see events as they happen. In production you'd hook in
    // distributed tracing or alerting here.
    // -------------------------------------------------------------------------
    this.eventBus = new EventBus<CollabEvents>(pubsub as any, nodeId, {
      topic: `collab-events-${nodeId}`,
    });

    // Wire up AutoReclaim events so we can count reclaimed counters.
    //
    // IMPORTANT: AutoReclaimPolicy calls router.claim() which gives this node
    // ownership at the routing layer, but the DistributedSession's internal
    // state map is not yet populated — session.join() was never called for
    // the newly reclaimed counter on this node.
    //
    // We fix this by subscribing the counter via SharedStateManager using a
    // synthetic node-owned subscriber. stateMgr.subscribe() calls session.join()
    // internally; since the router now shows this node as owner, join() will try
    // to re-claim (which fails because we already own it) and then falls through
    // to create a fresh state entry in the sessions map.
    //
    // A synthetic subscriber ID (prefixed with `_reclaim:`) is used so we can
    // track and clean it up in clientLeave() if needed. For this demo we leave
    // it; the counter will get a real subscriber when a client subscribes later.
    this.autoReclaim.on('reclaim:succeeded', (handle: { resourceId: string }) => {
      this.reclaimedCounters++;
      const resourceId = handle.resourceId;
      // Release the ownership that AutoReclaim already established via the router,
      // then re-join via the session so the sessions map gets populated correctly.
      // We do this by releasing the claimed handle first so session.join() can
      // go through the normal "claim" path (not the "already local" fast path
      // which short-circuits before populating sessions).
      void (async () => {
        try {
          // Release the router-level claim so session.join() can re-claim
          // through its own path and populate the sessions map.
          await this.router.release(resourceId);
          // Now subscribe via stateMgr — this calls session.join() which
          // will claim the resource and create a sessions map entry.
          await this.stateMgr.subscribe(`_reclaim:${this.nodeId}`, resourceId);
        } catch {
          // Race condition: another node claimed it first; that's OK.
        }
      })();
    });

    // Forward session evictions to the EventBus for observability.
    this.session.on('session:evicted', (sessionId: string) => {
      void this.eventBus.publish('counter.evicted', {
        counterId: sessionId,
        reason: 'idle-timeout',
      });
    });

    // Forward session orphan events — these fire when a remote node died and
    // this node's router emitted resource:orphaned.
    this.session.on('session:orphaned', (sessionId: string) => {
      void this.eventBus.publish('counter.evicted', {
        counterId: sessionId,
        reason: 'node-failure',
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // Order matters: registry must be started before the router, the router
    // before the session, and the session before the state manager.
    await this.registry.start();
    this.sync.start();
    await this.router.start();
    await this.session.start();
    await this.stateMgr.start();
    await this.autoReclaim.start();
    await this.connReg.start();
    await this.eventBus.start();
  }

  async stop(): Promise<void> {
    // Reverse order: stop high-level abstractions first, then the primitives
    // they depend on.
    await this.eventBus.stop();
    await this.connReg.stop();
    await this.autoReclaim.stop();
    await this.stateMgr.stop();
    await this.session.stop();
    await this.router.stop();
    this.sync.stop();
    await this.registry.stop();
  }

  // ---------------------------------------------------------------------------
  // Client-facing API
  // ---------------------------------------------------------------------------

  /**
   * Register a client as "connected" to this node.
   * In a real system this is called when the WebSocket handshake completes.
   */
  async clientJoin(clientId: string): Promise<void> {
    await this.connReg.register(clientId, { joinedAt: Date.now() });

    this.clientSessions.set(clientId, {
      clientId,
      joinedAt: Date.now(),
      counterIds: new Set(),
    });

    void this.eventBus.publish('client.joined', {
      clientId,
      nodeId: this.nodeId,
    });
  }

  /**
   * Deregister a client — clean up all their counter subscriptions.
   * In a real system this is called on WebSocket close.
   */
  async clientLeave(clientId: string): Promise<void> {
    await this.stateMgr.onClientDisconnect(clientId);
    await this.connReg.unregister(clientId);
    this.clientSessions.delete(clientId);

    void this.eventBus.publish('client.left', {
      clientId,
      nodeId: this.nodeId,
    });
  }

  /**
   * Subscribe a client to a counter, returning the current state.
   *
   * If the counter does not yet exist anywhere in the cluster, this node creates
   * it (claims ownership). If it exists on another node, this node becomes a
   * follower and receives state updates via PubSub.
   *
   * This is the key composition moment: a single `subscribe` call implicitly
   * involves the EntityRegistry (who owns it?), the ResourceRouter (claim it if
   * local), the DistributedSession (manage state), and the SharedStateManager
   * (set up cross-node PubSub subscription if remote).
   */
  async subscribeToCounter(clientId: string, counterId: string): Promise<CounterState> {
    const session = this.clientSessions.get(clientId);
    if (session === undefined) {
      throw new Error(`Client ${clientId} is not connected to node ${this.nodeId}`);
    }

    const state = await this.stateMgr.subscribe(clientId, counterId);
    session.counterIds.add(counterId);
    return state;
  }

  /**
   * Apply an update to a locally-owned counter.
   *
   * Throws if the counter is not owned by this node — in a real system you
   * would forward the request to the owning node (via ForwardingRouter).
   * For this demo, run.ts is responsible for routing updates to the right node.
   */
  async applyCounterUpdate(counterId: string, update: CounterUpdate): Promise<void> {
    await this.stateMgr.applyUpdate(counterId, update);
    this.updatesApplied++;

    const state = await this.stateMgr.getSnapshot(counterId);
    if (state !== null) {
      void this.eventBus.publish('counter.updated', { counterId, update, state });
    }
  }

  /**
   * Read the current state of a counter from this node's local view.
   * Returns null if this node has never seen the counter.
   */
  getCounter(counterId: string): CounterState | null {
    return this.session.getState(counterId);
  }

  /**
   * Check whether this node is the owner (authoritative) of a counter.
   */
  isLocalCounter(counterId: string): boolean {
    return this.session.isLocal(counterId);
  }

  // ---------------------------------------------------------------------------
  // Observability
  // ---------------------------------------------------------------------------

  getStats(): CollabNodeStats {
    const sessionStats = this.session.getStats();
    const connStats = this.connReg.getStats();

    return {
      nodeId: this.nodeId,
      localCounters: sessionStats.localSessions,
      // followerCounters: SharedStateManager tracks these internally; we
      // approximate by subtracting local from total active.
      followerCounters: Math.max(0, this.stateMgr.getStats().activeSessions - sessionStats.localSessions),
      connectedClients: connStats.local,
      totalUpdatesApplied: this.updatesApplied,
      reclaimedCounters: this.reclaimedCounters,
    };
  }
}
