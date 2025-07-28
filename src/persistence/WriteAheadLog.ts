import { IWriteAheadLog } from '../types';

export class WriteAheadLog implements IWriteAheadLog {
  private log: any[] = [];

  append(entry: any): void {
    this.log.push(entry);
  }

  readAll(): any[] {
    return [...this.log];
  }

  clear(): void {
    this.log = [];
  }
}
