import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { WALFileImpl } from '../../../../src/persistence/wal/WALFile';
import * as atomicWriteModule from '../../../../src/persistence/atomicWrite';
import { WALEntry } from '../../../../src/persistence/wal/types';

function tmpFilePath(): string {
  return path.join(os.tmpdir(), `walfile-test-${randomUUID()}.wal`);
}

function makeEntry(lsn: number): WALEntry {
  return {
    logSequenceNumber: lsn,
    timestamp: Date.now(),
    data: {
      entityId: `entity-${lsn}`,
      version: lsn,
      timestamp: Date.now(),
      operation: 'UPDATE',
    },
    checksum: 'dummy',
  };
}

// ---------------------------------------------------------------------------
// Happy-path smoke tests (ensure the refactor didn't break basic behaviour)
// ---------------------------------------------------------------------------
describe('WALFileImpl', () => {
  let filePath: string;
  let walFile: WALFileImpl;

  beforeEach(async () => {
    filePath = tmpFilePath();
    walFile = new WALFileImpl(filePath);
    await walFile.open();
  });

  afterEach(async () => {
    await walFile.close().catch(() => {});
    await fs.unlink(filePath).catch(() => {});
  });

  test('appends entries and reads them back', async () => {
    await walFile.append(makeEntry(1));
    await walFile.append(makeEntry(2));
    const entries = await walFile.readEntries();
    expect(entries.map(e => e.logSequenceNumber)).toEqual([1, 2]);
  });

  test('truncate keeps only entries >= beforeLSN', async () => {
    for (let i = 1; i <= 5; i++) {
      await walFile.append(makeEntry(i));
    }
    await walFile.truncate(3);
    const entries = await walFile.readEntries();
    expect(entries.map(e => e.logSequenceNumber)).toEqual([3, 4, 5]);
  });

  test('truncate with beforeLSN higher than all entries results in empty file', async () => {
    for (let i = 1; i <= 3; i++) {
      await walFile.append(makeEntry(i));
    }
    await walFile.truncate(100);
    const entries = await walFile.readEntries();
    expect(entries).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Atomicity regression tests (C1 fix)
  // ---------------------------------------------------------------------------
  describe('atomicity', () => {
    test('temp file does NOT survive a successful truncate', async () => {
      for (let i = 1; i <= 3; i++) {
        await walFile.append(makeEntry(i));
      }
      await walFile.truncate(2);

      // The temp file pattern is <finalPath>.<pid>.tmp
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await expect(fs.access(tmpPath)).rejects.toThrow();
    });

    test('original file is intact when rename throws mid-operation', async () => {
      // Write entries 1-5 to the live file so there is durable content.
      for (let i = 1; i <= 5; i++) {
        await walFile.append(makeEntry(i));
      }
      await walFile.flush();

      // Capture original content before the failing truncate.
      const originalContent = await fs.readFile(filePath, 'utf-8');

      // Make fs.rename throw — simulating a crash right before the atomic swap.
      const renameSpy = jest.spyOn(fs, 'rename').mockRejectedValueOnce(
        new Error('Simulated rename failure'),
      );

      try {
        await expect(walFile.truncate(3)).rejects.toThrow('Simulated rename failure');
      } finally {
        renameSpy.mockRestore();
      }

      // The original file must still be present and unchanged.
      const afterContent = await fs.readFile(filePath, 'utf-8');
      expect(afterContent).toBe(originalContent);

      // The temp file must have been cleaned up by atomicWriteFile's error handler.
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await expect(fs.access(tmpPath)).rejects.toThrow();
    });

    test('truncate goes through atomicWriteFile (rename is called exactly once)', async () => {
      for (let i = 1; i <= 2; i++) {
        await walFile.append(makeEntry(i));
      }

      const atomicWriteSpy = jest.spyOn(atomicWriteModule, 'atomicWriteFile');
      try {
        await walFile.truncate(1);
        expect(atomicWriteSpy).toHaveBeenCalledTimes(1);
      } finally {
        atomicWriteSpy.mockRestore();
      }
    });
  });
});
