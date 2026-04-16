import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { WALMetricsProvider } from '../../../../src/persistence/compaction/WALMetricsProvider';
import { CheckpointReaderImpl } from '../../../../src/persistence/checkpoint/CheckpointReader';
import { WALFileImpl } from '../../../../src/persistence/wal/WALFile';
import { WALEntry } from '../../../../src/persistence/types';

describe('WALMetricsProvider', () => {
  let tmpDir: string;
  let walDir: string;
  let checkpointDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-metrics-test-'));
    walDir = path.join(tmpDir, 'wal');
    checkpointDir = path.join(tmpDir, 'checkpoints');
    await fs.mkdir(walDir, { recursive: true });
    await fs.mkdir(checkpointDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeEntry(lsn: number, entityId: string, operation: string = 'UPDATE'): WALEntry {
    return {
      logSequenceNumber: lsn,
      timestamp: Date.now(),
      checksum: 'test-checksum',
      data: {
        entityId,
        changes: { value: lsn },
        timestamp: Date.now(),
        version: 1,
        operation
      }
    };
  }

  async function writeSegment(dir: string, segmentNum: number, entries: WALEntry[]): Promise<void> {
    const filePath = path.join(dir, `wal-${segmentNum}.log`);
    const walFile = new WALFileImpl(filePath);
    await walFile.open();
    for (const entry of entries) {
      await walFile.append(entry);
    }
    await walFile.flush();
    await walFile.close();
  }

  describe('getWALSegments', () => {
    test('should return empty array when no segments exist', async () => {
      const provider = new WALMetricsProvider(walDir);
      const segments = await provider.getWALSegments();
      expect(segments).toEqual([]);
    });

    test('should return empty array when directory does not exist', async () => {
      const provider = new WALMetricsProvider(path.join(tmpDir, 'nonexistent'));
      const segments = await provider.getWALSegments();
      expect(segments).toEqual([]);
    });

    test('should read segment files and return correct metadata', async () => {
      await writeSegment(walDir, 0, [
        makeEntry(1, 'entity-a'),
        makeEntry(2, 'entity-b'),
        makeEntry(3, 'entity-c')
      ]);
      await writeSegment(walDir, 1, [
        makeEntry(4, 'entity-d'),
        makeEntry(5, 'entity-e', 'DELETE')
      ]);

      const provider = new WALMetricsProvider(walDir);
      const segments = await provider.getWALSegments();

      expect(segments).toHaveLength(2);

      // Segment 0
      expect(segments[0].segmentId).toBe('segment-000');
      expect(segments[0].startLSN).toBe(1);
      expect(segments[0].endLSN).toBe(3);
      expect(segments[0].entryCount).toBe(3);
      expect(segments[0].tombstoneCount).toBe(0);
      expect(segments[0].sizeBytes).toBeGreaterThan(0);
      expect(segments[0].isImmutable).toBe(true);

      // Segment 1
      expect(segments[1].segmentId).toBe('segment-001');
      expect(segments[1].startLSN).toBe(4);
      expect(segments[1].endLSN).toBe(5);
      expect(segments[1].entryCount).toBe(2);
      expect(segments[1].tombstoneCount).toBe(1);
    });

    test('should ignore non-segment files', async () => {
      await writeSegment(walDir, 0, [makeEntry(1, 'entity-a')]);
      await fs.writeFile(path.join(walDir, 'metadata.json'), '{}');
      await fs.writeFile(path.join(walDir, 'random.txt'), 'hello');

      const provider = new WALMetricsProvider(walDir);
      const segments = await provider.getWALSegments();

      expect(segments).toHaveLength(1);
    });
  });

  describe('getWALMetrics', () => {
    test('should return zeroed metrics when no segments exist', async () => {
      const provider = new WALMetricsProvider(walDir);
      const metrics = await provider.getWALMetrics();

      expect(metrics.segmentCount).toBe(0);
      expect(metrics.totalSizeBytes).toBe(0);
      expect(metrics.oldestSegmentAge).toBe(0);
      expect(metrics.tombstoneRatio).toBe(0);
      expect(metrics.duplicateEntryRatio).toBe(0);
    });

    test('should compute correct aggregate metrics from real segments', async () => {
      await writeSegment(walDir, 0, [
        makeEntry(1, 'entity-a'),
        makeEntry(2, 'entity-b'),
        makeEntry(3, 'entity-a', 'DELETE') // tombstone + duplicate of entity-a
      ]);
      await writeSegment(walDir, 1, [
        makeEntry(4, 'entity-c'),
        makeEntry(5, 'entity-b') // duplicate of entity-b
      ]);

      const provider = new WALMetricsProvider(walDir);
      const metrics = await provider.getWALMetrics();

      expect(metrics.segmentCount).toBe(2);
      expect(metrics.totalSizeBytes).toBeGreaterThan(0);
      // 5 total entries, 1 DELETE
      expect(metrics.tombstoneRatio).toBeCloseTo(1 / 5);
      // entity-a appears 2x (1 duplicate), entity-b appears 2x (1 duplicate) = 2 duplicates out of 5
      expect(metrics.duplicateEntryRatio).toBeCloseTo(2 / 5);
      expect(metrics.oldestSegmentAge).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getCheckpointMetrics', () => {
    test('should return zeroed metrics when no checkpoint reader is provided', async () => {
      const provider = new WALMetricsProvider(walDir);
      const metrics = await provider.getCheckpointMetrics();

      expect(metrics.lastCheckpointLSN).toBe(0);
      expect(metrics.lastCheckpointAge).toBe(0);
      expect(metrics.segmentsSinceCheckpoint).toBe(0);
    });

    test('should return segmentsSinceCheckpoint equal to total segments when no checkpoint exists', async () => {
      await writeSegment(walDir, 0, [makeEntry(1, 'entity-a')]);
      await writeSegment(walDir, 1, [makeEntry(2, 'entity-b')]);

      const reader = new CheckpointReaderImpl({ checkpointPath: checkpointDir });
      const provider = new WALMetricsProvider(walDir, reader);
      const metrics = await provider.getCheckpointMetrics();

      expect(metrics.lastCheckpointLSN).toBe(0);
      expect(metrics.segmentsSinceCheckpoint).toBe(2);
    });

    test('should read real checkpoint state and compute metrics', async () => {
      // Create WAL segments
      await writeSegment(walDir, 0, [makeEntry(1, 'entity-a')]);
      await writeSegment(walDir, 1, [makeEntry(2, 'entity-b')]);
      await writeSegment(walDir, 2, [makeEntry(3, 'entity-c')]);

      // Write a checkpoint at LSN 1
      const checkpointTimestamp = Date.now() - 5000; // 5 seconds ago
      const checkpointData = {
        entities: {},
        timestamp: checkpointTimestamp,
        version: '1.0',
        lsn: 1
      };
      const checkpointFilename = 'checkpoint-lsn-00000001.json';
      await fs.writeFile(
        path.join(checkpointDir, checkpointFilename),
        JSON.stringify(checkpointData)
      );
      await fs.writeFile(
        path.join(checkpointDir, 'latest.json'),
        JSON.stringify({ filename: checkpointFilename })
      );

      const reader = new CheckpointReaderImpl({ checkpointPath: checkpointDir });
      const provider = new WALMetricsProvider(walDir, reader);
      const metrics = await provider.getCheckpointMetrics();

      expect(metrics.lastCheckpointLSN).toBe(1);
      expect(metrics.lastCheckpointAge).toBeGreaterThanOrEqual(4000);
      expect(metrics.lastCheckpointAge).toBeLessThan(15000);
      // Segments with startLSN > 1: segment-1 (startLSN=2) and segment-2 (startLSN=3)
      expect(metrics.segmentsSinceCheckpoint).toBe(2);
    });
  });

  describe('integration with CompactionScheduler', () => {
    test('provider can be used as CompactionMetricsProvider', async () => {
      await writeSegment(walDir, 0, [
        makeEntry(1, 'entity-a'),
        makeEntry(2, 'entity-b', 'DELETE')
      ]);

      const provider = new WALMetricsProvider(walDir);

      // Verify the provider satisfies the interface contract
      const walMetrics = await provider.getWALMetrics();
      const checkpointMetrics = await provider.getCheckpointMetrics();
      const segments = await provider.getWALSegments();

      expect(walMetrics).toHaveProperty('segmentCount');
      expect(walMetrics).toHaveProperty('totalSizeBytes');
      expect(walMetrics).toHaveProperty('oldestSegmentAge');
      expect(walMetrics).toHaveProperty('tombstoneRatio');
      expect(walMetrics).toHaveProperty('duplicateEntryRatio');

      expect(checkpointMetrics).toHaveProperty('lastCheckpointLSN');
      expect(checkpointMetrics).toHaveProperty('lastCheckpointAge');
      expect(checkpointMetrics).toHaveProperty('segmentsSinceCheckpoint');

      expect(segments.length).toBeGreaterThan(0);
      expect(segments[0]).toHaveProperty('segmentId');
      expect(segments[0]).toHaveProperty('filePath');
      expect(segments[0]).toHaveProperty('startLSN');
      expect(segments[0]).toHaveProperty('endLSN');
    });
  });
});
