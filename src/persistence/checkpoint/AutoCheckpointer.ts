import { WALWriterImpl } from '../wal/WALWriter';
import { CheckpointWriter } from './types';
import { EntityState } from './types';

export interface AutoCheckpointerConfig {
  /** Trigger checkpoint after this many WAL appends since last checkpoint. 0 = disabled. */
  lsnThreshold?: number;
  /** Trigger checkpoint on a time interval (ms). 0 = disabled. */
  intervalMs?: number;
}

export type SnapshotProvider = () => { lsn: number; entities: Record<string, EntityState> };

/**
 * Standalone component that automatically triggers checkpoints based on
 * LSN count thresholds and/or time intervals.
 *
 * Usage:
 *   const auto = new AutoCheckpointer(walWriter, checkpointWriter, snapshotFn, { lsnThreshold: 100 });
 *   auto.start();
 *   // ... writes happen on walWriter ...
 *   auto.stop();
 */
export class AutoCheckpointer {
  private config: Required<AutoCheckpointerConfig>;
  private walWriter: WALWriterImpl;
  private checkpointWriter: CheckpointWriter;
  private snapshotProvider: SnapshotProvider;

  private appendsSinceCheckpoint: number = 0;
  private unsubscribe: (() => void) | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private running: boolean = false;
  private checkpointInProgress: boolean = false;

  constructor(
    walWriter: WALWriterImpl,
    checkpointWriter: CheckpointWriter,
    snapshotProvider: SnapshotProvider,
    config: AutoCheckpointerConfig = {}
  ) {
    this.walWriter = walWriter;
    this.checkpointWriter = checkpointWriter;
    this.snapshotProvider = snapshotProvider;
    this.config = {
      lsnThreshold: config.lsnThreshold !== undefined ? config.lsnThreshold : 1000,
      intervalMs: config.intervalMs !== undefined ? config.intervalMs : 0,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.appendsSinceCheckpoint = 0;

    // Subscribe to WAL appends for threshold-based checkpointing
    if (this.config.lsnThreshold > 0) {
      this.unsubscribe = this.walWriter.onAppend((_lsn: number) => {
        this.appendsSinceCheckpoint++;
        if (this.appendsSinceCheckpoint >= this.config.lsnThreshold) {
          this.triggerCheckpoint();
        }
      });
    }

    // Set up interval-based checkpointing
    if (this.config.intervalMs > 0) {
      this.intervalTimer = setInterval(() => {
        if (this.appendsSinceCheckpoint > 0) {
          this.triggerCheckpoint();
        }
      }, this.config.intervalMs);
      this.intervalTimer.unref();
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /** Manually trigger a checkpoint. Safe to call even if one is already in progress. */
  async triggerCheckpoint(): Promise<void> {
    if (this.checkpointInProgress) return;
    this.checkpointInProgress = true;
    try {
      const snapshot = this.snapshotProvider();
      await this.checkpointWriter.writeSnapshot(snapshot.lsn, snapshot.entities);
      this.appendsSinceCheckpoint = 0;
    } finally {
      this.checkpointInProgress = false;
    }
  }

  getAppendsSinceCheckpoint(): number {
    return this.appendsSinceCheckpoint;
  }

  isRunning(): boolean {
    return this.running;
  }
}
