import { promises as fs } from 'fs';
import * as path from 'path';
import { RecoveryManager, RecoveryResult } from '../../../src/persistence/recovery/RecoveryManager';
import { WALWriterImpl } from '../../../src/persistence/wal/WALWriter';
import { WALReaderImpl } from '../../../src/persistence/wal/WALReader';
import { CheckpointWriterImpl } from '../../../src/persistence/checkpoint/CheckpointWriter';
import { CheckpointReaderImpl } from '../../../src/persistence/checkpoint/CheckpointReader';
import { WALEntry, EntityUpdate } from '../../../src/persistence/types';

describe('RecoveryManager', () => {
  const testDir = path.resolve(__dirname, '../../../test-data/recovery');
  // WALWriterImpl treats filePath's directory as the segment dir and writes wal-0.log, wal-1.log, etc.
  const walConfigPath = path.join(testDir, 'entity.wal');
  const walSegmentPath = path.join(testDir, 'wal-0.log');
  const checkpointDir = path.join(testDir, 'checkpoints');

  beforeEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(checkpointDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function makeUpdate(entityId: string, version: number): EntityUpdate {
    return {
      entityId,
      changes: { value: `v${version}` },
      timestamp: Date.now(),
      version,
      operation: 'UPDATE',
    };
  }

  it('should recover all entries when no checkpoint exists', async () => {
    const writer = new WALWriterImpl({ filePath: walConfigPath, syncInterval: 0 });
    await writer.initialize();
    await writer.append(makeUpdate('e1', 1));
    await writer.append(makeUpdate('e2', 1));
    await writer.append(makeUpdate('e3', 1));
    await writer.flush();
    await writer.close();

    // WALReaderImpl expects the actual segment file path
    const walReader = new WALReaderImpl(walSegmentPath);
    const checkpointReader = new CheckpointReaderImpl({ checkpointPath: checkpointDir });
    const manager = new RecoveryManager(checkpointReader, walReader);

    const replayed: WALEntry[] = [];
    const result = await manager.recover((entry) => replayed.push(entry));

    expect(result.checkpointLSN).toBeNull();
    expect(result.entriesReplayed).toBe(3);
    expect(result.recoveredAt).toBeInstanceOf(Date);
    expect(replayed).toHaveLength(3);

    // Verify ordering by LSN
    for (let i = 1; i < replayed.length; i++) {
      expect(replayed[i].logSequenceNumber).toBeGreaterThan(
        replayed[i - 1].logSequenceNumber
      );
    }

    await walReader.close();
  });

  it('should return empty result when no WAL entries and no checkpoint exist', async () => {
    const writer = new WALWriterImpl({ filePath: walConfigPath, syncInterval: 0 });
    await writer.initialize();
    await writer.close();

    const walReader = new WALReaderImpl(walSegmentPath);
    const checkpointReader = new CheckpointReaderImpl({ checkpointPath: checkpointDir });
    const manager = new RecoveryManager(checkpointReader, walReader);

    const replayed: WALEntry[] = [];
    const result = await manager.recover((entry) => replayed.push(entry));

    expect(result.checkpointLSN).toBeNull();
    expect(result.entriesReplayed).toBe(0);
    expect(replayed).toHaveLength(0);

    await walReader.close();
  });

  it('should replay only entries after checkpoint LSN', async () => {
    // Phase 1: write 3 entries
    const writer = new WALWriterImpl({ filePath: walConfigPath, syncInterval: 0 });
    await writer.initialize();

    const lsn1 = await writer.append(makeUpdate('e1', 1));
    const lsn2 = await writer.append(makeUpdate('e2', 1));
    const lsn3 = await writer.append(makeUpdate('e1', 2));
    await writer.flush();

    // Checkpoint at lsn3 (covers entries 1-3)
    const checkpointWriter = new CheckpointWriterImpl({ checkpointPath: checkpointDir });
    await checkpointWriter.writeSnapshot(lsn3, {
      'e1': {
        id: 'e1',
        state: { value: 'v2' },
        version: 2,
        hostNodeId: 'node-1',
        lastModified: Date.now(),
      },
      'e2': {
        id: 'e2',
        state: { value: 'v1' },
        version: 1,
        hostNodeId: 'node-1',
        lastModified: Date.now(),
      },
    });

    // Phase 2: write 2 more entries after checkpoint
    const lsn4 = await writer.append(makeUpdate('e3', 1));
    const lsn5 = await writer.append(makeUpdate('e2', 2));
    await writer.flush();
    await writer.close();

    // Recover -- reader points at the actual segment file
    const walReader = new WALReaderImpl(walSegmentPath);
    const checkpointReader = new CheckpointReaderImpl({ checkpointPath: checkpointDir });
    const manager = new RecoveryManager(checkpointReader, walReader);

    const replayed: WALEntry[] = [];
    const result = await manager.recover((entry) => replayed.push(entry));

    expect(result.checkpointLSN).toBe(lsn3);
    expect(result.entriesReplayed).toBe(2);
    expect(replayed).toHaveLength(2);

    // The two replayed entries should be the ones after the checkpoint
    expect(replayed[0].logSequenceNumber).toBe(lsn4);
    expect(replayed[1].logSequenceNumber).toBe(lsn5);

    // Verify correct order
    expect(replayed[0].logSequenceNumber).toBeLessThan(replayed[1].logSequenceNumber);

    // Verify entity ids
    expect(replayed[0].data.entityId).toBe('e3');
    expect(replayed[1].data.entityId).toBe('e2');

    await walReader.close();
  });
});
