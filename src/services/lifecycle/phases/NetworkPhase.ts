import { Phase, INetworkService, ICommunicationService } from '../../ports';

/**
 * NetworkPhase - Phase 2: Bind cluster transport and register message handlers
 */
export class NetworkPhase implements Phase {
  readonly name = 'NETWORK';
  
  constructor(
    private networkService: INetworkService,
    private communicationService: ICommunicationService
  ) {}

  async run(): Promise<void> {
    console.log('[NetworkPhase] Starting NetworkPhase.run()');
    
    // Bind cluster transport
    console.log('[NetworkPhase] About to call networkService.bindCluster()');
    await this.networkService.bindCluster();
    console.log('[NetworkPhase] networkService.bindCluster() completed');
    
    // Register cluster message handler
    console.log('[NetworkPhase] Registering cluster message handler');
    this.networkService.onClusterMessage(message => {
      console.log('[NetworkPhase] Received cluster message:', message.type);
      this.communicationService.handleIncoming(message);
    });
    
    console.log('[NetworkPhase] Cluster transport bound and message handlers registered');
  }

  async stop(): Promise<void> {
    // NetworkService handles its own cleanup
  }
}
