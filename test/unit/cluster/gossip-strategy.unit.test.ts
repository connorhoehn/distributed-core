import { GossipStrategy } from '../../../src/cluster/GossipStrategy';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { MembershipEntry } from '../../../src/cluster/types';
import { MessageType } from '../../../src/types';

describe('GossipStrategy', () => {
  let gossipStrategy: GossipStrategy;
  let transport: InMemoryAdapter;
  let nodeId: string;

  beforeEach(() => {
    nodeId = 'gossip-node';
    const nodeIdObj = { id: 'gossip-node', address: '127.0.0.1', port: 3000 };
    transport = new InMemoryAdapter(nodeIdObj);
    gossipStrategy = new GossipStrategy(nodeId, transport, 1000);
  });

  it('should select gossip targets', () => {
    const allNodes: MembershipEntry[] = [
      { 
        id: 'node-1', 
        status: 'ALIVE', 
        lastSeen: Date.now(), 
        version: 1,
        lastUpdated: Date.now(),
        metadata: { address: '127.0.0.1', port: 3001 }
      },
      { 
        id: 'node-2', 
        status: 'ALIVE', 
        lastSeen: Date.now(), 
        version: 1,
        lastUpdated: Date.now(),
        metadata: { address: '127.0.0.1', port: 3002 }
      },
      { 
        id: 'node-3', 
        status: 'ALIVE', 
        lastSeen: Date.now(), 
        version: 1,
        lastUpdated: Date.now(),
        metadata: { address: '127.0.0.1', port: 3003 }
      }
    ];
    
    const targets = gossipStrategy.selectGossipTargets(allNodes, 2);
    
    expect(targets).toHaveLength(2);
    expect(targets.every(t => t.id !== nodeId)).toBe(true);
  });

  it('should send gossip messages', async () => {
    await transport.start();
    
    const targets: MembershipEntry[] = [
      { 
        id: 'node-1', 
        status: 'ALIVE', 
        lastSeen: Date.now(), 
        version: 1,
        lastUpdated: Date.now(),
        metadata: { address: '127.0.0.1', port: 3001 }
      }
    ];
    
    const sendSpy = jest.spyOn(transport, 'send').mockResolvedValue();
    
    await gossipStrategy.sendGossip(targets, {
      id: 'test-data',
      status: 'ALIVE',
      lastSeen: Date.now(),
      version: 1
    });
    
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GOSSIP,
        data: expect.objectContaining({
          nodeInfo: expect.objectContaining({
            id: 'test-data',
            status: 'ALIVE'
          }),
          type: 'GOSSIP'
        }),
        sender: expect.objectContaining({
          id: nodeId
        })
      }),
      expect.objectContaining({
        id: 'node-1'
      })
    );
    
    await transport.stop();
  });
});
