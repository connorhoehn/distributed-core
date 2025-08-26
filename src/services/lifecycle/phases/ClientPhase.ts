import { Phase, INetworkService, IClientConnectionService } from '../../ports';

/**
 * ClientPhase - Phase 6: Start client transport and connection handlers
 */
export class ClientPhase implements Phase {
  readonly name = 'CLIENT';
  
  constructor(
    private clientConnectionService: IClientConnectionService,
    private networkService: INetworkService
  ) {}

  async run(): Promise<void> {
    // Bind client transport (separate port from cluster)
    await this.networkService.bindClient();
    
    // Start client connection service (registers all the resource handlers)
    await this.clientConnectionService.run();
    
    console.log('[ClientPhase] Client transport bound and connection handlers registered');
  }

  async stop(): Promise<void> {
    if (this.clientConnectionService.stop) {
      await this.clientConnectionService.stop();
    }
  }
}
