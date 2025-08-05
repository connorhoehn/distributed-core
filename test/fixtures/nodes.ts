import { NodeId, NodeInfo, NodeStatus } from '../../src/types';

/**
 * Predefined node fixtures for testing
 */
export const nodeFixtures: NodeId[] = [
  {
    id: 'test-node-0',
    address: '127.0.0.1',
    port: 3000
  },
  {
    id: 'test-node-1', 
    address: '127.0.0.1',
    port: 3001
  },
  {
    id: 'test-node-2',
    address: '127.0.0.1',
    port: 3002
  },
  {
    id: 'test-node-3',
    address: '127.0.0.1',
    port: 3003
  },
  {
    id: 'test-node-4',
    address: '127.0.0.1',
    port: 3004
  }
];

/**
 * Node info fixtures with different states
 */
export const nodeInfoFixtures: NodeInfo[] = [
  {
    id: nodeFixtures[0].id,
    status: NodeStatus.ALIVE,
    version: 1,
    lastSeen: Date.now(),
    metadata: { region: 'us-east-1', role: 'leader' }
  },
  {
    id: nodeFixtures[1].id,
    status: NodeStatus.ALIVE,
    version: 1,
    lastSeen: Date.now() - 1000,
    metadata: { region: 'us-east-1', role: 'follower' }
  },
  {
    id: nodeFixtures[2].id,
    status: NodeStatus.SUSPECTED,
    version: 2,
    lastSeen: Date.now() - 5000,
    metadata: { region: 'us-west-2', role: 'follower' }
  },
  {
    id: nodeFixtures[3].id,
    status: NodeStatus.DEAD,
    version: 1,
    lastSeen: Date.now() - 30000,
    metadata: { region: 'eu-west-1', role: 'follower' }
  },
  {
    id: nodeFixtures[4].id,
    status: NodeStatus.ALIVE,
    version: 1,
    lastSeen: Date.now() - 500,
    metadata: { region: 'ap-southeast-1', role: 'follower' }
  }
];

/**
 * Simple helper for creating test nodes
 */
export function createTestNode(id: string, port: number = 3000): NodeInfo {
  return {
    id: id,
    status: NodeStatus.ALIVE,
    version: 1,
    lastSeen: Date.now(),
    metadata: { }
  };
}
