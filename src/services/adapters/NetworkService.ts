import { INetworkService } from '../ports';
import { Transport } from '../../transport/Transport';
import { Message } from '../../types';

/**
 * NetworkService manages cluster and client transport lifecycle
 * Phase 2: Network Bind
 */
export class NetworkService implements INetworkService {
  readonly name = 'NETWORK';
  
  private clusterMessageHandler?: (message: Message) => void;
  private clientMessageHandler?: (connectionId: string, message: any) => void;

  constructor(
    private clusterTransport: Transport,
    private clientTransport: Transport
  ) {}

  async run(): Promise<void> {
    console.log('[NetworkService] Starting run() method');
    await this.bindCluster();
    console.log('[NetworkService] bindCluster() completed');
  }

  async stop(): Promise<void> {
    await Promise.all([
      this.clusterTransport.stop(),
      this.clientTransport.stop()
    ]);
  }

  async bindCluster(): Promise<void> {
    console.log('[NetworkService] Starting bindCluster()');
    console.log('[NetworkService] Transport type:', this.clusterTransport.constructor.name);
    
    // Set up cluster message handler if registered
    if (this.clusterMessageHandler) {
      console.log('[NetworkService] Setting up cluster message handler');
      this.clusterTransport.onMessage(this.clusterMessageHandler);
    } else {
      console.log('[NetworkService] No cluster message handler registered yet');
    }
    
    console.log('[NetworkService] About to start cluster transport...');
    await this.clusterTransport.start();
    console.log('[NetworkService] Cluster transport started successfully');
  }

  async bindClient(): Promise<void> {
    await this.clientTransport.start();
  }

  getClusterTransport(): Transport {
    return this.clusterTransport;
  }

  getClientTransport(): Transport {
    return this.clientTransport;
  }

  onClusterMessage(handler: (message: Message) => void): void {
    this.clusterMessageHandler = handler;
    // If transport is already started, register immediately
    if (this.clusterTransport) {
      this.clusterTransport.onMessage(handler);
    }
  }

  onClientMessage(handler: (connectionId: string, message: any) => void): void {
    this.clientMessageHandler = handler;
    // Note: Client message handling is typically done through ConnectionManager
    // This is a placeholder for direct client transport message handling
  }
}
