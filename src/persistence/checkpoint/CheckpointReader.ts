import * as fs from 'fs/promises';
import * as path from 'path';
import { CheckpointReader, CheckpointSnapshot, CheckpointConfig } from './types';

export class CheckpointReaderImpl implements CheckpointReader {
  private config: Required<CheckpointConfig> & { filePath: string };

  constructor(config: CheckpointConfig = {}) {
    this.config = {
      checkpointPath: config.checkpointPath || './data/checkpoints',
      filePath: config.checkpointPath || './data/checkpoints', // Internal use
      interval: config.interval !== undefined ? config.interval : 0,
      lsnThreshold: config.lsnThreshold !== undefined ? config.lsnThreshold : 1000,
      keepHistory: config.keepHistory || 5,
      compressionEnabled: config.compressionEnabled || false
    };
  }

  async readLatest(): Promise<CheckpointSnapshot | null> {
    try {
      const latestPath = path.join(this.config.filePath, 'latest.json');
      const latestInfo = JSON.parse(await fs.readFile(latestPath, 'utf-8'));
      
      const checkpointPath = path.join(this.config.filePath, latestInfo.filename);
      const content = await fs.readFile(checkpointPath, 'utf-8');
      
      return JSON.parse(content) as CheckpointSnapshot;
    } catch (error) {
      // No checkpoint exists or file is corrupted
      return null;
    }
  }

  async readByLSN(lsn: number): Promise<CheckpointSnapshot | null> {
    try {
      const filename = `checkpoint-lsn-${lsn.toString().padStart(8, '0')}.json`;
      const filePath = path.join(this.config.filePath, filename);
      
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as CheckpointSnapshot;
    } catch (error) {
      return null;
    }
  }

  async listSnapshots(): Promise<number[]> {
    try {
      const files = await fs.readdir(this.config.filePath);
      const lsns: number[] = [];
      
      for (const file of files) {
        if (file.startsWith('checkpoint-lsn-') && file.endsWith('.json')) {
          const match = file.match(/checkpoint-lsn-(\d+)\.json/);
          if (match) {
            lsns.push(parseInt(match[1], 10));
          }
        }
      }
      
      return lsns.sort((a, b) => a - b);
    } catch (error) {
      return [];
    }
  }

  async findNearestSnapshot(targetLSN: number): Promise<CheckpointSnapshot | null> {
    const snapshots = await this.listSnapshots();
    
    // Find the highest LSN that is <= targetLSN
    let bestLSN = -1;
    for (const lsn of snapshots) {
      if (lsn <= targetLSN && lsn > bestLSN) {
        bestLSN = lsn;
      }
    }
    
    if (bestLSN === -1) {
      return null;
    }
    
    return this.readByLSN(bestLSN);
  }

  getConfig(): Required<CheckpointConfig> & { filePath: string } {
    return { ...this.config };
  }
}
