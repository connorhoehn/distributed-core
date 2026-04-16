import { WALWriterImpl } from '../../../src/persistence/wal/WALWriter';
import { WALReaderImpl } from '../../../src/persistence/wal/WALReader';
import { CheckpointWriterImpl } from '../../../src/persistence/checkpoint/CheckpointWriter';
import { CheckpointReaderImpl } from '../../../src/persistence/checkpoint/CheckpointReader';
import { EntityUpdate, EntityState } from '../../../src/persistence/types';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('WAL -> Checkpoint -> Restart -> Recovery Cycle', () => {
  let tmpDir: string;
  let walFilePath: string;
  let checkpointDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-recovery-test-'));
    walFilePath = path.join(tmpDir, 'wal', 'test.wal');
    checkpointDir = path.join(tmpDir, 'checkpoints');
    await fs.mkdir(path.join(tmpDir, 'wal'), { recursive: true });
    await fs.mkdir(checkpointDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeUpdate(entityId: string, value: string, version: number): EntityUpdate {
    return {
      entityId,
      changes: { value },
      timestamp: Date.now(),
      version,
      operation: 'CREATE',
    };
  }

  it('should recover full state from checkpoint + WAL replay after restart', async () => {
    // -------------------------------------------------------
    // Phase 1: Write 10 WAL entries, checkpoint after entry 5
    // -------------------------------------------------------
    const writer = new WALWriterImpl({
      filePath: walFilePath,
      syncInterval: 0, // disable periodic sync for deterministic tests
    });
    await writer.initialize();

    // Track all updates so we can build expected state
    const allUpdates: { lsn: number; update: EntityUpdate }[] = [];

    // Write first 5 entries
    for (let i = 1; i <= 5; i++) {
      const update = makeUpdate(`entity-${i}`, `value-${i}`, i);
      const lsn = await writer.append(update);
      allUpdates.push({ lsn, update });
    }
    await writer.flush();

    // Build checkpoint state from the first 5 entries
    const checkpointLSN = allUpdates[4].lsn; // LSN of entry 5
    const checkpointEntities: Record<string, EntityState> = {};
    for (let i = 0; i < 5; i++) {
      const u = allUpdates[i].update;
      checkpointEntities[u.entityId] = {
        id: u.entityId,
        state: u.changes,
        version: u.version,
        lastModified: u.timestamp,
      };
    }

    const checkpointWriter = new CheckpointWriterImpl({
      checkpointPath: checkpointDir,
      keepHistory: 3,
    });
    await checkpointWriter.writeSnapshot(checkpointLSN, checkpointEntities);

    // Write 5 more entries (6-10) after the checkpoint
    for (let i = 6; i <= 10; i++) {
      const update = makeUpdate(`entity-${i}`, `value-${i}`, i);
      const lsn = await writer.append(update);
      allUpdates.push({ lsn, update });
    }
    await writer.flush();

    // -------------------------------------------------------
    // Phase 2: Simulate restart -- close the writer
    // -------------------------------------------------------
    await writer.close();

    // -------------------------------------------------------
    // Phase 3: Recovery -- read checkpoint then replay WAL
    // -------------------------------------------------------
    const checkpointReader = new CheckpointReaderImpl({
      checkpointPath: checkpointDir,
    });

    const snapshot = await checkpointReader.readLatest();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.lsn).toBe(checkpointLSN);

    // Checkpoint should contain exactly the first 5 entities
    const checkpointEntityIds = Object.keys(snapshot!.entities).sort();
    expect(checkpointEntityIds).toEqual([
      'entity-1', 'entity-2', 'entity-3', 'entity-4', 'entity-5',
    ]);

    // Verify checkpoint entity values
    for (let i = 1; i <= 5; i++) {
      const entity = snapshot!.entities[`entity-${i}`];
      expect(entity.state).toEqual({ value: `value-${i}` });
      expect(entity.version).toBe(i);
    }

    // Replay WAL entries AFTER the checkpoint LSN
    const walReader = new WALReaderImpl(walFilePath);
    await walReader.initialize();

    const replayedEntries: EntityUpdate[] = [];
    const entriesAfterCheckpoint: typeof allUpdates = [];

    for await (const entry of walReader.readFrom(checkpointLSN + 1)) {
      replayedEntries.push(entry.data);
      entriesAfterCheckpoint.push({ lsn: entry.logSequenceNumber, update: entry.data });
    }

    // Should replay exactly 5 entries (6-10)
    expect(replayedEntries).toHaveLength(5);

    const replayedEntityIds = replayedEntries.map(e => e.entityId).sort();
    expect(replayedEntityIds).toEqual([
      'entity-10', 'entity-6', 'entity-7', 'entity-8', 'entity-9',
    ]);

    // -------------------------------------------------------
    // Phase 4: Merge checkpoint + replayed WAL into recovered state
    // -------------------------------------------------------
    const recoveredState: Record<string, EntityState> = { ...snapshot!.entities };

    for (const entry of replayedEntries) {
      recoveredState[entry.entityId] = {
        id: entry.entityId,
        state: entry.changes,
        version: entry.version,
        lastModified: entry.timestamp,
      };
    }

    // Final recovered state should have all 10 entities
    const recoveredIds = Object.keys(recoveredState).sort();
    expect(recoveredIds).toHaveLength(10);
    expect(recoveredIds).toEqual([
      'entity-1', 'entity-10', 'entity-2', 'entity-3', 'entity-4',
      'entity-5', 'entity-6', 'entity-7', 'entity-8', 'entity-9',
    ]);

    // Verify every entity has the correct state
    for (let i = 1; i <= 10; i++) {
      const entity = recoveredState[`entity-${i}`];
      expect(entity).toBeDefined();
      expect(entity.id).toBe(`entity-${i}`);
      expect(entity.state).toEqual({ value: `value-${i}` });
      expect(entity.version).toBe(i);
    }

    await walReader.close();
  }, 10_000);

  it('should recover correctly using readRange for WAL entries after checkpoint', async () => {
    // This test uses readRange instead of readFrom, verifying both APIs work
    const checkpointReader = new CheckpointReaderImpl({
      checkpointPath: checkpointDir,
    });

    const snapshot = await checkpointReader.readLatest();
    expect(snapshot).not.toBeNull();

    const walReader = new WALReaderImpl(walFilePath);
    await walReader.initialize();

    const lastLSN = await walReader.getLastSequenceNumber();
    const rangeEntries = await walReader.readRange(snapshot!.lsn! + 1, lastLSN);

    expect(rangeEntries).toHaveLength(5);

    // Merge and verify
    const recoveredState: Record<string, EntityState> = { ...snapshot!.entities };
    for (const entry of rangeEntries) {
      recoveredState[entry.data.entityId] = {
        id: entry.data.entityId,
        state: entry.data.changes,
        version: entry.data.version,
        lastModified: entry.data.timestamp,
      };
    }

    expect(Object.keys(recoveredState)).toHaveLength(10);

    await walReader.close();
  }, 10_000);

  it('should recover correctly using replay() handler for WAL entries after checkpoint', async () => {
    // Re-create writer with new WAL + checkpoint to test replay() path
    const replayWalPath = path.join(tmpDir, 'wal-replay', 'test.wal');
    const replayCheckpointDir = path.join(tmpDir, 'checkpoints-replay');
    await fs.mkdir(path.join(tmpDir, 'wal-replay'), { recursive: true });
    await fs.mkdir(replayCheckpointDir, { recursive: true });

    const writer = new WALWriterImpl({
      filePath: replayWalPath,
      syncInterval: 0,
    });
    await writer.initialize();

    const lsns: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const lsn = await writer.append(makeUpdate(`item-${i}`, `data-${i}`, i));
      lsns.push(lsn);
    }
    await writer.flush();

    // Checkpoint at entry 5
    const cpLSN = lsns[4];
    const cpEntities: Record<string, EntityState> = {};
    for (let i = 1; i <= 5; i++) {
      cpEntities[`item-${i}`] = {
        id: `item-${i}`,
        state: { value: `data-${i}` },
        version: i,
        lastModified: Date.now(),
      };
    }

    const cpWriter = new CheckpointWriterImpl({
      checkpointPath: replayCheckpointDir,
      keepHistory: 3,
    });
    await cpWriter.writeSnapshot(cpLSN, cpEntities);
    await writer.close();

    // Recovery: read checkpoint, then use replay() for full WAL and skip entries <= cpLSN
    const cpReader = new CheckpointReaderImpl({ checkpointPath: replayCheckpointDir });
    const snap = await cpReader.readLatest();
    expect(snap).not.toBeNull();
    expect(snap!.lsn).toBe(cpLSN);

    const walReader = new WALReaderImpl(replayWalPath);
    await walReader.initialize();

    const recovered: Record<string, EntityState> = { ...snap!.entities };
    await walReader.replay(async (entry) => {
      // Only apply entries after the checkpoint LSN
      if (entry.logSequenceNumber > snap!.lsn!) {
        recovered[entry.data.entityId] = {
          id: entry.data.entityId,
          state: entry.data.changes,
          version: entry.data.version,
          lastModified: entry.data.timestamp,
        };
      }
    });

    expect(Object.keys(recovered)).toHaveLength(10);
    for (let i = 1; i <= 10; i++) {
      expect(recovered[`item-${i}`]).toBeDefined();
      expect(recovered[`item-${i}`].state).toEqual({ value: `data-${i}` });
    }

    await walReader.close();
  }, 10_000);
});
