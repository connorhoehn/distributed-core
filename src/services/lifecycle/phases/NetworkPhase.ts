import { Phase, INetworkService, ICommunicationService } from '../../ports';
import { Logger } from '../../../common/logger';

/**
 * NetworkPhase - Phase 2: Bind cluster transport and register message handlers
 */
export class NetworkPhase implements Phase {
  readonly name = 'NETWORK';
  private logger = Logger.create('NetworkPhase');

  constructor(
    private networkService: INetworkService,
    private communicationService: ICommunicationService
  ) {}

  async run(): Promise<void> {
    this.logger.debug('Starting NetworkPhase.run()');

    // Bind cluster transport
    this.logger.debug('About to call networkService.bindCluster()');
    await this.networkService.bindCluster();
    this.logger.debug('networkService.bindCluster() completed');

    // Register cluster message handler
    this.logger.debug('Registering cluster message handler');
    this.networkService.onClusterMessage(message => {
      this.logger.debug('Received cluster message:', message.type);
      this.communicationService.handleIncoming(message);
    });

    this.logger.info('Cluster transport bound and message handlers registered');
  }

  async stop(): Promise<void> {
    // NetworkService handles its own cleanup
  }
}
