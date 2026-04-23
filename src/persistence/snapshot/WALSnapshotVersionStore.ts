import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import { WALWriterImpl } from '../wal/WALWriter';
import { WALReaderImpl } from '../wal/WALReader';
import { WALEntry } from '../wal/types';
import {
  ISnapshotVersionStore,
  SnapshotEntry,
  SnapshotType,
  StoreSnapshotOptions,
} from './types';

export interface CompactionOptions {
  maxEntriesPerKey?: number;
  deleteExpired?: boolean;
}

export interface CompactionResult {
  keysVisited: number;
  entriesKept: number;
  entriesRemoved: number;
}

interface SnapshotMetadata {
  _snapshot: true;
  id: string;
  key: string;
  type: SnapshotType;
  name?: string;
  data: string;
  sizeBytes: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

function isSnapshotMetadata(m: Record<string, unknown> | undefined): m is SnapshotMetadata & Record<string, unknown> {
  return m !== undefined && m['_snapshot'] === true;
}

function entryFromMetadata<T>(meta: SnapshotMetadata, timestamp: number): SnapshotEntry<T> {
  return {
    id: meta.id,
    key: meta.key,
    timestamp,
    type: meta.type,
    name: meta.name,
    data: JSON.parse(meta.data) as T,
    sizeBytes: meta.sizeBytes,
    expiresAt: meta.expiresAt,
    metadata: meta.metadata,
  };
}

export class WALSnapshotVersionStore<T> implements ISnapshotVersionStore<T> {
  private readonly filePath: string;
  private writer!: WALWriterImpl;
  private reader!: WALReaderImpl;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async initialize(): Promise<void> {
    this.writer = new WALWriterImpl({ filePath: this.filePath, syncInterval: 0 });
    this.reader = new WALReaderImpl(this.filePath);
    await this.writer.initialize();
    await this.reader.initialize();
  }

  async close(): Promise<void> {
    await this.writer.close();
    await this.reader.close();
  }

  async store(key: string, data: T, options: StoreSnapshotOptions = {}): Promise<SnapshotEntry<T>> {
    const now = Date.now();
    const id = randomUUID();
    const serialized = JSON.stringify(data);
    const sizeBytes = options.sizeBytes ?? Buffer.byteLength(serialized, 'utf8');

    const meta: SnapshotMetadata = {
      _snapshot: true,
      id,
      key,
      type: options.type ?? 'auto',
      data: serialized,
      sizeBytes,
      ...(options.name !== undefined && { name: options.name }),
      ...(options.expiresAt !== undefined && { expiresAt: options.expiresAt }),
      ...(options.metadata !== undefined && { metadata: options.metadata }),
    };

    await this.writer.append({
      entityId: `snapshot:${key}`,
      ownerNodeId: 'local',
      version: now,
      timestamp: now,
      operation: 'CREATE',
      metadata: meta as unknown as Record<string, unknown>,
    });

    return {
      id,
      key,
      timestamp: now,
      type: meta.type,
      name: meta.name,
      data,
      sizeBytes,
      expiresAt: meta.expiresAt,
      metadata: meta.metadata,
    };
  }

  private async readAlive(key?: string): Promise<SnapshotEntry<T>[]> {
    const entries: WALEntry[] = await this.reader.readAll();

    const creates = new Map<string, SnapshotEntry<T>>();
    const deleted = new Set<string>();

    for (const entry of entries) {
      const meta = entry.data.metadata as Record<string, unknown> | undefined;
      if (!isSnapshotMetadata(meta)) continue;
      if (key !== undefined && meta.key !== key) continue;

      if (entry.data.operation === 'CREATE') {
        creates.set(meta.id, entryFromMetadata<T>(meta, entry.data.timestamp));
      } else if (entry.data.operation === 'DELETE') {
        deleted.add(meta.id);
      }
    }

    const alive: SnapshotEntry<T>[] = [];
    for (const [id, snapshot] of creates) {
      if (!deleted.has(id)) {
        alive.push(snapshot);
      }
    }

    alive.sort((a, b) => b.timestamp - a.timestamp);
    return alive;
  }

  async getLatest(key: string): Promise<SnapshotEntry<T> | null> {
    const alive = await this.readAlive(key);
    return alive[0] ?? null;
  }

  async list(key: string, limit = 10): Promise<SnapshotEntry<T>[]> {
    const alive = await this.readAlive(key);
    return alive.slice(0, limit);
  }

  async getAt(key: string, timestamp: number): Promise<SnapshotEntry<T> | null> {
    const alive = await this.readAlive(key);
    const candidates = alive.filter(s => s.timestamp <= timestamp);
    return candidates[0] ?? null;
  }

  async delete(key: string, timestamp: number): Promise<boolean> {
    const alive = await this.readAlive(key);
    const target = alive.find(s => s.timestamp === timestamp);
    if (!target) return false;

    const now = Date.now();
    await this.writer.append({
      entityId: `snapshot:${key}`,
      ownerNodeId: 'local',
      version: now,
      timestamp: now,
      operation: 'DELETE',
      metadata: {
        _snapshot: true,
        id: target.id,
        key,
      } as unknown as Record<string, unknown>,
    });

    return true;
  }

  async purgeExpired(): Promise<number> {
    const all = await this.readAlive();
    const now = Date.now();
    let count = 0;

    for (const snapshot of all) {
      if (snapshot.expiresAt !== undefined && snapshot.expiresAt < now) {
        const deleted = await this.delete(snapshot.key, snapshot.timestamp);
        if (deleted) count++;
      }
    }

    return count;
  }

  async compact(options: CompactionOptions = {}): Promise<CompactionResult> {
    const maxEntriesPerKey = options.maxEntriesPerKey ?? 10;
    const deleteExpired = options.deleteExpired ?? true;
    const now = Date.now();

    const all = await this.readAlive();

    const byKey = new Map<string, SnapshotEntry<T>[]>();
    for (const entry of all) {
      const group = byKey.get(entry.key);
      if (group) {
        group.push(entry);
      } else {
        byKey.set(entry.key, [entry]);
      }
    }

    const toKeep: SnapshotEntry<T>[] = [];
    let entriesRemoved = 0;

    for (const [, entries] of byKey) {
      let candidates = entries;
      if (deleteExpired) {
        candidates = candidates.filter(
          e => e.expiresAt === undefined || e.expiresAt >= now,
        );
      }
      const kept = candidates.slice(0, maxEntriesPerKey);
      const dropped = entries.length - kept.length;
      entriesRemoved += dropped;
      toKeep.push(...kept);
    }

    await this.writer.close();
    await this.reader.close();

    await unlink(this.filePath).catch(() => {});

    const freshWriter = new WALWriterImpl({ filePath: this.filePath, syncInterval: 0 });
    await freshWriter.initialize();

    for (const entry of toKeep) {
      const meta: SnapshotMetadata = {
        _snapshot: true,
        id: entry.id,
        key: entry.key,
        type: entry.type,
        data: JSON.stringify(entry.data),
        sizeBytes: entry.sizeBytes ?? Buffer.byteLength(JSON.stringify(entry.data), 'utf8'),
        ...(entry.name !== undefined && { name: entry.name }),
        ...(entry.expiresAt !== undefined && { expiresAt: entry.expiresAt }),
        ...(entry.metadata !== undefined && { metadata: entry.metadata }),
      };

      await freshWriter.append({
        entityId: `snapshot:${entry.key}`,
        ownerNodeId: 'local',
        version: entry.timestamp,
        timestamp: entry.timestamp,
        operation: 'CREATE',
        metadata: meta as unknown as Record<string, unknown>,
      });
    }

    await freshWriter.close();

    this.writer = new WALWriterImpl({ filePath: this.filePath, syncInterval: 0 });
    this.reader = new WALReaderImpl(this.filePath);
    await this.writer.initialize();
    await this.reader.initialize();

    return {
      keysVisited: byKey.size,
      entriesKept: toKeep.length,
      entriesRemoved,
    };
  }
}
