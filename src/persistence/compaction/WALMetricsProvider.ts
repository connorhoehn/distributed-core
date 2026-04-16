import fs from 'fs/promises';
import path from 'path';
import {
  CompactionMetricsProvider,
  WALMetrics,
  CheckpointMetrics,
  WALSegment
} from './types';
import { WALFileImpl } from '../wal/WALFile';
import { CheckpointReaderImpl } from '../checkpoint/CheckpointReader';

/**
 * Real CompactionMetricsProvider that reads actual WAL segment files
 * and checkpoint state from disk, replacing the StubMetricsProvider
 * for production use.
 */
export class WALMetricsProvider implements CompactionMetricsProvider {
  constructor(
    private walDir: string,
    private checkpointReader?: CheckpointReaderImpl
  ) {}

  async getWALMetrics(): Promise<WALMetrics> {
    const segments = await this.getWALSegments();

    const segmentCount = segments.length;
    const totalSizeBytes = segments.reduce((sum, s) => sum + s.sizeBytes, 0);
    const totalEntries = segments.reduce((sum, s) => sum + s.entryCount, 0);
    const totalTombstones = segments.reduce((sum, s) => sum + s.tombstoneCount, 0);

    let oldestSegmentAge = 0;
    if (segments.length > 0) {
      const oldestCreatedAt = Math.min(...segments.map(s => s.createdAt));
      oldestSegmentAge = Date.now() - oldestCreatedAt;
    }

    const tombstoneRatio = totalEntries > 0 ? totalTombstones / totalEntries : 0;

    // Duplicate detection: count entries that share the same entityId
    // across all segments. Entries with the same entityId in different
    // segments are considered duplicates (superseded by later writes).
    const entityVersionCounts = new Map<string, number>();
    for (const seg of segments) {
      const walFile = new WALFileImpl(seg.filePath);
      try {
        await walFile.open();
        const entries = await walFile.readEntries();
        for (const entry of entries) {
          const key = entry.data.entityId;
          entityVersionCounts.set(key, (entityVersionCounts.get(key) || 0) + 1);
        }
      } finally {
        await walFile.close();
      }
    }
    let duplicateCount = 0;
    for (const count of entityVersionCounts.values()) {
      if (count > 1) {
        duplicateCount += count - 1;
      }
    }
    const duplicateEntryRatio = totalEntries > 0 ? duplicateCount / totalEntries : 0;

    return {
      segmentCount,
      totalSizeBytes,
      oldestSegmentAge,
      tombstoneRatio,
      duplicateEntryRatio
    };
  }

  async getCheckpointMetrics(): Promise<CheckpointMetrics> {
    if (!this.checkpointReader) {
      return {
        lastCheckpointLSN: 0,
        lastCheckpointAge: 0,
        segmentsSinceCheckpoint: 0
      };
    }

    const latest = await this.checkpointReader.readLatest();

    if (!latest) {
      // No checkpoint exists yet
      const segments = await this.getWALSegments();
      return {
        lastCheckpointLSN: 0,
        lastCheckpointAge: 0,
        segmentsSinceCheckpoint: segments.length
      };
    }

    const lastCheckpointLSN = latest.lsn ?? 0;
    const lastCheckpointAge = Date.now() - latest.timestamp;

    // Count segments whose startLSN is after the checkpoint LSN
    const segments = await this.getWALSegments();
    const segmentsSinceCheckpoint = segments.filter(
      s => s.startLSN > lastCheckpointLSN
    ).length;

    return {
      lastCheckpointLSN,
      lastCheckpointAge,
      segmentsSinceCheckpoint
    };
  }

  async getWALSegments(): Promise<WALSegment[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.walDir);
    } catch {
      return [];
    }

    const segmentFiles = files
      .filter(f => /^wal-\d+\.log$/.test(f))
      .sort((a, b) => {
        const numA = parseInt(a.match(/wal-(\d+)\.log/)![1], 10);
        const numB = parseInt(b.match(/wal-(\d+)\.log/)![1], 10);
        return numA - numB;
      });

    const segments: WALSegment[] = [];

    for (const file of segmentFiles) {
      const filePath = path.join(this.walDir, file);
      const stat = await fs.stat(filePath);

      const walFile = new WALFileImpl(filePath);
      let entries: Awaited<ReturnType<WALFileImpl['readEntries']>> = [];
      try {
        await walFile.open();
        entries = await walFile.readEntries();
      } finally {
        await walFile.close();
      }

      const segmentNumber = parseInt(file.match(/wal-(\d+)\.log/)![1], 10);
      const entryCount = entries.length;
      const tombstoneCount = entries.filter(
        e => e.data.operation === 'DELETE'
      ).length;

      const startLSN = entryCount > 0 ? entries[0].logSequenceNumber : 0;
      const endLSN = entryCount > 0 ? entries[entries.length - 1].logSequenceNumber : 0;

      segments.push({
        segmentId: `segment-${segmentNumber.toString().padStart(3, '0')}`,
        filePath,
        startLSN,
        endLSN,
        createdAt: stat.birthtimeMs,
        sizeBytes: stat.size,
        entryCount,
        tombstoneCount,
        isImmutable: true // Assume all on-disk segments except the active one are immutable
      });
    }

    return segments;
  }
}
