/**
 * RoomSession.ts — SharedStateAdapter for a video room.
 *
 * This is the translation layer between the library's generic
 * SharedStateManager/DistributedSession and our domain types. It is
 * intentionally pure and stateless; all mutable room state lives inside the
 * DistributedSession managed by SharedStateManager.
 *
 * Compared with cluster-collab's CounterAdapter, this adapter has richer state
 * (a Set<string> for participants) and must survive serialization across node
 * boundaries, which exercises the serialize/deserialize contract more seriously.
 *
 * Primitive: SharedStateAdapter (src/gateway/state/types.ts)
 */

import { SharedStateAdapter } from '../../src/gateway/state/types';
import { RoomState, RoomUpdate } from './types';

export class RoomSession implements SharedStateAdapter<RoomState, RoomUpdate> {
  createState(): RoomState {
    return {
      roomId: '',         // will be set via hydrate() by the caller
      participants: new Set(),
      transcoderLocked: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
  }

  applyUpdate(state: RoomState, update: RoomUpdate): RoomState {
    // Shallow-clone participants so the old state remains immutable; this
    // matters for follower nodes that might need to replay updates.
    const participants = new Set(state.participants);

    switch (update.kind) {
      case 'participant-joined':
        participants.add(update.clientId);
        return { ...state, participants, lastActivity: Date.now() };

      case 'participant-left':
        participants.delete(update.clientId);
        return { ...state, participants, lastActivity: Date.now() };

      case 'transcoder-up':
        return { ...state, transcoderLocked: true, lastActivity: Date.now() };

      case 'transcoder-down':
        return { ...state, transcoderLocked: false, lastActivity: Date.now() };
    }
  }

  serialize(state: RoomState): string {
    return JSON.stringify({
      roomId: state.roomId,
      participants: Array.from(state.participants),
      transcoderLocked: state.transcoderLocked,
      createdAt: state.createdAt,
      lastActivity: state.lastActivity,
    });
  }

  deserialize(raw: Uint8Array | string): RoomState {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    const parsed = JSON.parse(text) as {
      roomId: string;
      participants: string[];
      transcoderLocked: boolean;
      createdAt: number;
      lastActivity: number;
    };
    return {
      roomId: parsed.roomId,
      participants: new Set(parsed.participants),
      transcoderLocked: parsed.transcoderLocked,
      createdAt: parsed.createdAt,
      lastActivity: parsed.lastActivity,
    };
  }
}
