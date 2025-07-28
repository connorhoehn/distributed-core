import { IBroadcastBuffer } from '../types';

export class BroadcastBuffer implements IBroadcastBuffer {
  private buffer: any[] = [];

  add(message: any): void {
    this.buffer.push(message);
  }

  drain(): any[] {
    const drained = [...this.buffer];
    this.buffer = [];
    return drained;
  }

  size(): number {
    return this.buffer.length;
  }
}
