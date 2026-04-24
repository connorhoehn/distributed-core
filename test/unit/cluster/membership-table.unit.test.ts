import { MembershipTable } from '../../../src/cluster/membership/MembershipTable';
import { NodeInfo } from '../../../src/cluster/types';

describe('MembershipTable', () => {
  let membershipTable: MembershipTable;
  let nodeInfo: NodeInfo;

  beforeEach(() => {
    membershipTable = new MembershipTable('local-node');
    nodeInfo = {
      id: 'node-1',
      metadata: { 
        address: '127.0.0.1',
        port: 3000,
        region: 'us-east' 
      },
      lastSeen: Date.now(),
      status: 'ALIVE',
      version: 1
    };
  });

  it('should add and retrieve members', () => {
    membershipTable.updateNode(nodeInfo);
    
    const retrieved = membershipTable.getMember('node-1');
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe('node-1');
    expect(membershipTable.size()).toBe(1);
  });

  it('should mark members as suspect', () => {
    membershipTable.addMember(nodeInfo);
    membershipTable.markSuspect('node-1');
    
    const member = membershipTable.getMember('node-1');
    expect(member?.status).toBe('SUSPECT');
    expect(membershipTable.size()).toBe(1);
  });

  it('should get all members', () => {
    const nodeInfo2: NodeInfo = {
      ...nodeInfo,
      id: 'node-2',
      metadata: { 
        address: '127.0.0.1',
        port: 3001 
      }
    };
    
    membershipTable.addMember(nodeInfo);
    membershipTable.addMember(nodeInfo2);
    
    const allMembers = membershipTable.getAllMembers();
    expect(allMembers).toHaveLength(2);
  });

  it('should filter alive members', () => {
    const deadNode: NodeInfo = {
      ...nodeInfo,
      id: 'node-2',
      metadata: { 
        address: '127.0.0.1',
        port: 3001 
      },
      status: 'DEAD'
    };
    
    membershipTable.addMember(nodeInfo);
    membershipTable.addMember(deadNode);
    
    const aliveMembers = membershipTable.getAliveMembers();
    expect(aliveMembers).toHaveLength(1);
    expect(aliveMembers[0].id).toBe('node-1');
  });

  it('should clear all members', () => {
    membershipTable.addMember(nodeInfo);
    membershipTable.clear();

    expect(membershipTable.size()).toBe(0);
  });
});

describe('MembershipTable — dual-emit deprecation bridge', () => {
  let membershipTable: MembershipTable;
  const peer: NodeInfo = {
    id: 'peer-1',
    metadata: { address: '127.0.0.1', port: 3001 },
    lastSeen: Date.now(),
    status: 'ALIVE',
    version: 1
  };

  beforeEach(() => {
    membershipTable = new MembershipTable('local-node');
  });

  it('member:joined — new name receives event when node is added', () => {
    const spy = jest.fn();
    membershipTable.on('member:joined', spy);
    membershipTable.addMember(peer);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('member-joined — legacy name still receives event (compat)', () => {
    const spy = jest.fn();
    membershipTable.on('member-joined', spy);
    membershipTable.addMember(peer);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('member:joined / member-joined — payload is identical', () => {
    let newPayload: unknown;
    let oldPayload: unknown;
    membershipTable.on('member:joined', (p: unknown) => { newPayload = p; });
    membershipTable.on('member-joined', (p: unknown) => { oldPayload = p; });
    membershipTable.addMember(peer);
    expect(newPayload).toEqual(oldPayload);
  });

  it('member:joined fires before member-joined in the same synchronous emission', () => {
    const order: string[] = [];
    membershipTable.on('member:joined', () => order.push('new'));
    membershipTable.on('member-joined', () => order.push('old'));
    membershipTable.addMember(peer);
    expect(order).toEqual(['new', 'old']);
  });

  it('member:left — new name receives event when node is marked dead', () => {
    membershipTable.addMember(peer);
    const spy = jest.fn();
    membershipTable.on('member:left', spy);
    membershipTable.markDead('peer-1');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('member-left — legacy name still receives event (compat)', () => {
    membershipTable.addMember(peer);
    const spy = jest.fn();
    membershipTable.on('member-left', spy);
    membershipTable.markDead('peer-1');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('membership:updated — new name fires on every state-changing operation', () => {
    const spy = jest.fn();
    membershipTable.on('membership:updated', spy);
    membershipTable.addMember(peer);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('membership-updated — legacy name fires on every state-changing operation (compat)', () => {
    const spy = jest.fn();
    membershipTable.on('membership-updated', spy);
    membershipTable.addMember(peer);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
