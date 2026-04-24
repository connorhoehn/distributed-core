import * as fs from 'fs/promises';
import * as path from 'path';
import { WALFileImpl } from '../wal/WALFile';
import { WALEntry } from '../wal/types';
import { CompactionPlan, CompactionResult } from './types';

/**
 * Returns true only when every inputSegment.filePath in the plan exists on
 * disk.  Use as a gate before executeRealCompaction.
 */
export async function inputsExistOnDisk(plan: CompactionPlan): Promise<boolean> {
  if (plan.inputSegments.length === 0) {
    return false;
  }
  const results = await Promise.all(
    plan.inputSegments.map(seg =>
      fs.access(seg.filePath).then(() => true).catch(() => false)
    )
  );
  return results.every(Boolean);
}

/**
 * Runs real filesystem compaction for any strategy's CompactionPlan:
 * reads all input segment files, deduplicates entries by entityId (keeping
 * the latest by LSN), drops entities whose latest operation is DELETE,
 * writes one consolidated output segment to the same directory as the
 * first input, and unlinks the inputs.
 *
 * Callers should gate on file-existence of all input paths before
 * invoking this function; use `inputsExistOnDisk(plan)` to check.
 */
export async function executeRealCompaction(
  plan: CompactionPlan,
  startTime: number
): Promise<CompactionResult> {
  // Read all entries and measure input size from disk
  const allEntries: WALEntry[] = [];
  let totalSizeBefore = 0;
  for (const seg of plan.inputSegments) {
    const stats = await fs.stat(seg.filePath);
    totalSizeBefore += stats.size;
    const walFile = new WALFileImpl(seg.filePath);
    await walFile.open();
    try {
      const entries = await walFile.readEntries();
      allEntries.push(...entries);
    } finally {
      await walFile.close();
    }
  }

  // Deduplicate: keep the latest entry per entityId (by LSN, then timestamp)
  const latestByEntity = new Map<string, WALEntry>();
  for (const entry of allEntries) {
    const eid = entry.data.entityId;
    const existing = latestByEntity.get(eid);
    if (
      !existing ||
      entry.logSequenceNumber > existing.logSequenceNumber ||
      (entry.logSequenceNumber === existing.logSequenceNumber &&
        entry.data.timestamp > existing.data.timestamp)
    ) {
      latestByEntity.set(eid, entry);
    }
  }

  // Drop entities whose latest operation is DELETE (tombstone removal)
  const keptEntries: WALEntry[] = [];
  let tombstonedEntities = 0;
  for (const [, entry] of latestByEntity) {
    if (entry.data.operation === 'DELETE') {
      tombstonedEntities++;
    } else {
      keptEntries.push(entry);
    }
  }
  keptEntries.sort((a, b) => a.logSequenceNumber - b.logSequenceNumber);

  const totalEntries = allEntries.length;
  const totalTombstones = allEntries.filter(e => e.data.operation === 'DELETE').length;
  const entriesRemoved = totalEntries - keptEntries.length;
  const duplicatesRemoved = entriesRemoved - tombstonedEntities;

  // Write consolidated output into the same directory as the first input
  const outputSegmentId =
    plan.outputSegments[0]?.segmentId ?? `compacted-${Date.now()}`;
  const outputDir = path.dirname(plan.inputSegments[0].filePath);
  const outputPath = path.join(outputDir, `${outputSegmentId}.wal`);
  const outputWal = new WALFileImpl(outputPath);
  await outputWal.open();
  try {
    for (const entry of keptEntries) {
      await outputWal.append(entry);
    }
  } finally {
    await outputWal.close();
  }

  // Delete input segment files
  for (const seg of plan.inputSegments) {
    await fs.unlink(seg.filePath).catch(() => undefined);
  }

  const outputStats = await fs.stat(outputPath);
  const actualSpaceSaved = Math.max(0, totalSizeBefore - outputStats.size);

  return {
    planId: plan.planId,
    success: true,
    actualSpaceSaved,
    actualDuration: Date.now() - startTime,
    segmentsCreated: [
      {
        segmentId: outputSegmentId,
        filePath: outputPath,
        startLSN: plan.inputSegments[0]?.startLSN ?? 0,
        endLSN: plan.inputSegments[plan.inputSegments.length - 1]?.endLSN ?? 0,
        createdAt: Date.now(),
        sizeBytes: outputStats.size,
        entryCount: keptEntries.length,
        tombstoneCount: 0,
        isImmutable: true,
      },
    ],
    segmentsDeleted: plan.inputSegments.map(s => s.segmentId),
    metrics: {
      entriesProcessed: totalEntries,
      entriesCompacted: keptEntries.length,
      tombstonesRemoved: totalTombstones,
      duplicatesRemoved: Math.max(0, duplicatesRemoved),
    },
  };
}
