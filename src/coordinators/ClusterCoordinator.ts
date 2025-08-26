/**
 * ClusterCoordinator - High-level cluster coordination abstraction
 * 
 * Hides the complexity of:
 * - Transport management (WebSocket, TCP, gRPC)
 * - Cluster membership and gossip protocols
 * - Routing and topology management
 * - Network-level observability
 * 
 * Provides simple interface for:
 * - Starting/stopping cluster participation
 * - Sending messages to other nodes
 * - Checking cluster health and membership
 */

import { ClusterManager } from '../cluster/ClusterManager';
import { Transport } from '../transport/Transport';
import { NodeId } from '../types';

export interface ClusterCoordinatorConfig {
  nodeId: string;
  clusterTransport: Transport;
  clientTransport: Transport;
  seedNodes?: string[];
  observabilityEnabled?: boolean;
}

export interface ClusterMember {
  id: string;
  address: string;
  port: number;
  role: string;
  region: string;
  zone: string;
  isHealthy: boolean;
  lastSeen: number;
}

export interface ClusterHealth {
  isConnected: boolean;
  memberCount: number;
  partitions: string[][];
  gossipLatency: number;
  lastElection?: number;
}

/**
 * High-level cluster coordination abstraction
 * Hides transport, membership, and routing complexity
 */
export class ClusterCoordinator {
  private clusterManager: ClusterManager;
  private clusterTransport: Transport;
  private clientTransport: Transport;
  private isStarted: boolean = false;

  constructor(
    clusterManager: ClusterManager,
    clusterTransport: Transport,
    clientTransport: Transport
  ) {
    this.clusterManager = clusterManager;
    this.clusterTransport = clusterTransport;
    this.clientTransport = clientTransport;
  }

  /**
   * Start cluster coordination (transports, membership, gossip)
   */
  async start(): Promise<void> {
    if (this.isStarted) return;

    // Start transports
    await Promise.all([
      this.clusterTransport.start(),
      this.clientTransport.start()
    ]);

    // Start cluster manager
    await this.clusterManager.start();

    this.isStarted = true;
  }

  /**
   * Stop cluster coordination
   */
  async stop(): Promise<void> {
    if (!this.isStarted) return;

    // Stop cluster manager first
    await this.clusterManager.stop();

    // Stop transports
    await Promise.all([
      this.clusterTransport.stop(),
      this.clientTransport.stop()
    ]);

    this.isStarted = false;
  }

  /**
   * Send message to specific nodes in the cluster
   */
  async sendToNodes(
    messageType: string,
    payload: any,
    targetNodeIds: string[]
  ): Promise<void> {
    await this.clusterManager.getCommunication().sendCustomMessage(
      messageType,
      payload,
      targetNodeIds
    );
  }

  /**
   * Broadcast message to all cluster members
   */
  async broadcast(messageType: string, payload: any): Promise<void> {
    const members = await this.getMembers();
    const nodeIds = members.map(m => m.id);
    await this.sendToNodes(messageType, payload, nodeIds);
  }

  /**
   * Get current cluster members
   */
  async getMembers(): Promise<ClusterMember[]> {
    const membership = this.clusterManager.getMembership();
    const members = Array.from(membership.values());
    return members.map((member: any) => ({
      id: member.id || member.nodeId,
      address: member.address || 'unknown',
      port: member.port || 0,
      role: member.role || 'worker',
      region: member.region || 'unknown',
      zone: member.zone || 'unknown',
      isHealthy: member.status === 'ALIVE',
      lastSeen: member.lastHeartbeat || Date.now()
    }));
  }

  /**
   * Get cluster health status
   */
  async getHealth(): Promise<ClusterHealth> {
    const members = await this.getMembers();
    
    return {
      isConnected: this.isStarted && members.length > 0,
      memberCount: members.length,
      partitions: [], // TODO: implement partition detection
      gossipLatency: 0, // TODO: implement gossip latency tracking
      lastElection: undefined // TODO: implement election tracking
    };
  }

  /**
   * Register handler for incoming cluster messages
   */
  onMessage(messageType: string, handler: (payload: any, fromNodeId: string) => Promise<void>): void {
    (this.clusterManager as any).on('custom-message', async (data: any) => {
      if (data.message && data.message.type === messageType) {
        await handler(data.message.payload, data.fromNodeId);
      }
    });
  }

  /**
   * Check if cluster is ready for operations
   */
  isReady(): boolean {
    return this.isStarted;
  }

  /**
   * Get underlying cluster manager (for advanced use cases)
   * @deprecated Use high-level methods instead
   */
  getClusterManager(): ClusterManager {
    return this.clusterManager;
  }
}
