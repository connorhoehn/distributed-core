export interface GossipBackoffConfig {
  /** Initial delay in milliseconds before the first retry. Default: 100 */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds. Default: 30000 */
  maxDelayMs: number;
  /** Exponential growth factor applied per failure. Default: 2 */
  multiplier: number;
  /** Whether to add random jitter to computed delays. Default: true */
  jitter: boolean;
}

const DEFAULT_CONFIG: GossipBackoffConfig = {
  baseDelayMs: 100,
  maxDelayMs: 30000,
  multiplier: 2,
  jitter: true
};

/**
 * Tracks per-peer failure counts and computes exponential backoff delays for
 * gossip retries. When jitter is enabled the returned delay is a uniformly
 * random value in [delay/2, delay] so that a group of nodes recovering from
 * the same failure do not all retry at the same instant (thundering-herd
 * avoidance).
 */
export class GossipBackoff {
  private readonly config: GossipBackoffConfig;
  private readonly failureCounts = new Map<string, number>();

  constructor(config: Partial<GossipBackoffConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a successful delivery to the given peer and reset its backoff state.
   */
  recordSuccess(peerId: string): void {
    this.failureCounts.delete(peerId);
  }

  /**
   * Record a failed delivery attempt to the given peer, incrementing its
   * failure counter.
   */
  recordFailure(peerId: string): void {
    this.failureCounts.set(peerId, (this.failureCounts.get(peerId) ?? 0) + 1);
  }

  /**
   * Return the number of milliseconds the caller should wait before retrying
   * a message to `peerId`. Returns 0 if there are no recorded failures.
   *
   * The base formula is:
   *   delay = min(baseDelayMs * multiplier^(failures - 1), maxDelayMs)
   *
   * With jitter enabled the value is uniformly sampled from
   *   [delay / 2, delay]
   */
  getDelay(peerId: string): number {
    const failures = this.failureCounts.get(peerId) ?? 0;
    if (failures === 0) {
      return 0;
    }

    const { baseDelayMs, maxDelayMs, multiplier, jitter } = this.config;
    const exponential = baseDelayMs * Math.pow(multiplier, failures - 1);
    const capped = Math.min(exponential, maxDelayMs);

    if (!jitter) {
      return capped;
    }

    // Uniform jitter: random value in [capped/2, capped]
    return Math.floor(capped / 2 + Math.random() * (capped / 2));
  }

  /**
   * Reset the backoff state for a single peer (equivalent to recordSuccess but
   * semantically used to clear state without implying a successful delivery).
   */
  reset(peerId: string): void {
    this.failureCounts.delete(peerId);
  }

  /**
   * Reset all tracked peers, clearing all failure counts.
   */
  resetAll(): void {
    this.failureCounts.clear();
  }

  /**
   * Return the current failure count for a peer, or 0 if none recorded.
   */
  getFailureCount(peerId: string): number {
    return this.failureCounts.get(peerId) ?? 0;
  }
}
