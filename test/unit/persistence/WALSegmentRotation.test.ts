import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { WALWriterImpl } from '../../../src/persistence/wal/WALWriter';
import { WALReaderImpl } from '../../../src/persistence/wal/WALReader';
import { EntityUpdate } from '../../../src/persistence/types';

function makeUpdate(id: string, i: number): EntityUpdate {
  return {
    entityId: id,
    changes: { value: `data-${i}`, padding: 'x'.repeat(50) },
    timestamp: Date.now(),
    version: i,
    operation: 'UPDATE',
  };
}

describe('WAL Segment Rotation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-seg-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('single segment works when data fits within maxFileSize', async () => {
    const writer = new WALWriterImpl({
      filePath: path.join(tmpDir, 'entity.wal'),
      maxFileSize: 10 * 1024 * 1024, // 10MB — won't be reached
      syncInterval: 0,
    });
    await writer.initialize();

    const lsns: number[] = [];
    for (let i = 0; i < 5; i++) {
      lsns.push(await writer.append(makeUpdate('e1', i)));
    }
    await writer.close();

    // Should still be a single segment
    expect(writer.getSegments()).toHaveLength(1);

    // Reader should see all entries
    const reader = new WALReaderImpl(path.join(tmpDir, 'entity.wal'));
    await reader.initialize();
    const entries = await reader.readAll();
    expect(entries).toHaveLength(5);
    expect(entries.map(e => e.logSequenceNumber)).toEqual(lsns);
    await reader.close();
  });

  test('rotates to new segment when maxFileSize is exceeded', async () => {
    // Use a very small maxFileSize to force rotation quickly
    const writer = new WALWriterImpl({
      filePath: path.join(tmpDir, 'entity.wal'),
      maxFileSize: 200, // 200 bytes — each entry is ~200+ bytes of JSON
      syncInterval: 0,
    });
    await writer.initialize();

    const totalEntries = 20;
    const lsns: number[] = [];
    for (let i = 0; i < totalEntries; i++) {
      lsns.push(await writer.append(makeUpdate('e1', i)));
    }
    await writer.close();

    // Should have more than one segment
    const segments = writer.getSegments();
    expect(segments.length).toBeGreaterThan(1);

    // All segment files should exist on disk
    for (const seg of segments) {
      const stat = await fs.stat(seg);
      expect(stat.isFile()).toBe(true);
    }

    // Reader should see all entries across segments, in LSN order
    const reader = new WALReaderImpl(path.join(tmpDir, 'entity.wal'));
    await reader.initialize();
    const entries = await reader.readAll();
    expect(entries).toHaveLength(totalEntries);
    expect(entries.map(e => e.logSequenceNumber)).toEqual(lsns);

    // Verify data integrity
    for (let i = 0; i < totalEntries; i++) {
      expect(entries[i].data.entityId).toBe('e1');
      expect(entries[i].data.version).toBe(i);
    }
    await reader.close();
  });

  test('readFrom across segments returns entries starting at given LSN', async () => {
    const writer = new WALWriterImpl({
      filePath: path.join(tmpDir, 'entity.wal'),
      maxFileSize: 200,
      syncInterval: 0,
    });
    await writer.initialize();

    const lsns: number[] = [];
    for (let i = 0; i < 15; i++) {
      lsns.push(await writer.append(makeUpdate('e1', i)));
    }
    await writer.close();

    expect(writer.getSegments().length).toBeGreaterThan(1);

    const reader = new WALReaderImpl(path.join(tmpDir, 'entity.wal'));
    await reader.initialize();

    // Read from a mid-point LSN
    const midLSN = lsns[7];
    const fromEntries: any[] = [];
    for await (const entry of reader.readFrom(midLSN)) {
      fromEntries.push(entry);
    }

    expect(fromEntries.length).toBe(lsns.length - 7);
    expect(fromEntries[0].logSequenceNumber).toBe(midLSN);
    await reader.close();
  });

  test('readRange across segments returns correct subset', async () => {
    const writer = new WALWriterImpl({
      filePath: path.join(tmpDir, 'entity.wal'),
      maxFileSize: 200,
      syncInterval: 0,
    });
    await writer.initialize();

    const lsns: number[] = [];
    for (let i = 0; i < 15; i++) {
      lsns.push(await writer.append(makeUpdate('e1', i)));
    }
    await writer.close();

    const reader = new WALReaderImpl(path.join(tmpDir, 'entity.wal'));
    await reader.initialize();

    const rangeEntries = await reader.readRange(lsns[3], lsns[10]);
    expect(rangeEntries.length).toBe(8); // inclusive on both ends
    expect(rangeEntries[0].logSequenceNumber).toBe(lsns[3]);
    expect(rangeEntries[rangeEntries.length - 1].logSequenceNumber).toBe(lsns[10]);
    await reader.close();
  });

  test('getLastSequenceNumber works across segments', async () => {
    const writer = new WALWriterImpl({
      filePath: path.join(tmpDir, 'entity.wal'),
      maxFileSize: 200,
      syncInterval: 0,
    });
    await writer.initialize();

    const lsns: number[] = [];
    for (let i = 0; i < 10; i++) {
      lsns.push(await writer.append(makeUpdate('e1', i)));
    }
    await writer.close();

    const reader = new WALReaderImpl(path.join(tmpDir, 'entity.wal'));
    await reader.initialize();
    const lastLSN = await reader.getLastSequenceNumber();
    expect(lastLSN).toBe(lsns[lsns.length - 1]);
    await reader.close();
  });

  test('writer re-initializes and discovers existing segments', async () => {
    // First writer creates segments
    const writer1 = new WALWriterImpl({
      filePath: path.join(tmpDir, 'entity.wal'),
      maxFileSize: 200,
      syncInterval: 0,
    });
    await writer1.initialize();
    for (let i = 0; i < 10; i++) {
      await writer1.append(makeUpdate('e1', i));
    }
    await writer1.close();
    const segCount1 = writer1.getSegments().length;

    // Second writer should discover existing segments and continue from last
    const writer2 = new WALWriterImpl({
      filePath: path.join(tmpDir, 'entity.wal'),
      maxFileSize: 200,
      syncInterval: 0,
    });
    await writer2.initialize();
    expect(writer2.getSegments().length).toBe(segCount1);
    expect(writer2.getCurrentLSN()).toBe(10);

    // Append more and verify continuity
    const newLSN = await writer2.append(makeUpdate('e1', 10));
    expect(newLSN).toBe(11);
    await writer2.close();

    // Reader should see all 11 entries
    const reader = new WALReaderImpl(path.join(tmpDir, 'entity.wal'));
    await reader.initialize();
    const entries = await reader.readAll();
    expect(entries).toHaveLength(11);
    await reader.close();
  });
});
