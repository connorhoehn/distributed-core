import { LifecycleAware } from '../../common/LifecycleAware';
import { FailureDetector } from '../../monitoring/FailureDetector';
import { PubSubManager } from '../../gateway/pubsub/PubSubManager';
import { PubSubMessageMetadata } from '../../gateway/pubsub/types';

const DEFAULT_TOPIC = 'cluster.heartbeat';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;

export interface PubSubHeartbeatSourceConfig {
  /**
   * PubSub topic for heartbeat announcements.
   * Default: 'cluster.heartbeat'.
   */
  topic?: string;

  /**
   * Interval at which this node publishes its own heartbeat.
   * Default: 1000ms.
   */
  heartbeatIntervalMs?: number;

  /**
   * Optional extra payload attached to every heartbeat. Useful for piggyback
   * data (load averages, region, etc.). Default: {}.
   */
  payloadBuilder?: () => Record<string, unknown>;
}

export interface HeartbeatPayload {
  nodeId: string;
  timestamp: number;
  [key: string]: unknown;
}

export class PubSubHeartbeatSource implements LifecycleAware {
  private readonly topic: string;
  private readonly heartbeatIntervalMs: number;
  private readonly payloadBuilder: () => Record<string, unknown>;

  private _started = false;
  private subscriptionId: string | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly pubsub: PubSubManager,
    private readonly failureDetector: FailureDetector,
    private readonly localNodeId: string,
    config?: PubSubHeartbeatSourceConfig,
  ) {
    this.topic = config?.topic ?? DEFAULT_TOPIC;
    this.heartbeatIntervalMs = config?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.payloadBuilder = config?.payloadBuilder ?? (() => ({}));
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;

    // Subscribe to heartbeat topic; record activity for every remote heartbeat
    this.subscriptionId = this.pubsub.subscribe(
      this.topic,
      (topic: string, payload: unknown, metadata: PubSubMessageMetadata) => {
        if (metadata.publisherNodeId === this.localNodeId) {
          // Loop prevention: ignore our own heartbeats
          return;
        }
        this.failureDetector.recordNodeActivity(metadata.publisherNodeId);
      },
    );

    // Publish heartbeats on a fixed interval
    this.intervalHandle = setInterval(() => {
      this.publishHeartbeat();
    }, this.heartbeatIntervalMs);

    // Don't hold the process open
    this.intervalHandle.unref();
  }

  async stop(): Promise<void> {
    if (!this._started) return;
    this._started = false;

    // Clear the publish interval
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    // Unsubscribe from the heartbeat topic
    if (this.subscriptionId !== null) {
      this.pubsub.unsubscribe(this.subscriptionId);
      this.subscriptionId = null;
    }
  }

  isStarted(): boolean {
    return this._started;
  }

  private publishHeartbeat(): void {
    if (!this._started) return;

    const extra = this.payloadBuilder();
    const heartbeat: HeartbeatPayload = {
      nodeId: this.localNodeId,
      timestamp: Date.now(),
      ...extra,
    };

    // Fire-and-forget; errors on publish are not fatal for liveness
    void this.pubsub.publish(this.topic, heartbeat);
  }
}
