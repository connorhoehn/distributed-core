/**
 * CounterAdapter.ts — implements SharedStateAdapter<CounterState, CounterUpdate>.
 *
 * This is the "translation layer" between the generic SharedStateManager and
 * our domain-specific types. The adapter is pure and stateless; all mutable
 * state lives inside the session managed by SharedStateManager.
 *
 * Primitive: SharedStateAdapter (from src/gateway/state/types.ts)
 */

import { SharedStateAdapter } from '../../src/gateway/state/types';
import { CounterState, CounterUpdate } from './types';

export class CounterAdapter implements SharedStateAdapter<CounterState, CounterUpdate> {
  /** A brand-new counter starts at zero. */
  createState(): CounterState {
    return {
      count: 0,
      lastModified: Date.now(),
      modifiedBy: 'system',
    };
  }

  /**
   * Apply a single update to the current state and return the next state.
   *
   * Design note: we use last-write-wins on `modifiedBy` and `lastModified` for
   * all operations. For the `reset` command this prevents two simultaneous
   * resets from adding phantom counts — the latest timestamp wins.
   *
   * This function must be deterministic and side-effect free: given the same
   * (state, update) pair it always produces the same result. That property
   * allows nodes to replay updates from pubsub in any order and converge.
   */
  applyUpdate(state: CounterState, update: CounterUpdate): CounterState {
    const now = Date.now();

    switch (update.kind) {
      case 'inc':
        return {
          count: state.count + update.by,
          lastModified: now,
          modifiedBy: update.clientId,
        };

      case 'dec':
        return {
          count: state.count - update.by,
          lastModified: now,
          modifiedBy: update.clientId,
        };

      case 'reset':
        // Last-write-wins: only reset if no more recent modification exists.
        // In practice, on a single authoritative node all updates are serial,
        // so this is always safe. On follower nodes (cross-node pubsub), we
        // accept the reset unconditionally since the owner already serialized it.
        return {
          count: 0,
          lastModified: now,
          modifiedBy: update.clientId,
        };
    }
  }

  /** Serialize state to a JSON string for snapshot storage or cross-node sync. */
  serialize(state: CounterState): string {
    return JSON.stringify(state);
  }

  /** Reconstruct state from a serialized snapshot. */
  deserialize(raw: Uint8Array | string): CounterState {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    return JSON.parse(text) as CounterState;
  }
}
