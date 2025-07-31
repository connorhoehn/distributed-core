import { WALWriter, WALFile, WALCoordinator, EntityUpdate, WALConfig } from '../types';
import { WALFileImpl } from './WALFile';
import { WALCoordinatorImpl } from './WALCoordinator';

export class WALWriterImpl implements WALWriter {
  private walFile: WALFile;
  private coordinator: WALCoordinator;
  private config: Required<WALConfig>;
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(config: WALConfig = {}) {
    this.config = {
      filePath: config.filePath || './data/entity.wal',
      maxFileSize: config.maxFileSize || 100 * 1024 * 1024, // 100MB
      syncInterval: config.syncInterval !== undefined ? config.syncInterval : 1000, // 1 second
      compressionEnabled: config.compressionEnabled || false,
      checksumEnabled: config.checksumEnabled || true
    };

    this.walFile = new WALFileImpl(this.config.filePath);
    this.coordinator = new WALCoordinatorImpl();
    
    this.setupPeriodicSync();
  }

  async initialize(): Promise<void> {
    await (this.walFile as WALFileImpl).open();
    
    // Initialize LSN from last entry in file
    const lastLSN = await this.walFile.getLastLSN();
    if (lastLSN > 0) {
      (this.coordinator as WALCoordinatorImpl).resetLSN(lastLSN);
    }
  }

  async append(update: EntityUpdate): Promise<number> {
    // Create WAL entry
    const entry = this.coordinator.createEntry(update);

    // Validate if checksums are enabled
    if (this.config.checksumEnabled && !this.coordinator.validateEntry(entry)) {
      throw new Error('Invalid checksum for WAL entry');
    }

    // Check file size limit
    const currentSize = await this.walFile.getSize();
    if (currentSize > this.config.maxFileSize) {
      throw new Error(`WAL file size limit exceeded: ${currentSize} > ${this.config.maxFileSize}`);
    }

    // Append to file
    await this.walFile.append(entry);

    return entry.logSequenceNumber;
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
      (this.coordinator as WALCoordinatorImpl).resetLSN(lastLSN);
    }
  }

  getCurrentLSN(): number {
    return this.coordinator.getCurrentLSN();
  }
}
