import { IStateStore } from '../../types';

export class InMemoryStateStore implements IStateStore {
  private store: Record<string, any> = {};

  get<T>(key: string): T | undefined {
    return this.store[key];
  }

  set<T>(key: string, value: T): void {
    this.store[key] = value;
  }

  delete(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }

  snapshot(): Record<string, unknown> {
    return { ...this.store };
  }
}
