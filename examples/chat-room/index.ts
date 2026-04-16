/**
 * Minimal runnable example that sets up a ChatRoomCoordinator on a
 * single-node "cluster" backed by an in-memory transport.
 *
 * Usage:
 *   npx ts-node examples/chat-room/index.ts
 */

import {
  ITransport,
  ClusterMessage,
  ClusterInfo,
} from '../../src/coordinators/types';
import { ChatRoomCoordinator } from './ChatRoomCoordinator';

// ---------------------------------------------------------------------------
// Minimal in-memory transport (enough to run the example on one node)
// ---------------------------------------------------------------------------

class InMemoryTransport implements ITransport {
  private handler: ((msg: ClusterMessage) => Promise<void>) | null = null;

  async initialize(_nodeId: string): Promise<void> {}

  async sendToNode(_targetNodeId: string, message: ClusterMessage): Promise<void> {
    // In a single-node setup we just loop back to ourselves.
    if (this.handler) {
      await this.handler(message);
    }
  }

  async broadcast(message: ClusterMessage): Promise<void> {
    if (this.handler) {
      await this.handler(message);
    }
  }

  async startListening(onMessage: (msg: ClusterMessage) => Promise<void>): Promise<void> {
    this.handler = onMessage;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  getConnectionInfo(): Record<string, any> {
    return { type: 'in-memory' };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const nodeId = 'node-1';
  const transport = new InMemoryTransport();
  await transport.initialize(nodeId);

  const coordinator = new ChatRoomCoordinator(transport, nodeId, {
    enablePersistence: false, // keep the example simple -- no disk I/O
  });

  // Wire up some event listeners so we can see what happens.
  coordinator.on('user-joined-room', (e) =>
    console.log(`[event] user-joined-room: ${e.userId} -> ${e.roomId}`),
  );
  coordinator.on('chat-message', (e) =>
    console.log(`[event] chat-message: ${e.userId} says "${e.content}" in ${e.roomId}`),
  );
  coordinator.on('user-left-room', (e) =>
    console.log(`[event] user-left-room: ${e.userId} <- ${e.roomId}`),
  );

  // Simulate acquiring a range (as the cluster coordinator would do).
  const clusterInfo: ClusterInfo = {
    members: [{ nodeId, address: 'localhost', port: 0 }],
    totalRanges: 1,
  } as ClusterInfo;

  await coordinator.onJoin('range-0', clusterInfo);

  // --- Exercise basic room operations ---

  // 1. Join a room
  await coordinator.onMessage({
    id: 'msg-1',
    type: 'JOIN_ROOM',
    payload: { roomId: 'general', userId: 'alice', fromNode: nodeId },
    timestamp: Date.now(),
    sourceNodeId: nodeId,
  });

  // 2. Another user joins
  await coordinator.onMessage({
    id: 'msg-2',
    type: 'JOIN_ROOM',
    payload: { roomId: 'general', userId: 'bob', fromNode: nodeId },
    timestamp: Date.now(),
    sourceNodeId: nodeId,
  });

  // 3. Send a chat message
  await coordinator.onMessage({
    id: 'msg-3',
    type: 'SEND_CHAT_MESSAGE',
    payload: {
      roomId: 'general',
      userId: 'alice',
      content: 'Hello, world!',
      messageId: 'chat-1',
      fromNode: nodeId,
    },
    timestamp: Date.now(),
    sourceNodeId: nodeId,
  });

  // 4. Leave
  await coordinator.onMessage({
    id: 'msg-4',
    type: 'LEAVE_ROOM',
    payload: { roomId: 'general', userId: 'bob', fromNode: nodeId },
    timestamp: Date.now(),
    sourceNodeId: nodeId,
  });

  // Print final room state
  const room = coordinator.getRoom('general');
  console.log('\nFinal room state:', {
    id: room?.id,
    participants: room ? Array.from(room.participants) : [],
    messageCount: room?.messageCount,
  });

  await coordinator.shutdown();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
