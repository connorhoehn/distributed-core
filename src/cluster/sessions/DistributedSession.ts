import { EventEmitter } from 'events';
import { ResourceRouter } from '../../routing/ResourceRouter';
import { PlacementStrategy } from '../../routing/types';
import { SharedStateAdapter } from '../../gateway/state/types';
import { EvictionTimer } from '../../gateway/eviction/EvictionTimer';
import { ResourceHandle } from '../../routing/types';
import { MetricsRegistry } from '../../monitoring/metrics/MetricsRegistry';
import { LifecycleAware } from '../../common/LifecycleAware';
import { SessionNotLocalError } from '../../common/errors';

export interface DistributedSessionConfig {
  idleTimeoutMs?: number;
  placement?: PlacementStrategy;
  /**
   * If true (default), start()/stop() will also start/stop the router.
   * Set to false when the router is shared with other primitives so callers
   * can manage the router's lifecycle externally.
   */
  ownsRouter?: boolean;
  metrics?: MetricsRegistry;
}

export interface SessionInfo<S> {
  sessionId: string;
  ownerNodeId: string;
  state: S;
  isLocal: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

export class DistributedSession<S, U = unknown> extends EventEmitter implements LifecycleAware {
  private readonly localNodeId: string;
  private readonly router: ResourceRouter;
  private readonly adapter: SharedStateAdapter<S, U>;
  private readonly config: Required<Omit<DistributedSessionConfig, 'metrics'>>;
  private readonly metrics: MetricsRegistry | null;
  private readonly sessions = new Map<string, S>();
  private readonly eviction: EvictionTimer<string>;
  private _started = false;

  private readonly _onOrphaned: (handle: ResourceHandle) => void;

  constructor(
    localNodeId: string,
    router: ResourceRouter,
    adapter: SharedStateAdapter<S, U>,
    config?: DistributedSessionConfig
  ) {
    super();
    this.localNodeId = localNodeId;
    this.router = router;
    this.adapter = adapter;
    this.metrics = config?.metrics ?? null;
    this.config = {
      idleTimeoutMs: config?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      placement: config?.placement ?? { selectNode: (_rid, local) => local },
      ownsRouter: config?.ownsRouter ?? true,
    };
    this.eviction = new EvictionTimer<string>(this.config.idleTimeoutMs);

    this._onOrphaned = (handle: ResourceHandle) => {
      this.metrics?.counter('session.orphaned.count').inc();
      this.emit('session:orphaned', handle.resourceId);
    };
  }

  isStarted(): boolean {
    return this._started;
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this.router.on('resource:orphaned', this._onOrphaned);
    if (this.config.ownsRouter) {
      await this.router.start();
    }
  }

  async stop(): Promise<void> {
    if (!this._started) return;
    this._started = false;
    this.eviction.cancelAll();
    const owned = this.router.getOwnedResources();
    for (const handle of owned) {
      this.sessions.delete(handle.resourceId);
      await this.router.release(handle.resourceId);
    }
    this.router.off('resource:orphaned', this._onOrphaned);
    if (this.config.ownsRouter) {
      await this.router.stop();
    }
  }

  async join(sessionId: string): Promise<SessionInfo<S>> {
    const targetNodeId = this.router.selectNode(sessionId, this.config.placement);

    if (targetNodeId === this.localNodeId) {
      if (this.router.isLocal(sessionId)) {
        const existing = this.sessions.get(sessionId)!;
        return { sessionId, ownerNodeId: this.localNodeId, state: existing, isLocal: true };
      }

      try {
        await this.router.claim(sessionId);
      } catch {
        if (this.router.isLocal(sessionId)) {
          const existing = this.sessions.get(sessionId)!;
          return { sessionId, ownerNodeId: this.localNodeId, state: existing, isLocal: true };
        }
        const routeTarget = await this.router.route(sessionId);
        const ownerNodeId = routeTarget?.nodeId ?? targetNodeId;
        return {
          sessionId,
          ownerNodeId,
          state: this.adapter.createState(),
          isLocal: false,
        };
      }

      const state = this.adapter.createState();
      this.sessions.set(sessionId, state);
      this.eviction.schedule(sessionId, (sid) => {
        this.sessions.delete(sid);
        void this.router.release(sid);
        this.metrics?.counter('session.evicted.count').inc();
        this.metrics?.gauge('session.active.gauge').set(this.sessions.size);
        this.emit('session:evicted', sid);
      });
      this.metrics?.counter('session.created.count').inc();
      this.metrics?.gauge('session.active.gauge').set(this.sessions.size);
      this.emit('session:created', sessionId, state);
      return { sessionId, ownerNodeId: this.localNodeId, state, isLocal: true };
    }

    return {
      sessionId,
      ownerNodeId: targetNodeId,
      state: this.adapter.createState(),
      isLocal: false,
    };
  }

  async apply(sessionId: string, update: U): Promise<S> {
    if (!this.router.isLocal(sessionId)) {
      throw new SessionNotLocalError(sessionId);
    }
    const current = this.sessions.get(sessionId);
    if (current === undefined) {
      throw new SessionNotLocalError(sessionId);
    }
    const start = Date.now();
    const newState = this.adapter.applyUpdate(current, update);
    this.sessions.set(sessionId, newState);
    this.eviction.cancel(sessionId);
    this.eviction.schedule(sessionId, (sid) => {
      this.sessions.delete(sid);
      void this.router.release(sid);
      this.metrics?.counter('session.evicted.count').inc();
      this.metrics?.gauge('session.active.gauge').set(this.sessions.size);
      this.emit('session:evicted', sid);
    });
    this.metrics?.histogram('session.apply.latency_ms').observe(Date.now() - start);
    return newState;
  }

  getState(sessionId: string): S | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async leave(sessionId: string): Promise<void> {
    this.eviction.cancel(sessionId);
    this.sessions.delete(sessionId);
    await this.router.release(sessionId);
    this.metrics?.gauge('session.active.gauge').set(this.sessions.size);
  }

  get nodeId(): string {
    return this.localNodeId;
  }

  /**
   * Overwrite the state of a locally-owned session. Used by external hydration
   * (e.g., loading from a snapshot store after join()). Throws if the session is
   * not owned by this node.
   */
  hydrate(sessionId: string, state: S): void {
    if (!this.router.isLocal(sessionId)) {
      throw new SessionNotLocalError(sessionId);
    }
    this.sessions.set(sessionId, state);
  }

  isLocal(sessionId: string): boolean {
    return this.router.isLocal(sessionId);
  }

  getLocalSessions(): Array<{ sessionId: string; state: S }> {
    const result: Array<{ sessionId: string; state: S }> = [];
    for (const [sessionId, state] of this.sessions) {
      result.push({ sessionId, state });
    }
    return result;
  }

  getStats(): { localSessions: number; pendingEvictions: number } {
    return {
      localSessions: this.sessions.size,
      pendingEvictions: this.eviction.pendingCount,
    };
  }
}
