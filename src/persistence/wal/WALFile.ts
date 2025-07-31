import fs from 'fs/promises';
import path from 'path';
import { WALEntry, WALFile } from './types';

export class WALFileImpl implements WALFile {
  private filePath: string;
  private fileHandle: fs.FileHandle | null = null;
  private isOpen: boolean = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async open(): Promise<void> {
    if (this.isOpen) return;

    // Ensure directory exists
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    // Open file for append/read
    this.fileHandle = await fs.open(this.filePath, 'a+');
    this.isOpen = true;
  }

  async append(entry: WALEntry): Promise<void> {
    if (!this.isOpen || !this.fileHandle) {
      throw new Error('WAL file not open');
    }

    const serialized = JSON.stringify(entry) + '\n';
    await this.fileHandle.write(serialized);
  }

  async readEntries(startLSN?: number, endLSN?: number): Promise<WALEntry[]> {
    if (!this.isOpen || !this.fileHandle) {
      await this.open();
    }

    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      
      const entries: WALEntry[] = [];
      for (const line of lines) {
        try {
          const entry: WALEntry = JSON.parse(line);
          
          // Filter by LSN range if specified
          if (startLSN !== undefined && entry.logSequenceNumber < startLSN) continue;
          if (endLSN !== undefined && entry.logSequenceNumber > endLSN) continue;
          
          entries.push(entry);
        } catch (parseError) {
          console.warn('[WALFile] Skipping malformed entry:', line);
        }
      }
      
      return entries.sort((a, b) => a.logSequenceNumber - b.logSequenceNumber);
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return []; // File doesn't exist yet
      }
      throw error;
    }
  }

  async truncate(beforeLSN: number): Promise<void> {
    const entries = await this.readEntries();
    const keepEntries = entries.filter(entry => entry.logSequenceNumber >= beforeLSN);
    
    // Rewrite file with kept entries
    await this.close();
    await fs.unlink(this.filePath).catch(() => {}); // Ignore if file doesn't exist
    
    await this.open();
    for (const entry of keepEntries) {
      await this.append(entry);
    }
    await this.flush();
  }

  async getSize(): Promise<number> {
    try {
      const stats = await fs.stat(this.filePath);
      return stats.size;
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  }

  async getLastLSN(): Promise<number> {
    const entries = await this.readEntries();
    if (entries.length === 0) return 0;
    return Math.max(...entries.map(e => e.logSequenceNumber));
  }

  async flush(): Promise<void> {
    if (this.fileHandle) {
      await this.fileHandle.sync();
    }
  }

  async close(): Promise<void> {
    if (this.fileHandle) {
      await this.fileHandle.close();
      this.fileHandle = null;
    }
    this.isOpen = false;
  }
}
