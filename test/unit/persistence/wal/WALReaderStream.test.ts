import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { WALReaderImpl } from '../../../../src/persistence/wal/WALReader';
import { WALFileImpl } from '../../../../src/persistence/wal/WALFile';
import { WALEntry } from '../../../../src/persistence/wal/types';

// NB: this file deliberately does NOT mock WALFile — readEntries() streams
// directly from disk via fs.createReadStream, so a real on-disk WAL is needed.

function tempPath(): string {
  return path.join(os.tmpdir(), `wal-stream-${randomUUID()}.wal`);
}

async function writeEntries(filePath: string, count: number): Promise<void> {
  const file = new WALFileImpl(filePath);
  await file.open();
  try {
    for (let i = 1; i <= count; i++) {
      const update = {
        entityId: `e-${i}`,
        version: i,
        timestamp: 1000 + i,
        operation: 'CREATE' as const,
      };
      const checksum = crypto.createHash('sha256').update(JSON.stringify(update)).digest('hex');
      await file.append({
        logSequenceNumber: i,
        timestamp: 1000 + i,
        data: update,
        checksum,
      });
    }
  } finally {
    await file.close();
  }
}

describe('WALReaderImpl.readEntries (streaming)', () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const p of created.splice(0)) {
      await fs.unlink(p).catch(() => undefined);
    }
  });

  test('yields all entries from a real WAL file in LSN order', async () => {
    const p = tempPath();
    created.push(p);
    await writeEntries(p, 25);

    const reader = new WALReaderImpl(p);
    await reader.initialize();
    try {
      const seen: number[] = [];
      for await (const entry of reader.readEntries()) {
        seen.push(entry.logSequenceNumber);
      }
      expect(seen).toHaveLength(25);
      for (let i = 0; i < seen.length; i++) {
        expect(seen[i]).toBe(i + 1);
      }
    } finally {
      await reader.close();
    }
  });

  test('respects startLSN and endLSN bounds', async () => {
    const p = tempPath();
    created.push(p);
    await writeEntries(p, 10);

    const reader = new WALReaderImpl(p);
    await reader.initialize();
    try {
      const seen: number[] = [];
      for await (const entry of reader.readEntries(3, 7)) {
        seen.push(entry.logSequenceNumber);
      }
      expect(seen).toEqual([3, 4, 5, 6, 7]);
    } finally {
      await reader.close();
    }
  });

  test('yields nothing when file does not exist', async () => {
    const p = tempPath(); // never written
    const reader = new WALReaderImpl(p);
    await reader.initialize();
    try {
      const seen: WALEntry[] = [];
      for await (const entry of reader.readEntries()) {
        seen.push(entry);
      }
      expect(seen).toEqual([]);
    } finally {
      await reader.close();
    }
  });

  test('skips malformed lines without throwing', async () => {
    const p = tempPath();
    created.push(p);
    await writeEntries(p, 3);

    // Append a bogus line directly.
    const handle = await fs.open(p, 'a');
    try {
      await handle.write('this is not valid json\n');
    } finally {
      await handle.close();
    }

    // Append one more valid entry so we know iteration recovers.
    const file = new WALFileImpl(p);
    await file.open();
    try {
      const update = {
        entityId: 'e-4',
        version: 4,
        timestamp: 1004,
        operation: 'CREATE' as const,
      };
      const checksum = crypto.createHash('sha256').update(JSON.stringify(update)).digest('hex');
      await file.append({
        logSequenceNumber: 4,
        timestamp: 1004,
        data: update,
        checksum,
      });
    } finally {
      await file.close();
    }

    const reader = new WALReaderImpl(p);
    await reader.initialize();
    try {
      const seen: number[] = [];
      for await (const entry of reader.readEntries()) {
        seen.push(entry.logSequenceNumber);
      }
      expect(seen).toEqual([1, 2, 3, 4]);
    } finally {
      await reader.close();
    }
  });
});
