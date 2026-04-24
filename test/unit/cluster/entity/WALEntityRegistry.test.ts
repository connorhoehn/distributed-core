import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import {
  WriteAheadLogEntityRegistry,
  WALEntityRegistryCompactionResult,
} from '../../../../src/cluster/entity/WriteAheadLogEntityRegistry';

jest.mock('fs/promises', () => ({
  ...jest.requireActual('fs/promises'),
}));

jest.setTimeout(15000);

function makeTmpPath(): string {
  return path.join(os.tmpdir(), randomUUID(), 'entity.wal');
}

async function makeRegistry(filePath: string): Promise<WriteAheadLogEntityRegistry> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const registry = new WriteAheadLogEntityRegistry('node-1', {
    filePath,
    syncInterval: 0,
    interval: 0,
    lsnThreshold: 0,
    checkpointPath: path.join(path.dirname(filePath), 'checkpoints'),
  });
  await registry.start();
  return registry;
}

describe('WriteAheadLogEntityRegistry — compact()', () => {
  let filePath: string;
  let registry: WriteAheadLogEntityRegistry;

  beforeEach(async () => {
    filePath = makeTmpPath();
    registry = await makeRegistry(filePath);
  });

  afterEach(async () => {
    await registry.stop().catch(() => {});
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  });

  it('propose → release → propose: tombstone collapses to 0 alive entries', async () => {
    await registry.proposeEntity('e1');
    await registry.releaseEntity('e1');
    await registry.proposeEntity('e1');
    await registry.releaseEntity('e1');

    const result: WALEntityRegistryCompactionResult = await registry.compact();

    expect(result.entriesBefore).toBe(4);
    expect(result.entriesKept).toBe(0);
    expect(result.entriesRemoved).toBe(4);
    expect(result.entitiesAlive).toBe(0);
  });

  it('5 propose on different ids → compact keeps 5 entries', async () => {
    for (let i = 0; i < 5; i++) {
      await registry.proposeEntity(`entity-${i}`);
    }

    const result: WALEntityRegistryCompactionResult = await registry.compact();

    expect(result.entriesBefore).toBe(5);
    expect(result.entriesKept).toBe(5);
    expect(result.entriesRemoved).toBe(0);
    expect(result.entitiesAlive).toBe(5);
  });

  it('propose → update → update → update on same id → compact keeps 1 entry', async () => {
    await registry.proposeEntity('e1', { v: 0 });
    await registry.updateEntity('e1', { v: 1 });
    await registry.updateEntity('e1', { v: 2 });
    await registry.updateEntity('e1', { v: 3 });

    const result: WALEntityRegistryCompactionResult = await registry.compact();

    expect(result.entriesBefore).toBe(4);
    expect(result.entriesKept).toBe(1);
    expect(result.entriesRemoved).toBe(3);
    expect(result.entitiesAlive).toBe(1);
  });

  it('compact after no-ops returns zero counts without error', async () => {
    const result: WALEntityRegistryCompactionResult = await registry.compact();

    expect(result.entriesBefore).toBe(0);
    expect(result.entriesKept).toBe(0);
    expect(result.entriesRemoved).toBe(0);
    expect(result.entitiesAlive).toBe(0);
  });

  it('tombstones are honored: propose A + B, release A → only B remains', async () => {
    await registry.proposeEntity('id-A');
    await registry.proposeEntity('id-B');
    await registry.releaseEntity('id-A');

    const result: WALEntityRegistryCompactionResult = await registry.compact();

    expect(result.entitiesAlive).toBe(1);
    expect(result.entriesKept).toBe(1);
    expect(result.entriesRemoved).toBe(2);

    const alive = registry.getAllKnownEntities();
    expect(alive.map(e => e.entityId)).toEqual(['id-B']);
  });

  it('subsequent propose/release operations still work correctly after compact', async () => {
    await registry.proposeEntity('pre-compact');
    await registry.compact();

    await registry.proposeEntity('post-compact');
    const entity = registry.getEntity('post-compact');
    expect(entity).not.toBeNull();
    expect(entity!.entityId).toBe('post-compact');

    await registry.releaseEntity('pre-compact');
    expect(registry.getEntity('pre-compact')).toBeNull();
  });

  it('re-initialize from WAL after compact sees the same state (no data loss)', async () => {
    await registry.proposeEntity('persist-me', { keep: true });
    await registry.proposeEntity('delete-me');
    await registry.releaseEntity('delete-me');

    await registry.compact();
    await registry.stop();

    const registry2 = await makeRegistry(filePath);
    try {
      const entities = registry2.getAllKnownEntities();
      expect(entities.length).toBe(1);
      expect(entities[0].entityId).toBe('persist-me');
    } finally {
      await registry2.stop();
    }
  });

  it('propagates non-ENOENT unlink errors', async () => {
    await registry.proposeEntity('e1');

    const unlinkSpy = jest.spyOn(fs, 'unlink').mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
    );

    try {
      await expect(registry.compact()).rejects.toThrow('Permission denied');
    } finally {
      unlinkSpy.mockRestore();
    }
  });
});
