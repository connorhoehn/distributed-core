# Changelog

## Unreleased

### Added
- `LifecycleAware` interface in `src/common/LifecycleAware.ts`. All primitives
  with explicit start/stop now declare `implements LifecycleAware` and expose
  `isStarted(): boolean`. Calls to `start()` and `stop()` are now idempotent.
- `CoreError` base class and subclasses (`NotStartedError`, `AlreadyStartedError`,
  `ConflictError`, `TimeoutError`) in `src/common/errors.ts`. Existing thrown
  `Error` instances are unchanged in this release; use the new types in new code.

### Unchanged (API consistency pass — conservative scope)
- No methods renamed.
- No constructor parameter orders changed.
- No event names renamed.
- No existing errors migrated to `CoreError` — that's a follow-up pass.
