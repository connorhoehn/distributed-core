/**
 * Standard lifecycle contract for primitives that manage resources
 * requiring explicit start/stop (timers, listeners, open files, etc).
 *
 * Classes implementing this interface should:
 * - Be safe to construct without side-effects (no listeners registered, no
 *   timers started until start() is called — where practical).
 * - Be idempotent for repeated start()/stop() calls in the same state.
 * - Report their state truthfully via isStarted().
 */
export interface LifecycleAware {
  start(): Promise<void>;
  stop(): Promise<void>;
  isStarted(): boolean;
}
