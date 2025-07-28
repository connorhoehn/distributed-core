import { Message, MessageType, GossipData } from '../../src/types';
import { nodeFixtures, nodeInfoFixtures } from './nodes';

/**
 * Basic message fixtures for testing
 */
export const messageFixtures: Message[] = [
  {
    id: 'msg-1',
    type: MessageType.PING,
    data: { timestamp: Date.now() },
    sender: nodeFixtures[0],
    timestamp: Date.now()
  },
  {
    id: 'msg-2',
    type: MessageType.PONG,
    data: { timestamp: Date.now() },
    sender: nodeFixtures[1],
    timestamp: Date.now()
  },
  {
    id: 'msg-3',
    type: MessageType.MEMBERSHIP_UPDATE,
    data: { nodes: [nodeInfoFixtures[0]] },
    sender: nodeFixtures[0],
    timestamp: Date.now()
  }
];

/**
 * Simple gossip data fixture
 */
export const gossipDataFixture: GossipData = {
  nodes: nodeInfoFixtures.slice(0, 3),
  version: 1,
  timestamp: Date.now()
};

/**
 * Helper for creating test messages
 */
export function createTestMessage(type: MessageType, data: any = {}): Message {
  return {
    id: `test-msg-${Date.now()}`,
    type,
    data,
    sender: nodeFixtures[0],
    timestamp: Date.now()
  };
}
