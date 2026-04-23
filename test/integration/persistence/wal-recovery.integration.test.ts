/**
 * WAL Recovery Integration Tests
 *
 * Verifies that WAL data written by WALWriterImpl is fully recoverable
 * through WALReaderImpl after a simulated node restart (close + reopen).
 */

import fs from 'fs/promises';
import path from 'path';
import { WALWriterImpl } from '../../../src/persistence/wal/WALWriter';
import { WALReaderImpl } from '../../../src/persistence/wal/WALReader';
import { EntityUpdate, WALEntry } from '../../../src/persistence/wal/types';

jest.setTimeout(15000);

// ── helpers ──────────────────────────────────────────────────────────────────

function tmpPath(suffix = ''): string {
  return path.join('/tmp', `test-wal-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}.wal`);
}

function makeUpdate(entityId: string, version: number = 1): EntityUpdate {
  return {
    entityId,
    ownerNodeId: 'test-node',
    version,
    timestamp: Date.now(),
    operation: 'CREATE'
  };
}

async function unlinkSafe(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore ENOENT
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('WAL Recovery Integration', () => {
  const tempFiles: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(tempFiles.map(unlinkSafe));
    tempFiles.length = 0;
  });

  // ── 1. entities written are recoverable via WALReader ───────────────────

  it('entities written to WAL are recoverable via WALReader', async () => {
    const filePath = tmpPath();
    tempFiles.push(filePath);

    // Write phase
    const writer = new WALWriterImpl({ filePath, syncInterval: 0 });
    await writer.initialize();

    await writer.append(makeUpdate('entity-alpha'));
    await writer.append(makeUpdate('entity-beta'));
    await writer.append(makeUpdate('entity-gamma'));

    await writer.flush();
    await writer.close();

    // Read phase (fresh reader — simulates a restart)
    const reader = new WALReaderImpl(filePath);
    await reader.initialize();

    const entries = await reader.readAll();
    await reader.close();

    expect(entries.length).toBe(3);

    const entityIds = entries.map(e => e.data.entityId).sort();
    expect(entityIds).toEqual(['entity-alpha', 'entity-beta', 'entity-gamma'].sort());
  });

  // ── 2. reader returns empty array for non-existent file ─────────────────

  it('WALReader returns empty array for a non-existent file', async () => {
    const filePath = tmpPath('-nonexistent');
    // Do NOT add to tempFiles (it never gets created)

    const reader = new WALReaderImpl(filePath);
    await reader.initialize();

    const entries = await reader.readAll();
    await reader.close();

    // WALFileImpl.readEntries returns [] when ENOENT
    expect(entries).toEqual([]);
  });

  // ── 3. readFrom returns entries at or after the given LSN ───────────────

  it('WALReaderImpl.readFrom returns entries at or after a given LSN', async () => {
    const filePath = tmpPath();
    tempFiles.push(filePath);

    const writer = new WALWriterImpl({ filePath, syncInterval: 0 });
    await writer.initialize();

    for (let i = 1; i <= 5; i++) {
      await writer.append(makeUpdate(`entity-${i}`, i));
    }
    await writer.flush();
    await writer.close();

    const reader = new WALReaderImpl(filePath);
    await reader.initialize();

    // Collect via the async generator
    const results: WALEntry[] = [];
    for await (const entry of reader.readFrom(3)) {
      results.push(entry);
    }
    await reader.close();

    // LSNs 3, 4, 5 → 3 entries
    expect(results.length).toBe(3);
    results.forEach(e => expect(e.logSequenceNumber).toBeGreaterThanOrEqual(3));
  });

  // ── 4. getLastSequenceNumber returns correct LSN after writes ────────────

  it('getLastSequenceNumber returns the max LSN written', async () => {
    const filePath = tmpPath();
    tempFiles.push(filePath);

    const writer = new WALWriterImpl({ filePath, syncInterval: 0 });
    await writer.initialize();

    for (let i = 1; i <= 5; i++) {
      await writer.append(makeUpdate(`seq-entity-${i}`, i));
    }
    await writer.flush();
    await writer.close();

    const reader = new WALReaderImpl(filePath);
    await reader.initialize();
    const lastLSN = await reader.getLastSequenceNumber();
    await reader.close();

    expect(lastLSN).toBe(5);
  });

  // ── 5. replay calls handler for each valid entry ─────────────────────────

  it('replay calls the handler for each valid WAL entry', async () => {
    const filePath = tmpPath();
    tempFiles.push(filePath);

    const writer = new WALWriterImpl({ filePath, syncInterval: 0 });
    await writer.initialize();

    for (let i = 1; i <= 3; i++) {
      await writer.append(makeUpdate(`replay-entity-${i}`, i));
    }
    await writer.flush();
    await writer.close();

    const reader = new WALReaderImpl(filePath);
    await reader.initialize();

    const collected: WALEntry[] = [];
    await reader.replay(async (entry) => {
      collected.push(entry);
    });
    await reader.close();

    expect(collected.length).toBe(3);
  });
});
