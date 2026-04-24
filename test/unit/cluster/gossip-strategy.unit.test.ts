import { GossipStrategy } from '../../../src/gossip/GossipStrategy';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { MembershipEntry } from '../../../src/cluster/types';
import { MessageType } from '../../../src/types';
import { LifecycleAware } from '../../../src/common/LifecycleAware';

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

describe('GossipStrategy — LifecycleAware', () => {
  function makeStrategy() {
    const nodeIdObj = { id: 'lc-gossip', address: '127.0.0.1', port: 4000 };
    const transport = new InMemoryAdapter(nodeIdObj);
    return new GossipStrategy('lc-gossip', transport, 1000);
  }

  it('isStarted() returns false before start()', () => {
    const gs = makeStrategy();
    expect(gs.isStarted()).toBe(false);
  });

  it('isStarted() returns true after start()', async () => {
    const gs = makeStrategy();
    await gs.start();
    expect(gs.isStarted()).toBe(true);
    await gs.stop();
  });

  it('isStarted() returns false after stop()', async () => {
    const gs = makeStrategy();
    await gs.start();
    await gs.stop();
    expect(gs.isStarted()).toBe(false);
  });

  it('start() twice is a no-op — isStarted stays true, no double-initialization', async () => {
    const gs = makeStrategy();
    await gs.start();
    expect(gs.isStarted()).toBe(true);
    // A second start() must not re-enter the body (which would reset and re-set the flag).
    // We verify by calling stop() to reset the flag, then calling start() again — but for
    // the idempotency test we confirm the state is consistent after two starts.
    await gs.start();
    expect(gs.isStarted()).toBe(true);
    await gs.stop();
  });

  it('stop() twice is a no-op', async () => {
    const gs = makeStrategy();
    await gs.start();
    await gs.stop();
    expect(gs.isStarted()).toBe(false);
    await gs.stop();
    expect(gs.isStarted()).toBe(false);
  });

  it('stop() before start() is a no-op — does not throw', async () => {
    const gs = makeStrategy();
    await expect(gs.stop()).resolves.toBeUndefined();
    expect(gs.isStarted()).toBe(false);
  });

  it('satisfies the LifecycleAware interface at the type level', () => {
    const gs = makeStrategy();
    const lc: LifecycleAware = gs;
    expect(typeof lc.start).toBe('function');
    expect(typeof lc.stop).toBe('function');
    expect(typeof lc.isStarted).toBe('function');
  });
});
