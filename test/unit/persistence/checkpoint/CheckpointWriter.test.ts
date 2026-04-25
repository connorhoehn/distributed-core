import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { CheckpointWriterImpl } from '../../../../src/persistence/checkpoint/CheckpointWriter';
import { EntityState } from '../../../../src/persistence/checkpoint/types';

function tmpDir(): string {
  return path.join(os.tmpdir(), `checkpoint-test-${randomUUID()}`);
}

function makeEntities(): Record<string, EntityState> {
  return {
    'entity-1': {
      id: 'entity-1',
      type: 'test',
      data: { value: 42 },
      version: 1,
      hostNodeId: 'node-1',
      lastModified: Date.now(),
    },
  };
}

// ---------------------------------------------------------------------------
// Happy-path smoke tests
// ---------------------------------------------------------------------------
describe('CheckpointWriterImpl', () => {
  let checkpointDir: string;
  let writer: CheckpointWriterImpl;

  beforeEach(async () => {
    checkpointDir = tmpDir();
    writer = new CheckpointWriterImpl({ checkpointPath: checkpointDir, keepHistory: 5 });
  });

  afterEach(async () => {
    await fs.rm(checkpointDir, { recursive: true, force: true });
  });

  test('writeSnapshot creates the checkpoint file and latest.json', async () => {
    await writer.writeSnapshot(1, makeEntities());

    const files = await fs.readdir(checkpointDir);
    expect(files).toContain('latest.json');
    expect(files.some(f => f.startsWith('checkpoint-lsn-'))).toBe(true);
  });

  test('latest.json references the correct lsn and filename', async () => {
    await writer.writeSnapshot(42, makeEntities());

    const latestRaw = await fs.readFile(path.join(checkpointDir, 'latest.json'), 'utf-8');
    const latest = JSON.parse(latestRaw) as { lsn: number; filename: string };
    expect(latest.lsn).toBe(42);
    expect(latest.filename).toMatch(/checkpoint-lsn-/);
  });

  test('calling writeSnapshot twice updates latest.json to the newer lsn', async () => {
    await writer.writeSnapshot(10, makeEntities());
    await writer.writeSnapshot(20, makeEntities());

    const latestRaw = await fs.readFile(path.join(checkpointDir, 'latest.json'), 'utf-8');
    const latest = JSON.parse(latestRaw) as { lsn: number };
    expect(latest.lsn).toBe(20);
  });

  // -----------------------------------------------------------------------
  // Atomicity regression tests (C3 fix)
  // -----------------------------------------------------------------------
  describe('atomicity', () => {
    test('latest.json written atomically — temp file does not survive a successful write', async () => {
      await writer.writeSnapshot(5, makeEntities());

      const latestPath = path.join(checkpointDir, 'latest.json');
      const tmpPath = `${latestPath}.${process.pid}.tmp`;
      await expect(fs.access(tmpPath)).rejects.toThrow();
    });

    test('partial latest.json does not exist after a successful write', async () => {
      await writer.writeSnapshot(7, makeEntities());

      const files = await fs.readdir(checkpointDir);
      const partials = files.filter(f => f.startsWith('latest.json.') && f.endsWith('.tmp'));
      expect(partials).toHaveLength(0);
    });

    test('if rename for latest.json throws, the original latest.json is left untouched', async () => {
      // Write a baseline snapshot so latest.json already exists.
      await writer.writeSnapshot(1, makeEntities());
      const originalLatest = await fs.readFile(
        path.join(checkpointDir, 'latest.json'),
        'utf-8',
      );

      const latestPath = path.join(checkpointDir, 'latest.json');
      const latestTmpPath = `${latestPath}.${process.pid}.tmp`;

      // Only block the rename that targets latest.json (i.e. the src is the
      // latest.json temp file).  Let the checkpoint-file rename through.
      const realRename = fs.rename.bind(fs);
      const renameSpy = jest.spyOn(fs, 'rename').mockImplementation(
        async (src: string | Buffer | URL, dst: string | Buffer | URL) => {
          if (String(src) === latestTmpPath) {
            throw new Error('Simulated latest.json rename failure');
          }
          return realRename(src, dst);
        },
      );

      try {
        await expect(writer.writeSnapshot(2, makeEntities())).rejects.toThrow(
          'Simulated latest.json rename failure',
        );
      } finally {
        renameSpy.mockRestore();
      }

      // latest.json must still contain lsn:1, not lsn:2.
      const afterLatest = await fs.readFile(
        path.join(checkpointDir, 'latest.json'),
        'utf-8',
      );
      expect(afterLatest).toBe(originalLatest);

      // No stale temp file for latest.json.
      await expect(fs.access(latestTmpPath)).rejects.toThrow();
    });
  });
});
