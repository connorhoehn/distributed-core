# Changelog

## Unreleased

### Added
- `LifecycleAware` interface in `src/common/LifecycleAware.ts`. All primitives
  with explicit start/stop now declare `implements LifecycleAware` and expose
  `isStarted(): boolean`. Calls to `start()` and `stop()` are now idempotent.
- `CoreError` base class and subclasses (`NotStartedError`, `AlreadyStartedError`,
  `ConflictError`, `TimeoutError`) in `src/common/errors.ts`. Existing thrown
  `Error` instances are unchanged in this release; use the new types in new code.
- `ConfigManager` + `ServiceRegistry` primitives (typed distributed config,
  service discovery with selection strategies).
- `examples/cluster-collab/` end-to-end demo composing 9 primitives.
- `README.md` and `docs/ARCHITECTURE.md`.
- `RealCompactionExecutor` module (`src/persistence/compaction/`). All four
  compaction strategies (`TimeBasedCompactionStrategy`,
  `SizeTieredCompactionStrategy`, `LeveledCompactionStrategy`,
  `VacuumBasedCompactionStrategy`) now perform real filesystem compaction
  when input segment files exist on disk — read, dedupe by entityId
  (latest LSN wins), drop tombstoned entities, write consolidated segment,
  unlink inputs. Falls back to the original computed-metrics simulation
  when paths are fake (preserving unit-test compatibility).

### Fixed
- `InMemoryEntityRegistry.applyRemoteUpdate` now emits `entity:created` /
  `entity:updated` / `entity:deleted` / `entity:transferred` events,
  matching local-mutation paths. Required for `ConfigManager`,
  `EntityRegistrySyncAdapter`, and any other downstream primitive that
  needs to observe cross-node state changes.
- Persistence e2e test `high-throughput-compaction` now passes. Root
  cause was that `TimeBasedCompactionStrategy.executeCompaction()` was
  entirely simulated — no real I/O happened despite the test correctly
  measuring real disk state. See `RealCompactionExecutor` above.
- Lint errors (45 → 0) across existing files blocking CI. Auto-fixable
  `no-inferrable-types` applied throughout; targeted fixes for empty
  constructors, empty arrow functions (`.catch(() => {})`), case-block
  lexical declarations, and inline comments for intentional dynamic
  `require()` calls.
- Stale `test-e2e-chat` CI job (directory moved to `examples/` in an
  earlier commit) and its orphan npm script removed.

### Unchanged (API consistency pass — conservative scope)
- No methods renamed.
- No constructor parameter orders changed.
- No event names renamed.
- No existing errors migrated to `CoreError` — that's a follow-up pass.
- Three of four compaction strategies (`SizeTiered`, `Leveled`,
  `VacuumBased`) have real I/O exercise only for narrow e2e scenarios;
  broader coverage is a follow-up.
