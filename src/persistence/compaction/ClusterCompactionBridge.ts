import { EventEmitter } from 'events';
import { CompactionCoordinator } from './CompactionCoordinator';

export interface ClusterCompactionBridgeConfig {
  triggerOnMemberJoin?: boolean;       // default true
  triggerOnMemberLeave?: boolean;      // default true
  triggerOnMembershipUpdate?: boolean; // default false (too noisy)
  debounceMs?: number;                 // coalesce rapid churn, default 2000
}

export class ClusterCompactionBridge {
  private readonly cluster: EventEmitter;
  private readonly coordinator: CompactionCoordinator;
  private readonly config: Required<ClusterCompactionBridgeConfig>;
  private debounceTimer: NodeJS.Timeout | null = null;
  private attached = false;

  // Store bound handler references so we can removeListener later
  private readonly onMemberJoined: () => void;
  private readonly onMemberLeft: () => void;
  private readonly onMembershipUpdated: () => void;

  constructor(
    cluster: EventEmitter,
    coordinator: CompactionCoordinator,
    config: ClusterCompactionBridgeConfig = {}
  ) {
    this.cluster = cluster;
    this.coordinator = coordinator;
    this.config = {
      triggerOnMemberJoin: true,
      triggerOnMemberLeave: true,
      triggerOnMembershipUpdate: false,
      debounceMs: 2000,
      ...config
    };

    // Bind handlers once so we can remove them cleanly
    this.onMemberJoined = () => this.scheduleTrigger();
    this.onMemberLeft = () => this.scheduleTrigger();
    this.onMembershipUpdated = () => this.scheduleTrigger();
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;

    if (this.config.triggerOnMemberJoin) {
      // Listen on both canonical and legacy names — the real ClusterManager
      // dual-emits both, and test harnesses may emit only the legacy name.
      this.cluster.on('member:joined', this.onMemberJoined);
      this.cluster.on('member-joined', this.onMemberJoined);
    }
    if (this.config.triggerOnMemberLeave) {
      this.cluster.on('member:left', this.onMemberLeft);
      this.cluster.on('member-left', this.onMemberLeft);
    }
    if (this.config.triggerOnMembershipUpdate) {
      this.cluster.on('membership:updated', this.onMembershipUpdated);
      this.cluster.on('membership-updated', this.onMembershipUpdated);
    }
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;

    this.cluster.removeListener('member:joined', this.onMemberJoined);
    this.cluster.removeListener('member-joined', this.onMemberJoined);
    this.cluster.removeListener('member:left', this.onMemberLeft);
    this.cluster.removeListener('member-left', this.onMemberLeft);
    this.cluster.removeListener('membership:updated', this.onMembershipUpdated);
    this.cluster.removeListener('membership-updated', this.onMembershipUpdated);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  isAttached(): boolean {
    return this.attached;
  }

  private scheduleTrigger(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      try {
        await this.coordinator.triggerCompactionCheck();
      } catch {
        // Errors are non-fatal — compaction is best-effort
      }
    }, this.config.debounceMs);

    // Allow the process to exit even if the timer is pending
    if (this.debounceTimer.unref) {
      this.debounceTimer.unref();
    }
  }
}
