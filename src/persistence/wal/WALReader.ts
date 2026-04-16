import { WALReader, WALFile, WALEntry, WALCoordinator } from '../types';
import { WALFileImpl } from './WALFile';
import { WALCoordinatorImpl } from './WALCoordinator';
import { FrameworkLogger } from '../../common/logger';
import fs from 'fs/promises';
import path from 'path';

export class WALReaderImpl implements WALReader {
  private walFile: WALFile;
  private coordinator: WALCoordinator;
  private logger: FrameworkLogger;
  private filePath: string;
  private segmentPaths: string[] | null = null;
  private segmentsDiscovered: boolean = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.walFile = new WALFileImpl(filePath);
    this.coordinator = new WALCoordinatorImpl();
    this.logger = new FrameworkLogger({ enableFrameworkLogs: true });
  }

  async initialize(): Promise<void> {
    // Discover segment files in the directory
    await this.discoverSegments();

    // Open the first segment (or the legacy single file) for backward compat
    await (this.walFile as WALFileImpl).open();
  }

  /**
   * Scan the WAL directory for segment files (wal-N.log).
   * If segments exist, use them. Otherwise fall back to the single legacy file.
   */
  private async discoverSegments(): Promise<void> {
    if (this.segmentsDiscovered) return;
    this.segmentsDiscovered = true;

    const dir = path.dirname(this.filePath);
    try {
      const files = await fs.readdir(dir);
      const segmentFiles = files
        .filter(f => /^wal-\d+\.log$/.test(f))
        .sort((a, b) => {
          const numA = parseInt(a.match(/wal-(\d+)\.log/)![1], 10);
          const numB = parseInt(b.match(/wal-(\d+)\.log/)![1], 10);
          return numA - numB;
        });

      if (segmentFiles.length > 0) {
        this.segmentPaths = segmentFiles.map(f => path.join(dir, f));
      }
    } catch {
      // Directory doesn't exist; segmentPaths stays null -> use legacy single file
    }
  }

  /**
   * Ensure segments are discovered before any read operation.
   * This allows the reader to work even if initialize() was not called.
   */
  private async ensureSegmentsDiscovered(): Promise<void> {
    if (!this.segmentsDiscovered) {
      await this.discoverSegments();
    }
  }

  /**
   * Read all entries across all segments (or the single legacy file).
   * Entries are returned sorted by LSN.
   */
  private async readAllEntriesRaw(startLSN?: number, endLSN?: number): Promise<WALEntry[]> {
    await this.ensureSegmentsDiscovered();
    if (!this.segmentPaths) {
      // Legacy single-file mode
      return await this.walFile.readEntries(startLSN, endLSN);
    }

    const allEntries: WALEntry[] = [];
    for (const segPath of this.segmentPaths) {
      const segFile = new WALFileImpl(segPath);
      await segFile.open();
      const entries = await segFile.readEntries(startLSN, endLSN);
      allEntries.push(...entries);
      await segFile.close();
    }

    return allEntries.sort((a, b) => a.logSequenceNumber - b.logSequenceNumber);
  }

  async *readFrom(logSequenceNumber: number): AsyncIterableIterator<WALEntry> {
    const entries = await this.readAllEntriesRaw(logSequenceNumber);

    for (const entry of entries) {
      // Validate entry if coordinator supports it
      if (!this.coordinator.validateEntry(entry)) {
        console.warn(`[WALReader] Invalid entry at LSN ${entry.logSequenceNumber}, skipping`);
        continue;
      }

      yield entry;
    }
  }

  async readAll(): Promise<WALEntry[]> {
    const entries = await this.readAllEntriesRaw();

    // Filter out invalid entries
    return entries.filter(entry => {
      const isValid = this.coordinator.validateEntry(entry);
      if (!isValid) {
        console.warn(`[WALReader] Invalid entry at LSN ${entry.logSequenceNumber}, filtering out`);
      }
      return isValid;
    });
  }

  async getLastSequenceNumber(): Promise<number> {
    await this.ensureSegmentsDiscovered();
    if (!this.segmentPaths) {
      return await this.walFile.getLastLSN();
    }

    // Check segments in reverse to find the last non-empty one
    for (let i = this.segmentPaths.length - 1; i >= 0; i--) {
      const segFile = new WALFileImpl(this.segmentPaths[i]);
      await segFile.open();
      const lsn = await segFile.getLastLSN();
      await segFile.close();
      if (lsn > 0) return lsn;
    }
    return 0;
  }

  async replay(handler: (entry: WALEntry) => Promise<void>): Promise<void> {
    const entries = await this.readAll();

    this.logger.framework(`[WALReader] Replaying ${entries.length} entries`);

    let processed = 0;
    let errors = 0;

    for (const entry of entries) {
      try {
        await handler(entry);
        processed++;
      } catch (error) {
        errors++;
        console.error(`[WALReader] Failed to replay entry at LSN ${entry.logSequenceNumber}:`, error);

        // Continue with next entry rather than failing completely
        // This allows partial recovery in case of corrupted entries
      }
    }

    this.logger.framework(`[WALReader] Replay completed: ${processed} processed, ${errors} errors`);

    if (errors > 0) {
      console.warn(`[WALReader] ${errors} entries failed during replay - check logs for details`);
    }
  }

  async readRange(startLSN: number, endLSN: number): Promise<WALEntry[]> {
    return await this.readAllEntriesRaw(startLSN, endLSN);
  }

  async getEntryCount(): Promise<number> {
    const entries = await this.readAll();
    return entries.length;
  }

  async close(): Promise<void> {
    await this.walFile.close();
  }
}
