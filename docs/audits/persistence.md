# Audit: Persistence Layer

Date: 2026-04-23
Scope: `src/persistence/` — `wal/`, `snapshot/`, `compaction/`, `checkpoint/`, and root files

---

## Executive summary

The three highest-impact findings are: (1) `WALFile.truncate()` closes and
unlinks the file before writing kept entries back, so a crash between the
`unlink` and the final `flush()` leaves the file empty — all entries whose LSN
falls before the truncation point are silently lost with no temp-file safety net;
(2) `WALSnapshotVersionStore.compact()` deletes the WAL file before the new
compacted file has been fully flushed, so a crash between `unlink` and
`freshWriter.close()` leaves the store permanently empty; (3)
`checksumEnabled: config.checksumEnabled || true` always evaluates to `true`
regardless of what the caller passes, meaning passing `checksumEnabled: false`
is silently ignored — but more importantly, the WAL reader never consults the
`checksumEnabled` flag at all, so corrupt-but-not-zero-checksum entries are
filtered rather than halting replay, which can silently lose data.

---

## Critical findings (data-loss or unrecoverable corruption)

### C1. `WALFile.truncate()` — complete data loss window on crash

**File:** `src/persistence/wal/WALFile.ts:68–80`

The truncate sequence is:
1. Read all entries into memory
2. `close()` the file handle
3. `fs.unlink(this.filePath).catch(() => {})` — file is now gone
4. `open()` a new empty file
5. Re-append kept entries one by one
6. `flush()`

If the process dies at any point between step 3 and step 6 the WAL file is
either absent or partially written. On restart `readEntries()` returns an empty
array because ENOENT is silently swallowed (line 61–63). There is no temp-file
plus rename idiom here. The caller of `truncateBefore` in `WALWriter` also
resets the in-memory LSN counter (line 95) so after restart the coordinator
restarts from LSN 0 or the last LSN of whatever entries survived, overwriting
any LSN gap with new entries that could collide with replication peers.

No recovery is possible without a checkpoint that was written before the
truncate; even then, WAL entries written after that checkpoint are gone.

### C2. `WALSnapshotVersionStore.compact()` — store wiped on crash

**File:** `src/persistence/snapshot/WALSnapshotVersionStore.ts:250–298`

The compact sequence is:
1. Read all alive entries into memory
2. Close both writer and reader (line 250–251)
3. `unlink(this.filePath)` — store is now empty on disk
4. Create `freshWriter`, `initialize()`, write kept entries, `close()`
5. Reassign `this.writer` and `this.reader` to new instances

If the process dies between step 3 and step 4's `freshWriter.close()`, the WAL
file is either absent or partially written. On the next `initialize()` call the
reader opens a file that may contain zero to N–1 of the kept entries.
`readAlive()` will return an incomplete set and there is no way to distinguish
"partially compacted after unlink" from "never had any entries."

The fix is write-new-file → fsync → rename-over-old, which is what
`CheckpointWriter.writeSnapshot()` already does correctly (lines 36–42 of
`CheckpointWriter.ts`). The snapshot compaction skips that pattern entirely.

### C3. `latest.json` not written atomically in `CheckpointWriter`

**File:** `src/persistence/checkpoint/CheckpointWriter.ts:43–48`

`writeSnapshot()` correctly writes the checkpoint file via a temp-file + rename
(lines 36–40). However immediately after, it writes `latest.json` directly via
`fs.writeFile()` without a temp-file intermediary (lines 43–47). If the process
crashes between the rename of the checkpoint file and the completion of
`fs.writeFile(latestPath, …)`, the checkpoint file exists on disk under its
final name but `latest.json` still points to the previous checkpoint (or is
absent). On restart `CheckpointReader.readLatest()` will return the older
checkpoint even though a newer one is safely on disk. Recovery replay will
re-apply WAL entries that were already included in the new checkpoint, which is
not data loss but it is incorrect and may produce duplicate side effects
depending on idempotency of the replay handler.

---

## High-severity findings

### H1. Checksum flag always evaluates to `true`

**File:** `src/persistence/wal/WALWriter.ts:17`

```
checksumEnabled: config.checksumEnabled || true
```

`false || true` is `true`, so callers who explicitly pass `checksumEnabled:
false` get checksum validation enabled anyway. The intent is likely
`config.checksumEnabled ?? true` (nullish coalescing). This is a logic error
in a security/integrity control.

More consequentially, `WALReader` (lines 26–44 of `WALReader.ts`) validates
every entry via `coordinator.validateEntry(entry)` and silently skips invalid
ones with a `console.warn`. If a WAL entry is partially written (truncated mid-
JSON line) `JSON.parse` in `WALFile.readEntries()` throws and that entry is
skipped (line 54–56 of `WALFile.ts`). If the last-valid JSON line has a
mismatched checksum, `readAll()` filters it out. Either way the caller of
`replay()` sees fewer entries than were written and there is no error signal —
`replay()` logs a warning count but does not throw (line 75–77 of
`WALReader.ts`). The consequence is silent data loss on restart after a partial
write.

### H2. `isRunning` guard is not cleared when `executeRealCompaction` returns early

**File:** `src/persistence/compaction/SizeTieredCompactionStrategy.ts:106–163`,
`LeveledCompactionStrategy.ts:120–189`

`executeCompaction()` sets `this.metrics.isRunning = true` before the try-block,
then clears it in a `finally`. However the early-return path when
`inputsExistOnDisk(plan)` is true (line 112–116 / 126–130) returns *inside* the
try-block before reaching `updateMetrics()`. The `finally` block does run and
clears `isRunning`, so this is safe in those two strategies. But the base-class
`updateMetrics()` (types.ts:119–130) also sets `isRunning = false`; it is called
from inside the try on the real-compaction result but not from the early-return
path. The net effect is `isRunning` is cleared correctly but `metrics.successfulRuns`,
`metrics.totalSpaceSaved`, and averages are not updated for the real-compaction
path in `SizeTieredCompactionStrategy` and `LeveledCompactionStrategy`.
Compaction will continue to trigger because metrics indicate zero runs, leading
to repeated compaction storms on a large WAL.

`TimeBasedCompactionStrategy` (line 151) and `VacuumBasedCompactionStrategy`
(line 127) do call `updateMetrics(realResult)` before returning from the real
path, so they are not affected.

### H3. `WALFile.open()` is not concurrency-safe

**File:** `src/persistence/wal/WALFile.ts:14–23`

```ts
if (this.isOpen) return;
// ... async work ...
this.fileHandle = await fs.open(this.filePath, 'a+');
this.isOpen = true;
```

There is no promise-chain serialization. Two concurrent callers that both see
`isOpen === false` at the check will both proceed to `fs.open()`, resulting in
two file descriptors opened on the same path. Subsequent `fileHandle.write()`
calls from both callers interleave at the OS level. Because Node.js is single-
threaded within a tick this only triggers when two `await`-suspension points
occur between the `isOpen` check and the assignment on line 23, which is exactly
the case here. In practice `WALWriter` creates a single instance, but
`CompactionCoordinator.loadWALSegments()` (line 257) creates a new `WALReaderImpl`
(and thus a new `WALFileImpl`) per `.wal` file per compaction check; if two
checks overlap they each independently open the same file, which is safe for
reads but means `close()` from one leaks the other's file descriptor.

### H4. `WALFile.truncate()` swallows all `unlink` errors

**File:** `src/persistence/wal/WALFile.ts:74`

```ts
await fs.unlink(this.filePath).catch(() => {}); // Ignore if file doesn't exist
```

The comment says "ignore if file doesn't exist" but the catch swallows every
error, including `EACCES` (permission denied), `EBUSY` (file locked on
Windows), and I/O errors. A caller that expects truncation to have occurred will
silently be working with the original full file. The correct idiom is to catch
only `ENOENT`, propagate the rest:
```ts
.catch(e => { if (e.code !== 'ENOENT') throw e; })
```

### H5. `RealCompactionExecutor` unlinks inputs before syncing output

**File:** `src/persistence/compaction/RealCompactionExecutor.ts:99–106`

The output WAL file is written and the handle is closed (line 98) but there is
no explicit `fsync` on the output file's parent directory, and the unlink of
input segments happens immediately after. On Linux, `close()` does not guarantee
directory-entry durability. If the host machine crashes after `unlink` but
before the kernel flushes the output inode, the output file may be absent and
the inputs are gone. This is the standard "write + close + unlink inputs"
compaction race. The mitigation is to `fsync` the output file and the output
directory before unlinking inputs.

---

## Medium-severity findings

### M1. Simulation fallback fires in production when segment paths are relative

**File:** all four strategy `executeCompaction()` implementations

Each strategy gates on `inputsExistOnDisk(plan)` (e.g.
`SizeTieredCompactionStrategy.ts:112`). The segments fed to the plan come from
`CompactionCoordinator.loadWALSegments()` which builds `filePath` via
`path.join(walDir, file)` (line 264 of `CompactionCoordinator.ts`). If
`walDir` is a relative path (e.g. `./data/wal`), then `path.join` produces a
relative path. On restart from a different working directory those paths no
longer resolve, `fs.access()` returns false, and all four strategies silently
fall through to the simulation branch. The simulation branch returns
`success: true` and reports `segmentsDeleted` with the segment IDs — but
never actually touches the disk. The result is CompactionCoordinator believes
compaction succeeded, metrics are updated, but the WAL segments are still on
disk and the coordinator's in-memory view of segments drifts from reality.
The default `walPath` in `PersistenceFactory.createDefault()` is `'./data/wal/default.wal'`
(line 65), a relative path, which makes this the default production behavior.

### M2. `WALReader.readAll()` and `replay()` slurp entire WAL into RAM

**File:** `src/persistence/wal/WALReader.ts:35–46`, `52–53`

`readAll()` returns `Promise<WALEntry[]>`, materializing the full WAL contents
into a JavaScript array. `replay()` calls `readAll()` before starting the
handler loop. `WALFile.readEntries()` similarly reads the entire file into a
string via `fs.readFile(this.filePath, 'utf-8')` (WALFile.ts:41), then splits
on newlines. For a 100 MB WAL (the configured `maxFileSize`) this allocates
~100 MB string + ~100 MB array in one synchronous burst. `readFrom()` is an
`AsyncIterableIterator` but its first line calls `walFile.readEntries()` which
still slurps the whole file — streaming only applies to the yield loop, not
to the I/O.

`CompactionCoordinator.loadWALSegments()` instantiates a `WALReaderImpl` and
calls `readAll()` for *every* `.wal` file concurrently via `Promise.all`
(line 251). With many segment files this produces unbounded peak memory.

### M3. Checksum mismatch field — optional type allows checksum bypass

**File:** `src/persistence/wal/types.ts:7`

```ts
checksum?: string;
```

`WALCoordinator.validateEntry()` checks `entry.checksum === expectedChecksum`
(WALCoordinator.ts:27). If `entry.checksum` is `undefined` (as is legal by the
type) and `expectedChecksum` is a hex string, the comparison is `undefined ===
<hex>` which is `false`. The entry is then dropped by `WALReader.readAll()`.
Any entry written without a checksum (e.g., written by a different tool or an
older code version where `checksumEnabled` was actually false) will be silently
discarded on replay rather than accepted. The field should be required when
checksums are enabled, or validation should treat `undefined` checksum as valid
(skip validation) when the field is absent.

### M4. `WALWriter` starts periodic sync timer in constructor, before `initialize()`

**File:** `src/persistence/wal/WALWriter.ts:11–24`

`setupPeriodicSync()` is called from the constructor (line 23), so the first
sync fires up to 1 s after construction. `initialize()` is async and must be
called separately (seen in `WALSnapshotVersionStore.initialize()` at line 84).
Any `append()` call in that window throws "WAL file not open." Periodic syncs
in the window no-op silently (null-handle check at WALFile.ts:102) so sync
progress is not tracked and callers have no signal that flushes are being skipped.

### M5. `CompactionCoordinator.stop()` busy-waits with `setTimeout(resolve, 1000)`

**File:** `src/persistence/compaction/CompactionCoordinator.ts:73–76`

```ts
while (this.runningCompactions.size > 0) {
  await new Promise(resolve => setTimeout(resolve, 1000));
}
```

There is no maximum wait time or cancellation signal. If a compaction hangs
(e.g., large WAL, slow disk), `stop()` never returns. This blocks clean shutdown
indefinitely. The same pattern appears in `switchStrategy()` (line 138–140).

### M6. `WALSnapshotVersionStore.compact()` replaces writer/reader with no guard

**File:** `src/persistence/snapshot/WALSnapshotVersionStore.ts:250–298`

Between `writer.close()` (line 250) and reassignment of `this.writer` (line 288),
a concurrent `store()` or `delete()` call invokes `append()` on the closed writer
and throws "WAL file not open." There is no mutex or in-progress flag. A caller
racing `compact()` gets an unhandled rejection with no recovery path.

### M7. `CheckpointReader.readLatest()` silently returns `null` for all errors

**File:** `src/persistence/checkpoint/CheckpointReader.ts:19–32`

The catch clause returns `null` for every error including I/O errors, permission
errors, and partially-written JSON. At startup the caller (e.g.
`CompactionCoordinator.triggerCompactionCheck()` line 96) treats `null` as "no
checkpoint" and may schedule unnecessary compaction or replay the entire WAL,
when the real issue is an I/O failure that will recur on every attempt. At
minimum `ENOENT` should be distinguished from other errors; non-ENOENT errors
should be rethrown or logged with severity.

---

## Low-severity findings

### L1. `WALWriter.truncateBefore()` can regress the LSN counter

**File:** `src/persistence/wal/WALWriter.ts:89–97`

After truncation, `getLastLSN()` re-reads the file and if the result is less
than `coordinator.getCurrentLSN()` the coordinator is reset (line 95). If
the truncation retains entries up to LSN 500 but the in-flight coordinator
is at LSN 600, the reset drops it back to 500. The next `append()` call
emits LSN 501, which collides with entries that were already appended between
501 and 600. If those entries exist in a replica or upstream checkpoint they
create a diverged log.

### L2. `VacuumBasedCompactionStrategy` `identifyHotData()` is dead code

**File:** `src/persistence/compaction/VacuumBasedCompactionStrategy.ts:206–230`

`identifyHotData()` is a private method that is never called. The method
computes a hot-segment score but the result is unused by `planCompaction()`.
Dead code in a strategy class creates maintenance confusion about what the
strategy actually does.

### L3. `BroadcastBuffer` and root `WriteAheadLog` are unbounded in-memory

**File:** `src/persistence/BroadcastBuffer.ts:4`, `WriteAheadLog.ts:4`

Both root-level stubs accumulate entries in plain arrays with no size limit. The
`IWriteAheadLog` / `IBroadcastBuffer` interfaces have no capacity contract, so
implementations that replace the stubs can grow without bound with no warning.

### L4. Checksum depends on V8 key-order stability of `JSON.stringify`

**File:** `src/persistence/wal/WALCoordinator.ts:19–27`

`calculateChecksum` hashes `JSON.stringify(data)`. V8 preserves insertion order
for plain objects, but this is not guaranteed by ECMAScript. Any serialization
change that reorders keys (schema migration, cross-runtime replay) will cause
every entry to fail checksum validation and be silently dropped by `WALReader`.

### L5. `loadWALSegments()` silently excludes unreadable segments

**File:** `src/persistence/compaction/CompactionCoordinator.ts:288`

The per-file `catch` returns `null` for any error, including corrupted segments.
A segment with checksum errors produces a `WALSegment` with understated
`entryCount` / `tombstoneCount`; a segment that throws during `stat` or `open`
is dropped entirely. Both cases hide segments from the coordinator while they
continue to grow on disk.

### L6. `WALFile.readEntries()` lazy-opens a handle it never reads through

**File:** `src/persistence/wal/WALFile.ts:36–41`

The guard at line 36–38 calls `this.open()`, but line 41 reads via
`fs.readFile(this.filePath, 'utf-8')` — not through the file handle. The handle
is opened unnecessarily for read-only callers and the guard gives false assurance
that the file is in a consistent state before reading.

---

## Findings summary

| ID | Severity | Area | One-line description |
|----|----------|------|----------------------|
| C1 | Critical | WAL | `truncate()` unlinks before rewrite — empty file on crash |
| C2 | Critical | Snapshot | `compact()` unlinks before new file flushed — store wiped on crash |
| C3 | Critical | Checkpoint | `latest.json` written non-atomically — stale pointer after crash |
| H1 | High | WAL | `checksumEnabled: x \|\| true` always true; reader silently drops corrupt entries |
| H2 | High | Compaction | `updateMetrics()` skipped on real-compaction path in 2 of 4 strategies |
| H3 | High | WAL | `WALFile.open()` has concurrent-open race |
| H4 | High | WAL | `truncate()` swallows all `unlink` errors, not just ENOENT |
| H5 | High | Compaction | Input segments unlinked before output synced to disk |
| M1 | Medium | Compaction | Simulation fallback fires silently when segment paths are relative |
| M2 | Medium | WAL | Full WAL read into RAM; `readFrom()` streaming is superficial |
| M3 | Medium | WAL | `checksum?: string` optional — entries without checksum silently discarded |
| M4 | Medium | WAL | Sync timer starts before `initialize()`, write before open throws |
| M5 | Medium | Compaction | `stop()` busy-waits forever; no shutdown timeout |
| M6 | Medium | Snapshot | Concurrent `store()` during `compact()` hits closed writer |
| M7 | Medium | Checkpoint | Reader silently returns null for all errors including I/O failures |
| L1 | Low | WAL | `truncateBefore()` can regress LSN counter, creating log divergence |
| L2 | Low | Compaction | `VacuumBasedCompactionStrategy.identifyHotData()` is dead code |
| L3 | Low | Core | Root `BroadcastBuffer` / `WriteAheadLog` stubs are unbounded |
| L4 | Low | WAL | Checksum depends on V8 key-order stability of `JSON.stringify` |
| L5 | Low | Compaction | Unreadable segments silently excluded from compaction candidates |
| L6 | Low | WAL | Lazy-open in `readEntries()` opens a handle it never reads through |

**Totals:** 3 Critical · 5 High · 7 Medium · 6 Low = **21 findings**

---

## Top three priorities

**Priority 1 — C1 + C2: Both truncate/compact operations delete before rewriting (data-loss on crash)**

`WALFile.truncate()` (WALFile.ts:68–80) and `WALSnapshotVersionStore.compact()`
(WALSnapshotVersionStore.ts:250–298) share the same anti-pattern: they delete
the live file, then write a new one. A crash anywhere in that window leaves the
store permanently empty with no recovery path. Both should be converted to
write-new-temp → fsync → rename-over-old, exactly the pattern already used
correctly in `CheckpointWriter.writeSnapshot()` (CheckpointWriter.ts:34–42).

**Priority 2 — C3 + H5: Two more non-atomic file operations create corruption windows**

`latest.json` in `CheckpointWriter` is updated with a bare `fs.writeFile` (not
through a temp-file rename), so a crash leaves the checkpoint directory in a
state where the checkpoint file is newer than what `latest.json` references.
In `RealCompactionExecutor`, input segments are unlinked before the output
file's directory entry has been synced. Both need the same temp-file + fsync +
rename + directory-fsync idiom.

**Priority 3 — H1: Checksum logic has two independent defects that together allow silent data loss on replay**

The `||` vs `??` mistake in `WALWriter.ts:17` means callers cannot disable
checksums. More critically, `WALReader.readAll()` silently drops entries that
fail checksum validation. On a partially-written WAL (e.g. after power loss
during an `append`) the last record's checksum will not match, and that record
is quietly excluded from replay with only a `console.warn`. Applications that
use `replay()` for crash recovery will consistently lose the last committed
write. Fix: change `||` to `??`; and in `WALReader.replay()` treat a checksum
failure as a hard error unless the entry is the last line and is a partial JSON
record (which indicates an incomplete write and is recoverable by truncation).
