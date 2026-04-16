import { WALEntry, CheckpointSnapshot } from '../types';
import { CheckpointReaderImpl } from '../checkpoint/CheckpointReader';
import { WALReaderImpl } from '../wal/WALReader';

export interface RecoveryResult {
  checkpointLSN: number | null;
  entriesReplayed: number;
  recoveredAt: Date;
}

/**
 * Coordinates startup recovery by reading the latest checkpoint and
 * replaying all WAL entries that follow it, restoring full state.
 */
export class RecoveryManager {
  private checkpointReader: CheckpointReaderImpl;
  private walReader: WALReaderImpl;

  constructor(checkpointReader: CheckpointReaderImpl, walReader: WALReaderImpl) {
    this.checkpointReader = checkpointReader;
    this.walReader = walReader;
  }

  /**
   * Recover state by reading the latest checkpoint and replaying
   * WAL entries that come after it.
   *
   * @param onEntry - Called for each replayed WAL entry so the caller can apply state changes.
   * @returns A RecoveryResult summarising what was recovered.
   */
  async recover(onEntry: (entry: WALEntry) => void): Promise<RecoveryResult> {
    // Step 1: Read the latest checkpoint
    const checkpoint: CheckpointSnapshot | null = await this.checkpointReader.readLatest();
    const checkpointLSN: number | null = checkpoint?.lsn ?? null;

    // Step 2: Determine the starting LSN for WAL replay.
    // If a checkpoint exists we replay entries *after* its LSN.
    // If no checkpoint exists we replay everything from the beginning.
    const replayFromLSN = checkpointLSN !== null ? checkpointLSN + 1 : 0;

    // Step 3: Replay WAL entries
    let entriesReplayed = 0;

    const iterator = this.walReader.readFrom(replayFromLSN);
    for await (const entry of iterator) {
      onEntry(entry);
      entriesReplayed++;
    }

    return {
      checkpointLSN,
      entriesReplayed,
      recoveredAt: new Date(),
    };
  }
}
