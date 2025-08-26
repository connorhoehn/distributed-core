import { ICommunicationService } from '../ports';
import { SeedNodeInfo } from '../../config/BootstrapConfig';
import { Message } from '../../types';

/**
 * CommunicationService wraps ClusterCommunication for lifecycle management
 * Phase 3: Gossip & Membership
 */
export class CommunicationService implements ICommunicationService {
  readonly name = 'MEMBERSHIP';
  
  private customMessageHandlers: Array<(type: string, payload: any, sender: string) => void> = [];

  constructor(
    private clusterComm: any // ClusterCommunication instance
  ) {}

  async run(): Promise<void> {
    // This phase is triggered by MembershipPhase
    // The actual join() is called from the phase with specific parameters
  }

  async stop(): Promise<void> {
    this.stopGossip();
  }

  async join(seeds: SeedNodeInfo[], timeoutMs: number): Promise<void> {
    // Join cluster using the wrapped ClusterCommunication
    await this.clusterComm.joinCluster();
  }

  startGossip(): void {
    this.clusterComm.startGossipTimer();
  }

  stopGossip(): void {
    this.clusterComm.stopGossipTimer();
  }

  async sendCustomMessage(type: string, payload: any, targets?: string[]): Promise<void> {
    await this.clusterComm.sendCustomMessage(type, payload, targets);
  }

  onCustomMessage(handler: (type: string, payload: any, sender: string) => void): void {
    this.customMessageHandlers.push(handler);
  }

  handleIncoming(message: Message): void {
    // Handle cluster messages and emit custom message events
    this.clusterComm.handleMessage(message);
    
    // If this is a custom message, notify handlers
    if (message.data?.customType) {
      const { customType, payload } = message.data;
      this.customMessageHandlers.forEach(handler => {
        try {
          handler(customType, payload, message.sender.id);
        } catch (error) {
          console.error(`Error in custom message handler for ${customType}:`, error);
        }
      });
    }
  }
}
