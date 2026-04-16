import { WALWriter, WALFile, WALCoordinator, WALConfig } from '../types';
// Ensure WALWriter in ./types uses EntityUpdate from ../types for compatibility
import { WALFileImpl } from './WALFile';
import { WALCoordinatorImpl } from './WALCoordinator';
import path from 'path';
import fs from 'fs/promises';
import type { EntityUpdate } from '../types';

export type WALAppendListener = (lsn: number) => void;

export class WALWriterImpl implements WALWriter {
  private walFile: WALFile;
  private coordinator: WALCoordinator;
  private config: Required<WALConfig>;
  private syncTimer: NodeJS.Timeout | null = null;
  private appendListeners: WALAppendListener[] = [];
  private currentSegment: number = 0;
  private segments: string[] = [];

  constructor(config: WALConfig = {}) {
    this.config = {
      filePath: config.filePath || './data/entity.wal',
      maxFileSize: config.maxFileSize || 100 * 1024 * 1024, // 100MB
      retentionDays: config.retentionDays || 7,
      syncInterval: config.syncInterval !== undefined ? config.syncInterval : 1000, // 1 second
      compressionEnabled: config.compressionEnabled || false,
      checksumEnabled: config.checksumEnabled || true
    };

    const segmentPath = this.segmentFilePath(0);
    this.walFile = new WALFileImpl(segmentPath);
    this.segments = [segmentPath];
    this.coordinator = new WALCoordinatorImpl();

    this.setupPeriodicSync();
  }

  /**
   * Build the file path for a given segment number.
   * Uses the configured filePath's directory.
   * Example: filePath = './data/entity.wal' -> './data/wal-0.log'
   */
  private segmentFilePath(segmentNumber: number): string {
    const dir = path.dirname(this.config.filePath);
    return path.join(dir, `wal-${segmentNumber}.log`);
  }

  async initialize(): Promise<void> {
    // Discover existing segments on disk
    const dir = path.dirname(this.config.filePath);
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
        this.segments = segmentFiles.map(f => path.join(dir, f));
        const lastFile = segmentFiles[segmentFiles.length - 1];
        this.currentSegment = parseInt(lastFile.match(/wal-(\d+)\.log/)![1], 10);
        this.walFile = new WALFileImpl(this.segments[this.segments.length - 1]);
      }
    } catch (error) {
      // Directory doesn't exist yet; will be created when WALFileImpl.open() runs
    }

    await (this.walFile as WALFileImpl).open();

    // Initialize LSN from last entry across all segments
    const lastLSN = await this.getLastLSNAcrossSegments();
    if (lastLSN > 0) {
      ((this.coordinator as unknown) as WALCoordinatorImpl).resetLSN(lastLSN);
    }
  }

  /**
   * Read the last LSN across all segment files (check from newest to oldest).
   */
  private async getLastLSNAcrossSegments(): Promise<number> {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const file = new WALFileImpl(this.segments[i]);
      await file.open();
      const lsn = await file.getLastLSN();
      await file.close();
      if (lsn > 0) return lsn;
    }
    return 0;
  }

  async append(update: EntityUpdate): Promise<number> {
    // Create WAL entry
    // Convert EntityUpdate from ../types to ./types.EntityUpdate
    const walUpdate = {
      ...update,
      version: (update as any).version ?? 1, // Provide default or map as needed
      operation: (update as any).operation ?? 'update' // Provide default or map as needed
    };
    const entry = this.coordinator.createEntry(walUpdate);

    // Validate if checksums are enabled
    if (this.config.checksumEnabled && !this.coordinator.validateEntry(entry)) {
      throw new Error('Invalid checksum for WAL entry');
    }

    // Check if we need to rotate to a new segment
    const currentSize = await this.walFile.getSize();
    if (currentSize > this.config.maxFileSize) {
      await this.rotateSegment();
    }

    // Append to file
    await this.walFile.append(entry);

    // Notify listeners
    for (const listener of this.appendListeners) {
      listener(entry.logSequenceNumber);
    }

    return entry.logSequenceNumber;
  }

  /**
   * Close the current segment file and open a new one.
   */
  private async rotateSegment(): Promise<void> {
    await (this.walFile as WALFileImpl).flush();
    await this.walFile.close();

    this.currentSegment++;
    const newPath = this.segmentFilePath(this.currentSegment);
    this.segments.push(newPath);
    this.walFile = new WALFileImpl(newPath);
    await (this.walFile as WALFileImpl).open();
  }

  /**
   * Return the list of all active segment file paths in order.
   */
  getSegments(): string[] {
    return [...this.segments];
  }

  onAppend(listener: WALAppendListener): () => void {
    this.appendListeners.push(listener);
    return () => {
      const idx = this.appendListeners.indexOf(listener);
      if (idx >= 0) {
        this.appendListeners.splice(idx, 1);
      }
    };
  }

  async flush(): Promise<void> {
    await (this.walFile as WALFileImpl).flush();
  }

  async sync(): Promise<void> {
    await this.flush();
  }

  async close(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    await this.flush();
    await this.walFile.close();
  }

  private setupPeriodicSync(): void {
    if (this.config.syncInterval > 0) {
      this.syncTimer = setInterval(async () => {
        try {
          await this.sync();
        } catch (error) {
          console.error('[WALWriter] Periodic sync failed:', error);
        }
      }, this.config.syncInterval);
      this.syncTimer.unref(); // Allow process to exit if only sync timer is running
    }
  }

  // Additional utility methods
  async truncateBefore(lsn: number): Promise<void> {
    await this.walFile.truncate(lsn);

    // Update coordinator LSN if needed
    const lastLSN = await this.walFile.getLastLSN();
    if (lastLSN < this.coordinator.getCurrentLSN()) {
      ((this.coordinator as unknown) as WALCoordinatorImpl).resetLSN(lastLSN);
    }
  }

  getCurrentLSN(): number {
    return this.coordinator.getCurrentLSN();
  }
}
