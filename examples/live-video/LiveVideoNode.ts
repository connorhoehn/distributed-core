/**
 * LiveVideoNode.ts — the composition layer for the live-video example.
 *
 * This is the structural counterpart of CollabNode in cluster-collab. It wires
 * nine primitives from distributed-core into a coherent "video room" service:
 *
 *   1. EntityRegistry (x3)         — routing, connections, locks each get their own
 *   2. EntityRegistrySyncAdapter   — propagates registry mutations over PubSub
 *   3. ResourceRouter              — owns per-room SFU assignment
 *   4. DistributedSession          — per-room state lifecycle
 *   5. SharedStateManager          — cross-node subscribe/apply/unsubscribe
 *   6. AutoReclaimPolicy           — re-assigns rooms on node death
 *   7. ConnectionRegistry          — tracks participants (allowReconnect: true)
 *   8. DistributedLock             — one-transcoder-per-stream mutual exclusion
 *   9. ClusterLeaderElection       — picks a room controller node
 *  10. EventBus                    — room lifecycle events
 *  11. MetricsRegistry             — per-room metrics (video.room:{roomId} namespace)
 *  12. TranscoderLock              — domain wrapper over DistributedLock (this example)
 *  13. StatsFirehose               — BackpressureController demo (this example)
 *
 * What this example proves:
 *   - ResourceRouter works for exclusive ownership (SFU assignment), not just
 *     shared-state routing like cluster-collab's counters.
 *   - DistributedLock + ClusterLeaderElection compose cleanly alongside a
 *     ResourceRouter on the same node without registry conflicts (separate
 *     registries prevent lifecycle interference).
 *   - ConnectionRegistry with allowReconnect:true handles the "participant
 *     reconnects after node failure" pattern without special-casing.
 *   - BackpressureController absorbs a 100 Hz stats firehose without starving
 *     the event loop.
 *
 * Nothing here is production-ready: no auth, no real WebRTC, no disk I/O.
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
import { DistributedLock } from '../../src/cluster/locks/DistributedLock';
import { ClusterLeaderElection } from '../../src/cluster/locks/ClusterLeaderElection';
import { EventBus } from '../../src/messaging/EventBus';
import { MetricsRegistry } from '../../src/monitoring/metrics/MetricsRegistry';
import { PubSubMessageMetadata } from '../../src/gateway/pubsub/types';
import { MembershipEntry } from '../../src/cluster/types';

import { RoomSession } from './RoomSession';
import { TranscoderLock } from './TranscoderLock';
import { StatsFirehose } from './StatsFirehose';
import { RoomState, RoomUpdate, StatsPacket, LiveVideoNodeStats } from './types';

// ---------------------------------------------------------------------------
// Minimal PubSub interface — mirrors CollabNode's pattern so run.ts can use
// the same SharedBus infrastructure.
// ---------------------------------------------------------------------------

export interface SimplePubSub {
  subscribe(
    topic: string,
    handler: (topic: string, payload: unknown, meta: PubSubMessageMetadata) => void,
  ): string;
  unsubscribe(id: string): void;
  publish(topic: string, payload: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Minimal ClusterManager interface — satisfies ResourceRouter's dependency
// without pulling in the full Transport/ClusterManager stack.
// ---------------------------------------------------------------------------

export interface SimpleClusterManager extends EventEmitter {
  getMembership(): Map<
    string,
    { id: string; status: string; lastSeen: number; version: number; lastUpdated: number; metadata?: Record<string, unknown> }
  >;
}

// ---------------------------------------------------------------------------
// Typed event map for the cluster-wide EventBus
// ---------------------------------------------------------------------------

export type VideoEvents = {
  'participant.joined':  { roomId: string; clientId: string; nodeId: string };
  'participant.left':    { roomId: string; clientId: string; nodeId: string };
  'transcoder.up':       { roomId: string; nodeId: string };
  'transcoder.down':     { roomId: string; nodeId: string };
  'room.created':        { roomId: string; nodeId: string };
  'room.reclaimed':      { roomId: string; newOwner: string };
};

// ---------------------------------------------------------------------------
// LiveVideoNode
// ---------------------------------------------------------------------------

export class LiveVideoNode {
  // ---------------------------------------------------------------------------
  // Public primitives — exposed for observability / testing
  // ---------------------------------------------------------------------------
  readonly nodeId: string;
  readonly metrics: MetricsRegistry;
  readonly router: ResourceRouter;
  readonly session: DistributedSession<RoomState, RoomUpdate>;
  readonly stateMgr: SharedStateManager<RoomState, RoomUpdate>;
  readonly connReg: ConnectionRegistry;
  readonly transcoderLock: TranscoderLock;
  readonly election: ClusterLeaderElection;
  readonly eventBus: EventBus<VideoEvents>;
  readonly firehose: StatsFirehose;
  readonly autoReclaim: AutoReclaimPolicy;

  // ---------------------------------------------------------------------------
  // Private registries — kept separate to prevent lifecycle interference
  // ---------------------------------------------------------------------------
  private readonly routingRegistry: EntityRegistry;
  private readonly connRegistry: EntityRegistry;
  private readonly lockRegistry: EntityRegistry;
  private readonly electionRegistry: EntityRegistry;
  private readonly sync: EntityRegistrySyncAdapter;
  private readonly lockSync: EntityRegistrySyncAdapter;
  private readonly lock: DistributedLock;
  private readonly electionRouter: ResourceRouter;

  // ---------------------------------------------------------------------------
  // Private bookkeeping
  // ---------------------------------------------------------------------------
  private reclaimedRooms = 0;

  constructor(
    nodeId: string,
    pubsub: SimplePubSub,
    cluster: SimpleClusterManager,
  ) {
    this.nodeId = nodeId;

    // -------------------------------------------------------------------------
    // MetricsRegistry — node-scoped; room-scoped children are created ad-hoc
    // in LiveVideoNode operations.
    // -------------------------------------------------------------------------
    this.metrics = new MetricsRegistry(nodeId);

    // -------------------------------------------------------------------------
    // EntityRegistries — four separate registries:
    //   routingRegistry   — room ownership (ResourceRouter + DistributedSession)
    //   connRegistry      — participant connections (ConnectionRegistry)
    //   lockRegistry      — transcoder mutual exclusion (DistributedLock)
    //   electionRegistry  — room-controller leader election (ClusterLeaderElection)
    //
    // OBSERVATION: Having four registries is a consequence of each stateful
    // primitive (ConnectionRegistry, DistributedLock, ClusterLeaderElection)
    // calling registry.stop() internally. Sharing a single registry would cause
    // one primitive's teardown to pull the rug from the others. The library
    // would benefit from a "shared-registry" mode where stop() is a no-op.
    // -------------------------------------------------------------------------
    this.routingRegistry = EntityRegistryFactory.createMemory(nodeId);
    this.connRegistry = EntityRegistryFactory.createMemory(`${nodeId}-conn`);
    this.lockRegistry = EntityRegistryFactory.createMemory(`${nodeId}-lock`);
    this.electionRegistry = EntityRegistryFactory.createMemory(`${nodeId}-election`);

    // -------------------------------------------------------------------------
    // EntityRegistrySyncAdapter x2 — one for room routing, one for locks.
    //
    // The lock registry needs its own cross-node sync so DistributedLock can
    // implement real mutual exclusion: when node-A calls proposeEntity("foo"),
    // that must be visible to node-B BEFORE node-B calls proposeEntity("foo"),
    // otherwise both see an empty registry and both believe they won.
    //
    // OBSERVATION: The need for TWO separate SyncAdapters (one per registry)
    // to get two independently-lifecycled but both cross-node-visible primitives
    // is non-obvious. A higher-level "shared namespace" abstraction that lets
    // multiple primitives share one sync channel while retaining independent
    // stop() semantics would reduce this boilerplate.
    // -------------------------------------------------------------------------
    this.sync = new EntityRegistrySyncAdapter(
      this.routingRegistry as any,
      pubsub as any,
      nodeId,
      { topic: 'video-entity-sync' },
    );
    this.lockSync = new EntityRegistrySyncAdapter(
      this.lockRegistry as any,
      pubsub as any,
      nodeId,
      { topic: 'video-lock-sync' },
    );

    // -------------------------------------------------------------------------
    // ResourceRouter — "which node owns room X?"
    // Used for SFU assignment: when a room is created, its owner node runs the
    // mixing/forwarding logic for that room's participants.
    // -------------------------------------------------------------------------
    this.router = new ResourceRouter(nodeId, this.routingRegistry, cluster as any, {
      metrics: this.metrics,
    });

    // -------------------------------------------------------------------------
    // DistributedSession — per-room state lifecycle.
    // ownsRouter:false because we manage the router's lifecycle here.
    // idleTimeoutMs:30_000 — a room with no activity for 30s is evicted.
    // -------------------------------------------------------------------------
    const roomAdapter = new RoomSession();
    this.session = new DistributedSession<RoomState, RoomUpdate>(
      nodeId,
      this.router,
      roomAdapter,
      {
        ownsRouter: false,
        idleTimeoutMs: 30_000,
        metrics: this.metrics,
      },
    );

    // -------------------------------------------------------------------------
    // SharedStateManager — cross-node subscribe/apply for room state.
    // -------------------------------------------------------------------------
    this.stateMgr = new SharedStateManager<RoomState, RoomUpdate>(
      this.session,
      pubsub as any,
      roomAdapter,
      { topicPrefix: 'room-state' },
    );

    // -------------------------------------------------------------------------
    // AutoReclaimPolicy — re-assigns rooms when a node dies.
    // jitterMs:500 means up to 500ms random delay before re-claiming, which
    // prevents all surviving nodes from racing simultaneously.
    // -------------------------------------------------------------------------
    this.autoReclaim = new AutoReclaimPolicy(this.router, {
      jitterMs: 500,
      maxClaimAttempts: 2,
    });

    // Wire up reclaim success: release router-level claim then re-join via
    // stateMgr so the sessions map is populated (same pattern as CollabNode).
    this.autoReclaim.on('reclaim:succeeded', (handle: { resourceId: string }) => {
      this.reclaimedRooms++;
      const roomId = handle.resourceId;
      void (async () => {
        try {
          await this.router.release(roomId);
          await this.stateMgr.subscribe(`_reclaim:${this.nodeId}`, roomId);
          void this.eventBus.publish('room.reclaimed', {
            roomId,
            newOwner: this.nodeId,
          });
        } catch {
          // Another node won the race; that is fine.
        }
      })();
    });

    // Forward session evictions to metrics.
    this.session.on('session:evicted', (sessionId: string) => {
      this.metrics.counter('room.evicted.count').inc();
      this.metrics.gauge('video.room.active.gauge').dec();
      void sessionId; // suppress unused warning
    });

    // -------------------------------------------------------------------------
    // ConnectionRegistry — tracks participants with allowReconnect:true.
    // The "reconnect" case is critical for streaming: when node failure
    // triggers participant re-connection to a surviving node, the clientId is
    // the same but the connection is new. Without allowReconnect, register()
    // would throw on the duplicate id.
    // -------------------------------------------------------------------------
    this.connReg = new ConnectionRegistry(this.connRegistry, nodeId, {
      ttlMs: 60_000,  // participants auto-expire after 1 minute without heartbeat
      allowReconnect: true,
      metrics: this.metrics,
    });

    // -------------------------------------------------------------------------
    // DistributedLock — used by TranscoderLock for mutual exclusion.
    // Each node has its own DistributedLock instance backed by its own registry.
    // -------------------------------------------------------------------------
    this.lock = new DistributedLock(this.lockRegistry, nodeId, {
      defaultTtlMs: 10_000,
      acquireTimeoutMs: 2_000,
      metrics: this.metrics,
    });

    // -------------------------------------------------------------------------
    // TranscoderLock — domain wrapper over DistributedLock.
    // -------------------------------------------------------------------------
    this.transcoderLock = new TranscoderLock(this.lock);

    // -------------------------------------------------------------------------
    // ClusterLeaderElection — picks one node as "room controller".
    // The room controller is responsible for global decisions (e.g., choosing
    // which rooms to create, garbage-collecting empty rooms). We use a separate
    // router + registry for the election so its lifecycle is independent.
    //
    // OBSERVATION: ClusterLeaderElection calls router.start() in its own
    // start() method. If we reuse the main router, this would double-start it.
    // Forcing callers to pass a pre-built router (rather than, say, a PubSub
    // reference) makes the ownership contract ambiguous — the election "owns"
    // the router it receives, which conflicts with external lifecycle management.
    // -------------------------------------------------------------------------
    this.electionRouter = new ResourceRouter(
      nodeId,
      this.electionRegistry,
      cluster as any,
    );
    this.election = new ClusterLeaderElection(
      'video-room-controller',
      nodeId,
      this.lock,
      this.electionRouter,
      {
        leaseDurationMs: 10_000,
        renewIntervalMs: 3_000,
      },
    );

    // -------------------------------------------------------------------------
    // EventBus — room lifecycle events.
    // Each node gets its own topic to avoid cross-node event storms in the demo.
    // In production you'd use a single cluster-wide topic.
    // -------------------------------------------------------------------------
    this.eventBus = new EventBus<VideoEvents>(pubsub as any, nodeId, {
      topic: `video-events-${nodeId}`,
    });

    // -------------------------------------------------------------------------
    // StatsFirehose — BackpressureController demo.
    // -------------------------------------------------------------------------
    this.firehose = new StatsFirehose(this.metrics);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // Start order: registries -> sync -> router -> session -> stateMgr ->
    //              autoReclaim -> connReg -> election -> eventBus -> firehose
    await this.routingRegistry.start();
    await this.lockRegistry.start();
    // connRegistry and electionRegistry are started by ConnectionRegistry
    // and ClusterLeaderElection internally.
    this.sync.start();
    this.lockSync.start();
    await this.router.start();
    await this.session.start();
    await this.stateMgr.start();
    await this.autoReclaim.start();
    await this.connReg.start();
    await this.election.start();
    await this.eventBus.start();
    await this.firehose.start();
  }

  async stop(): Promise<void> {
    // Reverse order: high-level first, primitives last.
    await this.firehose.stop();
    await this.eventBus.stop();
    await this.election.stop();
    await this.connReg.stop();
    await this.autoReclaim.stop();
    await this.stateMgr.stop();
    await this.session.stop();
    await this.router.stop();
    this.sync.stop();
    this.lockSync.stop();
    await this.lockRegistry.stop();
    await this.routingRegistry.stop();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a room on this node (claims ownership via ResourceRouter).
   * Throws if the room already exists somewhere in the cluster.
   */
  async createRoom(roomId: string): Promise<void> {
    const sessionInfo = await this.session.join(roomId);
    if (!sessionInfo.isLocal) {
      // The placement strategy selected a different node; in a real system we'd
      // forward. For this example we accept local placement only.
      throw new Error(
        `Room ${roomId} placed on remote node ${sessionInfo.ownerNodeId}; cannot create locally`,
      );
    }

    // Set the roomId field in state (createState() leaves it blank).
    // hydrate() overwrites the state after join() creates the session entry.
    this.session.hydrate(roomId, {
      roomId,
      participants: new Set(),
      transcoderLocked: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });

    this.metrics.counter('room.created.count').inc();
    this.metrics.gauge('video.room.active.gauge').inc();
    this.metrics.child(`video.room.${roomId}`).gauge('participants.gauge').set(0);

    void this.eventBus.publish('room.created', { roomId, nodeId: this.nodeId });

    // Attempt to become the transcoder for this room's primary stream.
    const transHandle = await this.transcoderLock.tryBecomeTranscoder(roomId);
    if (transHandle !== null) {
      await this.stateMgr.applyUpdate(roomId, { kind: 'transcoder-up' });
      void this.eventBus.publish('transcoder.up', { roomId, nodeId: this.nodeId });
    }
  }

  /**
   * Register a participant as watching/broadcasting in a room.
   * Uses ConnectionRegistry (with allowReconnect) to track the participant,
   * then applies a state update to the room.
   */
  async joinRoom(roomId: string, clientId: string): Promise<void> {
    // ConnectionRegistry handles first-join and reconnect transparently.
    await this.connReg.register(clientId, { roomId, joinedAt: Date.now() });

    // Apply state update to the room — the owning node will serialize and
    // propagate to followers via SharedStateManager.
    try {
      await this.stateMgr.applyUpdate(roomId, { kind: 'participant-joined', clientId });
    } catch {
      // Room not yet local (mid-reclaim) — record silently.
    }

    this.metrics.child(`video.room.${roomId}`).gauge('participants.gauge').inc();
    void this.eventBus.publish('participant.joined', {
      roomId,
      clientId,
      nodeId: this.nodeId,
    });
  }

  /**
   * Remove a participant from a room.
   */
  async leaveRoom(roomId: string, clientId: string): Promise<void> {
    await this.connReg.unregister(clientId);

    try {
      await this.stateMgr.applyUpdate(roomId, { kind: 'participant-left', clientId });
    } catch {
      // Room gone mid-teardown; ignore.
    }

    this.metrics.child(`video.room.${roomId}`).gauge('participants.gauge').dec();
    void this.eventBus.publish('participant.left', {
      roomId,
      clientId,
      nodeId: this.nodeId,
    });
  }

  /**
   * Record a simulated WebRTC stats packet.
   * Hands off to StatsFirehose (BackpressureController) immediately so the
   * caller is never blocked by downstream processing.
   */
  recordStats(
    roomId: string,
    clientId: string,
    bitrate: number,
    packetLoss: number,
  ): void {
    const packet: StatsPacket = {
      roomId,
      clientId,
      timestamp: Date.now(),
      bitrate,
      packetLoss,
    };
    this.firehose.record(packet);
  }

  /**
   * Read the current state of a room from this node's local view.
   * Returns null if this node has never seen the room.
   */
  getRoom(roomId: string): RoomState | null {
    return this.session.getState(roomId);
  }

  /**
   * List all rooms owned by this node.
   */
  listLocalRooms(): RoomState[] {
    return this.session
      .getLocalSessions()
      .map(({ state }) => state);
  }

  /**
   * Returns whether this node is the owner of a room.
   */
  isLocalRoom(roomId: string): boolean {
    return this.session.isLocal(roomId);
  }

  /**
   * Trigger node-failure cleanup from outside (called by run.ts to simulate
   * FailureDetectorBridge behaviour without the full Transport stack).
   */
  handleNodeLeft(deadNodeId: string): void {
    // Tell the router so resource:orphaned events fire for AutoReclaimPolicy.
    this.router.handleNodeLeft(deadNodeId);
    // Clean up participant connections owned by the dead node.
    void this.connReg.handleRemoteNodeFailure(deadNodeId);
    // Clean up any locks held by the dead node.
    this.lock.handleRemoteNodeFailure(deadNodeId);
  }

  getStats(): LiveVideoNodeStats {
    const sessionStats = this.session.getStats();
    const firehoseStats = this.firehose.getStats();

    return {
      nodeId: this.nodeId,
      localRooms: sessionStats.localSessions,
      totalParticipants: this.connReg.getLocalConnections().length,
      statsPacketsObserved: firehoseStats.observed,
      statsPacketsDropped: firehoseStats.dropped,
      transcoderLocksHeld: this.transcoderLock.heldCount,
      isRoomController: this.election.isLeader(),
    };
  }
}
