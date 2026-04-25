import * as fs from 'fs/promises';
import * as path from 'path';
import { CheckpointWriter, CheckpointSnapshot, EntityState, CheckpointConfig } from './types';
import { atomicWriteFile } from '../atomicWrite';

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

    const content = JSON.stringify(snapshot, null, 2);
    await atomicWriteFile(filePath, async (tmpPath) => {
      await fs.writeFile(tmpPath, content, 'utf-8');
    });

    const latestPath = path.join(this.config.filePath, 'latest.json');
    const latestContent = JSON.stringify({
      lsn,
      filename,
      timestamp: snapshot.timestamp,
    });
    await atomicWriteFile(latestPath, async (tmpPath) => {
      await fs.writeFile(tmpPath, latestContent, 'utf-8');
    });

    await this.cleanup();
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
