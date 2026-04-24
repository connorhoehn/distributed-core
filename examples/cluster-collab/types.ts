/**
 * types.ts — shared type definitions for the cluster-collab example.
 *
 * CounterState is what lives inside each distributed session. It's intentionally
 * simple so we can see state propagation without CRDT complexity.
 */

export interface CounterState {
  count: number;
  lastModified: number;
  modifiedBy: string;
}

/**
 * CounterUpdate is the "command" applied to CounterState.
 * Using a discriminated union means every branch is exhaustively handled by the
 * TypeScript compiler — a good pattern for adapters that switch on `kind`.
 */
export type CounterUpdate =
  | { kind: 'inc'; by: number; clientId: string }
  | { kind: 'dec'; by: number; clientId: string }
  | { kind: 'reset'; clientId: string };

/**
 * ClientSession tracks which counters a connected client is subscribed to on
 * this node. Used by CollabNode to clean up when a client disconnects.
 */
export interface ClientSession {
  clientId: string;
  joinedAt: number;
  counterIds: Set<string>;
}

/**
 * CollabNodeStats — snapshot of node health for the demo summary printout.
 */
export interface CollabNodeStats {
  nodeId: string;
  localCounters: number;
  followerCounters: number;
  connectedClients: number;
  totalUpdatesApplied: number;
  reclaimedCounters: number;
}
