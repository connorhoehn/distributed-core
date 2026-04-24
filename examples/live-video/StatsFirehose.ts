/**
 * StatsFirehose.ts — BackpressureController demo for WebRTC stats at high rate.
 *
 * In a real SFU, every WebRTC participant sends RTCP Receiver Reports roughly
 * once per second, but the SFU aggregates stats at much higher frequency
 * (frame-level pacing, 100 Hz for quality adaptation). That creates a
 * "stats firehose" — far more packets than any downstream consumer can
 * process in real time.
 *
 * BackpressureController provides exactly the right knob: a bounded queue per
 * logical key (one key per room) with a drop strategy. We use 'drop-oldest'
 * so downstream always sees the freshest telemetry at the cost of some history.
 *
 * This file shows the composition:
 *   StatsPacket (domain type)
 *     -> BackpressureController (admission control)
 *       -> onFlush callback (would be real aggregation; here it counts packets)
 *
 * Primitive: BackpressureController (src/gateway/backpressure/BackpressureController.ts)
 */

import { BackpressureController } from '../../src/gateway/backpressure/BackpressureController';
import { MetricsRegistry } from '../../src/monitoring/metrics/MetricsRegistry';
import { StatsPacket } from './types';

// Empirically chosen: a 3-node cluster with 50 clients at 100 Hz produces
// ~1,666 packets/room/second. A queue of 200 items gives ~120ms of buffer
// before we start dropping — enough to absorb transient spikes.
const MAX_QUEUE_PER_ROOM = 200;

export class StatsFirehose {
  private readonly bp: BackpressureController<StatsPacket>;
  private totalObserved = 0;

  constructor(metrics: MetricsRegistry) {
    this.bp = new BackpressureController<StatsPacket>(
      // onFlush: called every flushIntervalMs with a batch of packets.
      // In production this would drive a stats aggregator or time-series DB.
      // Here we just count to verify the pipeline is exercised.
      async (_roomId: string, packets: StatsPacket[]) => {
        this.totalObserved += packets.length;
        metrics.counter('stats.flushed.count').inc(packets.length);
      },
      {
        maxQueueSize: MAX_QUEUE_PER_ROOM,
        strategy: 'drop-oldest', // always have fresh data; drop stale telemetry
        flushIntervalMs: 50,     // flush 20 times/second per room
        onDrop: (_key, _packet) => {
          metrics.counter('stats.dropped.count').inc();
        },
        metrics,
      },
    );
  }

  /**
   * Push a stats packet into the queue for its room.
   * Returns false and records a drop if the queue is full and 'drop-oldest'
   * displaces the head — the return value is informational only; the caller
   * should not block on it.
   */
  record(packet: StatsPacket): boolean {
    const result = this.bp.enqueue(packet.roomId, packet);
    return result.accepted;
  }

  async start(): Promise<void> {
    await this.bp.start();
  }

  async stop(): Promise<void> {
    // Drain remaining items before stopping so the final flush is counted.
    await this.bp.drain();
    await this.bp.stop();
  }

  getStats(): { observed: number; dropped: number; queueDepths: Record<string, number> } {
    const bpStats = this.bp.getStats();
    return {
      observed: this.totalObserved,
      dropped: bpStats.totalDropped,
      queueDepths: bpStats.queueDepths,
    };
  }
}
