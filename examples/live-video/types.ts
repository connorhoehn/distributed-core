/**
 * types.ts — shared type definitions for the live-video example.
 *
 * This is a stub workload: no real WebRTC, no real SFU. The shapes are
 * realistic enough to stress-test how the library's primitives compose
 * under a streaming workload that is the opposite of cluster-collab:
 *   - Rooms are write-heavy (thousands of stat packets per second)
 *   - Ownership is exclusive (one SFU node per room)
 *   - Node failure means immediate, hard re-assignment of every participant
 *
 * Nothing here produces actual video frames; packets are counters and
 * booleans dressed up as media telemetry.
 */

// ---------------------------------------------------------------------------
// Room state — lives inside a DistributedSession per room
// ---------------------------------------------------------------------------

export interface RoomState {
  roomId: string;
  participants: Set<string>;
  transcoderLocked: boolean;
  createdAt: number;
  lastActivity: number;
}

// ---------------------------------------------------------------------------
// Room update commands — discriminated union so TypeScript exhaustively
// checks every branch when applying updates.
// ---------------------------------------------------------------------------

export type RoomUpdate =
  | { kind: 'participant-joined'; clientId: string }
  | { kind: 'participant-left'; clientId: string }
  | { kind: 'transcoder-up' }
  | { kind: 'transcoder-down' };

// ---------------------------------------------------------------------------
// Stats packet — simulated WebRTC media telemetry
// One packet per simulated client per 10ms tick (100 Hz)
// ---------------------------------------------------------------------------

export interface StatsPacket {
  roomId: string;
  clientId: string;
  timestamp: number;
  bitrate: number;    // Kbps, randomly simulated
  packetLoss: number; // 0.0–1.0, randomly simulated
}

// ---------------------------------------------------------------------------
// Summary stats returned by LiveVideoNode.getStats()
// ---------------------------------------------------------------------------

export interface LiveVideoNodeStats {
  nodeId: string;
  localRooms: number;
  totalParticipants: number;
  statsPacketsObserved: number;
  statsPacketsDropped: number;
  transcoderLocksHeld: number;
  isRoomController: boolean;
}
