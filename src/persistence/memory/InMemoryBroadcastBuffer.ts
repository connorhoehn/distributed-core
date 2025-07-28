import { IBroadcastBuffer } from '../../types';

export class InMemoryBroadcastBuffer implements IBroadcastBuffer {
  private buffer: any[] = [];

  add(message: any): void {
    this.buffer.push(message);
  }

  drain(): any[] {
    const drained = this.buffer.map(message => 
      typeof message === 'object' && message !== null 
        ? JSON.parse(JSON.stringify(message))
        : message
    );
    this.buffer = [];
    return drained;
  }

  size(): number {
    return this.buffer.length;
  }
}
