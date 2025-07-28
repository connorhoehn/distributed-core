import { EventEmitter } from 'events';
import { Transport } from '../transport/Transport';
import { NodeId, NodeInfo, NodeStatus, Message, MessageType } from '../types';
import { MembershipTable } from './MembershipTable';
import { BootstrapConfig } from './BootstrapConfig';

export class ClusterManager extends EventEmitter {
  private membership = new MembershipTable();
  private isStarted = false;

  constructor(
    private nodeId: NodeId,
    private transport: Transport,
    private config: BootstrapConfig
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    // Add self to membership
    this.membership.addMember({
      id: this.nodeId,
      metadata: {},
      lastSeen: Date.now(),
      status: NodeStatus.ALIVE,
      version: 1
    });

    // Set up transport message handling
    this.transport.onMessage(this.handleMessage.bind(this));
    await this.transport.start();

    // Join via seed nodes
    await this.joinCluster();

    this.isStarted = true;
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    await this.transport.stop();
    this.membership.clear();
    this.isStarted = false;
    this.emit('stopped');
  }

  private async joinCluster(): Promise<void> {
    const seedNodes = this.config.getSeedNodes();
    
    for (const seedNode of seedNodes) {
      if (seedNode.id !== this.nodeId.id) {
        try {
          const joinMessage: Message = {
            id: `join-${Date.now()}`,
            type: MessageType.JOIN,
            data: { nodeInfo: this.getNodeInfo() },
            sender: this.nodeId,
            timestamp: Date.now()
          };
          
          await this.transport.send(joinMessage, seedNode);
          this.emit('join-sent', seedNode);
        } catch (error) {
          // Silently continue to next seed node
        }
      }
    }
  }

  private handleMessage(message: Message): void {
    switch (message.type) {
      case MessageType.JOIN:
        this.handleJoinMessage(message);
        break;
      case MessageType.GOSSIP:
        this.handleGossipMessage(message);
        break;
    }
  }

  private handleJoinMessage(message: Message): void {
    const nodeInfo = message.data.nodeInfo;
    if (nodeInfo && nodeInfo.id.id !== this.nodeId.id) {
      // Only add if not already a member
      const existingMember = this.membership.getMember(nodeInfo.id.id);
      if (!existingMember) {
        this.membership.addMember(nodeInfo);
        this.emit('member-joined', nodeInfo);
        
        // Send back our own membership info (but don't loop)
        if (message.type === MessageType.JOIN && !message.data.isResponse) {
          const response: Message = {
            id: `join-response-${Date.now()}`,
            type: MessageType.JOIN,
            data: { 
              nodeInfo: this.getNodeInfo(),
              isResponse: true 
            },
            sender: this.nodeId,
            timestamp: Date.now()
          };
          
          this.transport.send(response, message.sender).catch(() => {
            // Silently handle send failures
          });
        }
      }
    }
  }

  private handleGossipMessage(message: Message): void {
    // Simple gossip handling - just emit for testing
    this.emit('gossip-received', message);
  }

  getNodeInfo(): NodeInfo {
    return {
      id: this.nodeId,
      metadata: {},
      lastSeen: Date.now(),
      status: NodeStatus.ALIVE,
      version: 1
    };
  }

  getMembership(): MembershipTable {
    return this.membership;
  }

  getMembers(): NodeInfo[] {
    return this.membership.getAllMembers();
  }

  getMemberCount(): number {
    return this.membership.size();
  }
}
