import { INetworkService } from '../ports';
import { Transport } from '../../transport/Transport';
import { Message } from '../../types';
import { Logger } from '../../common/logger';

/**
 * NetworkService manages cluster and client transport lifecycle
 * Phase 2: Network Bind
 */
export class NetworkService implements INetworkService {
  readonly name = 'NETWORK';
  private logger = Logger.create('NetworkService');

  private clusterMessageHandler?: (message: Message) => void;
  private clientMessageHandler?: (connectionId: string, message: any) => void;

  constructor(
    private clusterTransport: Transport,
    private clientTransport: Transport
  ) {}

  async run(): Promise<void> {
    this.logger.debug('Starting run() method');
    await this.bindCluster();
    this.logger.debug('bindCluster() completed');
  }

  async stop(): Promise<void> {
    await Promise.all([
      this.clusterTransport.stop(),
      this.clientTransport.stop()
    ]);
  }

  async bindCluster(): Promise<void> {
    this.logger.debug('Starting bindCluster()');
    this.logger.debug('Transport type:', this.clusterTransport.constructor.name);

    // Set up cluster message handler if registered
    if (this.clusterMessageHandler) {
      this.logger.debug('Setting up cluster message handler');
      this.clusterTransport.onMessage(this.clusterMessageHandler);
    } else {
      this.logger.debug('No cluster message handler registered yet');
    }

    this.logger.debug('About to start cluster transport...');
    await this.clusterTransport.start();
    this.logger.info('Cluster transport started successfully');
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
