import * as fs from 'fs/promises';
import * as path from 'path';
import { CheckpointWriter, CheckpointSnapshot, EntityState, CheckpointConfig } from './types';

export class CheckpointWriterImpl implements CheckpointWriter {
  private config: Required<CheckpointConfig> & { filePath: string };

  constructor(config: CheckpointConfig = {}) {
    this.config = {
      checkpointPath: config.checkpointPath || './data/checkpoints',
      filePath: config.checkpointPath || './data/checkpoints', // Internal use
      interval: config.interval !== undefined ? config.interval : 0, // disabled by default
      lsnThreshold: config.lsnThreshold !== undefined ? config.lsnThreshold : 1000,
      keepHistory: config.keepHistory || 5,
      compressionEnabled: config.compressionEnabled || false
    };
  }

  async writeSnapshot(lsn: number, entities: Record<string, EntityState>): Promise<void> {
    // Ensure checkpoint directory exists
    await fs.mkdir(this.config.filePath, { recursive: true });

    const snapshot: CheckpointSnapshot = {
      lsn,
      entities,
      timestamp: Date.now(),
      version: '1.0'
    };

    const filename = `checkpoint-lsn-${lsn.toString().padStart(8, '0')}.json`;
    const filePath = path.join(this.config.filePath, filename);
    const tempPath = `${filePath}.tmp`;

    try {
      // Write to temporary file first
      const content = JSON.stringify(snapshot, null, 2);
      await fs.writeFile(tempPath, content, 'utf-8');
      
      // Atomic rename
      await fs.rename(tempPath, filePath);

      // Update latest symlink/pointer
      const latestPath = path.join(this.config.filePath, 'latest.json');
      await fs.writeFile(latestPath, JSON.stringify({ 
        lsn, 
        filename, 
        timestamp: snapshot.timestamp 
      }), 'utf-8');

      // Clean up old checkpoints
      await this.cleanup();
    } catch (error) {
      // Clean up temp file on error
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    if (this.config.keepHistory <= 0) {
      return;
    }

    try {
      const files = await fs.readdir(this.config.filePath);
      const checkpointFiles = files
        .filter(f => f.startsWith('checkpoint-lsn-') && f.endsWith('.json'))
        .sort()
        .reverse(); // newest first

      // Keep only the configured number of checkpoints
      const filesToDelete = checkpointFiles.slice(this.config.keepHistory);
      
      for (const file of filesToDelete) {
        await fs.unlink(path.join(this.config.filePath, file));
      }
    } catch (error) {
      // Don't fail the checkpoint if cleanup fails
      console.warn('[CheckpointWriter] Cleanup failed:', error);
    }
  }

  getConfig(): Required<CheckpointConfig> & { filePath: string } {
    return { ...this.config };
  }
}
