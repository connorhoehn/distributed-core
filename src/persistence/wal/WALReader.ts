import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { createInterface } from 'readline';
import { WALReader, WALFile, WALEntry, WALCoordinator } from './types';
import { WALFileImpl } from './WALFile';
import { WALCoordinatorImpl } from './WALCoordinator';
import { FrameworkLogger } from '../../common/logger';

export class WALReaderImpl implements WALReader {
  private walFile: WALFile;
  private filePath: string;
  private coordinator: WALCoordinator;
  private logger: FrameworkLogger;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.walFile = new WALFileImpl(filePath);
    this.coordinator = new WALCoordinatorImpl();
    this.logger = new FrameworkLogger({ enableFrameworkLogs: true });
  }

  async initialize(): Promise<void> {
    await (this.walFile as WALFileImpl).open();
  }

  async *readFrom(logSequenceNumber: number): AsyncIterableIterator<WALEntry> {
    const entries = await this.walFile.readEntries(logSequenceNumber);
    
    for (const entry of entries) {
      // Validate entry if coordinator supports it
      if (!this.coordinator.validateEntry(entry)) {
        console.warn(`[WALReader] Invalid entry at LSN ${entry.logSequenceNumber}, skipping`);
        continue;
      }
      
      yield entry;
    }
  }

  /**
   * Streaming reader: yields validated WAL entries one at a time, reading the
   * underlying file line-by-line. Memory cost is O(1) regardless of WAL size.
   *
   * Entries are yielded in on-disk order, which for an append-only WAL is also
   * LSN order. Optional bounds let callers narrow the range without first
   * collecting via readRange().
   *
   * Falls back to yielding nothing when the file is missing (matching the
   * readAll() behavior). Malformed lines are logged and skipped.
   */
  async *readEntries(startLSN?: number, endLSN?: number): AsyncIterable<WALEntry> {
    try {
      await stat(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    const stream = createReadStream(this.filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;

        let entry: WALEntry;
        try {
          entry = JSON.parse(line);
        } catch {
          console.warn('[WALReader] Skipping malformed entry:', line);
          continue;
        }

        if (startLSN !== undefined && entry.logSequenceNumber < startLSN) continue;
        if (endLSN !== undefined && entry.logSequenceNumber > endLSN) continue;

        if (!this.coordinator.validateEntry(entry)) {
          console.warn(`[WALReader] Invalid entry at LSN ${entry.logSequenceNumber}, filtering out`);
          continue;
        }

        yield entry;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  async readAll(): Promise<WALEntry[]> {
    const entries = await this.walFile.readEntries();
    
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
    return await this.walFile.getLastLSN();
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
    return await this.walFile.readEntries(startLSN, endLSN);
  }

  async getEntryCount(): Promise<number> {
    const entries = await this.readAll();
    return entries.length;
  }

  async close(): Promise<void> {
    await this.walFile.close();
  }
}
