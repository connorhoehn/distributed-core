import crypto from 'crypto';
import { WALEntry, EntityUpdate, WALCoordinator } from '../types';

export class WALCoordinatorImpl implements WALCoordinator {
  private currentLSN: number = 0;

  constructor(initialLSN: number = 0) {
    this.currentLSN = initialLSN;
  }

  getCurrentLSN(): number {
    return this.currentLSN;
  }

  getNextLSN(): number {
    return ++this.currentLSN;
  }

  calculateChecksum(data: any): string {
    const serialized = JSON.stringify(data);
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  validateEntry(entry: WALEntry): boolean {
    try {
      const expectedChecksum = this.calculateChecksum(entry.data);
      return entry.checksum === expectedChecksum;
    } catch (error) {
      return false;
    }
  }

  createEntry(update: EntityUpdate): WALEntry {
    const entry: WALEntry = {
      logSequenceNumber: this.getNextLSN(),
      timestamp: Date.now(),
      checksum: this.calculateChecksum(update),
      data: update
    };

    return entry;
  }

  resetLSN(lsn: number): void {
    this.currentLSN = lsn;
  }
}
