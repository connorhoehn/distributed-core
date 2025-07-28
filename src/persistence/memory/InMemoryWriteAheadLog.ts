import { IWriteAheadLog } from '../../types';

export class InMemoryWriteAheadLog implements IWriteAheadLog {
  private log: any[] = [];

  append(entry: any): void {
    this.log.push(entry);
  }

  readAll(): any[] {
    return this.log.map(entry => 
      typeof entry === 'object' && entry !== null 
        ? JSON.parse(JSON.stringify(entry))
        : entry
    );
  }

  clear(): void {
    this.log = [];
  }
}
