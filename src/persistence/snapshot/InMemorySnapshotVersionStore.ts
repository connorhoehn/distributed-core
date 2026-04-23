import {
  ISnapshotVersionStore,
  SnapshotEntry,
  StoreSnapshotOptions,
} from './types';

let idCounter = 0;

export class InMemorySnapshotVersionStore<T> implements ISnapshotVersionStore<T> {
  // Entries stored newest-first per key
  private readonly entries = new Map<string, SnapshotEntry<T>[]>();

  async store(key: string, data: T, options: StoreSnapshotOptions = {}): Promise<SnapshotEntry<T>> {
    const now = Date.now();
    const entry: SnapshotEntry<T> = {
      id: `snap-${now}-${++idCounter}`,
      key,
      timestamp: now,
      type: options.type ?? 'auto',
      name: options.name,
      data,
      expiresAt: options.ttlMs !== undefined ? now + options.ttlMs : undefined,
      metadata: options.metadata,
    };

    let list = this.entries.get(key);
    if (list === undefined) {
      list = [];
      this.entries.set(key, list);
    }
    list.unshift(entry);

    return entry;
  }

  async getLatest(key: string): Promise<SnapshotEntry<T> | null> {
    const list = this.entries.get(key);
    if (list === undefined) return null;
    const now = Date.now();
    for (const entry of list) {
      if (entry.expiresAt === undefined || entry.expiresAt > now) return entry;
    }
    return null;
  }

  async list(key: string, limit = 20): Promise<SnapshotEntry<T>[]> {
    const list = this.entries.get(key) ?? [];
    const now = Date.now();
    const result: SnapshotEntry<T>[] = [];
    for (const entry of list) {
      if (result.length >= limit) break;
      if (entry.expiresAt === undefined || entry.expiresAt > now) result.push(entry);
    }
    return result;
  }

  async getAt(key: string, timestamp: number): Promise<SnapshotEntry<T> | null> {
    const list = this.entries.get(key) ?? [];
    return list.find(e => e.timestamp === timestamp) ?? null;
  }

  async delete(key: string, timestamp: number): Promise<boolean> {
    const list = this.entries.get(key);
    if (list === undefined) return false;
    const idx = list.findIndex(e => e.timestamp === timestamp);
    if (idx === -1) return false;
    list.splice(idx, 1);
    if (list.length === 0) this.entries.delete(key);
    return true;
  }

  async purgeExpired(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [key, list] of this.entries) {
      const before = list.length;
      const kept = list.filter(e => e.expiresAt === undefined || e.expiresAt > now);
      removed += before - kept.length;
      if (kept.length === 0) {
        this.entries.delete(key);
      } else {
        this.entries.set(key, kept);
      }
    }
    return removed;
  }
}
