/**
 * WAL Write Throughput Benchmark
 * Run: npx ts-node benchmarks/wal-throughput.ts
 */

import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { WALWriterImpl } from '../src/persistence/wal/WALWriter';
import { EntityUpdate, WALConfig } from '../src/persistence/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BenchmarkResult {
  name: string;
  entries: number;
  totalMs: number;
  opsPerSec: number;
  mbPerSec?: number;
  note?: string;
}

const results: BenchmarkResult[] = [];

function generatePayload(sizeBytes: number): Record<string, unknown> {
  // Build a JSON-friendly payload that serialises to roughly `sizeBytes`
  const filler = 'x'.repeat(Math.max(0, sizeBytes - 20));
  return { d: filler };
}

function makeUpdate(payload: Record<string, unknown>, index: number): EntityUpdate {
  return {
    entityId: `entity-${index}`,
    changes: payload,
    timestamp: Date.now(),
    version: 1,
    operation: 'UPDATE',
  };
}

async function makeTempDir(label: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `wal-bench-${label}-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function cleanDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

function formatTable(rows: BenchmarkResult[]): string {
  const header = [
    'Benchmark'.padEnd(52),
    'Entries'.padStart(8),
    'Time (ms)'.padStart(11),
    'ops/sec'.padStart(12),
    'MB/sec'.padStart(10),
    'Note',
  ];
  const sep = header.map((h) => '-'.repeat(h.length));

  const lines: string[] = [];
  lines.push(header.join(' | '));
  lines.push(sep.join('-+-'));
  for (const r of rows) {
    lines.push(
      [
        r.name.padEnd(52),
        String(r.entries).padStart(8),
        r.totalMs.toFixed(1).padStart(11),
        r.opsPerSec.toFixed(0).padStart(12),
        r.mbPerSec !== undefined ? r.mbPerSec.toFixed(2).padStart(10) : ''.padStart(10),
        r.note ?? '',
      ].join(' | '),
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Individual benchmarks
// ---------------------------------------------------------------------------

async function benchSequentialWrites(): Promise<void> {
  const COUNT = 10_000;
  const payload = generatePayload(100); // 100B baseline
  const dir = await makeTempDir('seq');

  const writer = new WALWriterImpl({
    filePath: path.join(dir, 'entity.wal'),
    syncInterval: 1000,
    checksumEnabled: true,
  });
  await writer.initialize();

  const start = performance.now();
  for (let i = 0; i < COUNT; i++) {
    await writer.append(makeUpdate(payload, i));
  }
  await writer.flush();
  const elapsed = performance.now() - start;

  await writer.close();

  results.push({
    name: 'Sequential writes (10k, 100B, checksum, sync=1000ms)',
    entries: COUNT,
    totalMs: elapsed,
    opsPerSec: (COUNT / elapsed) * 1000,
  });

  await cleanDir(dir);
}

async function benchPayloadSizes(): Promise<void> {
  const COUNT = 2_000;
  const sizes = [
    { label: '100B', bytes: 100 },
    { label: '1KB', bytes: 1_024 },
    { label: '10KB', bytes: 10_240 },
    { label: '100KB', bytes: 102_400 },
  ];

  for (const { label, bytes } of sizes) {
    const payload = generatePayload(bytes);
    const dir = await makeTempDir(`size-${label}`);

    const writer = new WALWriterImpl({
      filePath: path.join(dir, 'entity.wal'),
      syncInterval: 1000,
      checksumEnabled: true,
    });
    await writer.initialize();

    const start = performance.now();
    for (let i = 0; i < COUNT; i++) {
      await writer.append(makeUpdate(payload, i));
    }
    await writer.flush();
    const elapsed = performance.now() - start;

    await writer.close();

    const totalBytes = bytes * COUNT;
    results.push({
      name: `Payload ${label} (${COUNT} entries)`,
      entries: COUNT,
      totalMs: elapsed,
      opsPerSec: (COUNT / elapsed) * 1000,
      mbPerSec: (totalBytes / (1024 * 1024)) / (elapsed / 1000),
    });

    await cleanDir(dir);
  }
}

async function benchChecksumToggle(): Promise<void> {
  const COUNT = 5_000;
  const payload = generatePayload(1_024);

  for (const checksumEnabled of [true, false]) {
    const label = checksumEnabled ? 'enabled' : 'disabled';
    const dir = await makeTempDir(`cksum-${label}`);

    const writer = new WALWriterImpl({
      filePath: path.join(dir, 'entity.wal'),
      syncInterval: 1000,
      checksumEnabled,
    });
    await writer.initialize();

    const start = performance.now();
    for (let i = 0; i < COUNT; i++) {
      await writer.append(makeUpdate(payload, i));
    }
    await writer.flush();
    const elapsed = performance.now() - start;

    await writer.close();

    results.push({
      name: `Checksum ${label} (${COUNT} x 1KB)`,
      entries: COUNT,
      totalMs: elapsed,
      opsPerSec: (COUNT / elapsed) * 1000,
    });

    await cleanDir(dir);
  }
}

async function benchSyncInterval(): Promise<void> {
  const COUNT = 5_000;
  const payload = generatePayload(1_024);

  for (const syncInterval of [0, 1000]) {
    const label = syncInterval === 0 ? 'every-write' : 'batched-1000ms';
    const dir = await makeTempDir(`sync-${label}`);

    const writer = new WALWriterImpl({
      filePath: path.join(dir, 'entity.wal'),
      syncInterval,
      checksumEnabled: true,
    });
    await writer.initialize();

    const start = performance.now();
    for (let i = 0; i < COUNT; i++) {
      await writer.append(makeUpdate(payload, i));
    }
    await writer.flush();
    const elapsed = performance.now() - start;

    await writer.close();

    results.push({
      name: `Sync interval ${label} (${COUNT} x 1KB)`,
      entries: COUNT,
      totalMs: elapsed,
      opsPerSec: (COUNT / elapsed) * 1000,
      note: syncInterval === 0 ? 'sync every write' : 'periodic sync',
    });

    await cleanDir(dir);
  }
}

async function benchSegmentRotation(): Promise<void> {
  // Use a tiny maxFileSize so rotation triggers frequently
  const SEGMENT_SIZE = 50 * 1024; // 50KB segments
  const payload = generatePayload(1_024); // 1KB per entry => ~50 entries per segment
  const COUNT = 2_000; // should trigger ~40 rotations
  const dir = await makeTempDir('rotation');

  const writer = new WALWriterImpl({
    filePath: path.join(dir, 'entity.wal'),
    maxFileSize: SEGMENT_SIZE,
    syncInterval: 1000,
    checksumEnabled: true,
  });
  await writer.initialize();

  const start = performance.now();
  for (let i = 0; i < COUNT; i++) {
    await writer.append(makeUpdate(payload, i));
  }
  await writer.flush();
  const elapsed = performance.now() - start;

  const segments = writer.getSegments();
  await writer.close();

  results.push({
    name: `Segment rotation (50KB segs, ${COUNT} x 1KB)`,
    entries: COUNT,
    totalMs: elapsed,
    opsPerSec: (COUNT / elapsed) * 1000,
    note: `${segments.length} segments created`,
  });

  await cleanDir(dir);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('WAL Write Throughput Benchmark');
  console.log('='.repeat(60));
  console.log(`Platform : ${os.platform()} ${os.arch()}`);
  console.log(`Node     : ${process.version}`);
  console.log(`CPUs     : ${os.cpus().length}x ${os.cpus()[0].model}`);
  console.log(`Memory   : ${(os.totalmem() / (1024 ** 3)).toFixed(1)} GB`);
  console.log('='.repeat(60));
  console.log();

  console.log('[1/5] Sequential writes ...');
  await benchSequentialWrites();

  console.log('[2/5] Varying payload sizes ...');
  await benchPayloadSizes();

  console.log('[3/5] Checksum enabled vs disabled ...');
  await benchChecksumToggle();

  console.log('[4/5] Sync interval comparison ...');
  await benchSyncInterval();

  console.log('[5/5] Segment rotation overhead ...');
  await benchSegmentRotation();

  console.log();
  console.log('Results');
  console.log('='.repeat(120));
  console.log(formatTable(results));
  console.log('='.repeat(120));
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
