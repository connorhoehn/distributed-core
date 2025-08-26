import { Phase, ISeedRegistry, ICommunicationService } from '../../ports';

/**
 * MembershipPhase - Phase 3: Join cluster and start gossip protocol
 */
export class MembershipPhase implements Phase {
  readonly name = 'MEMBERSHIP';
  
  constructor(
    private seedRegistry: ISeedRegistry,
    private communicationService: ICommunicationService,
    private joinTimeoutMs: number = 5000
  ) {}

  async run(): Promise<void> {
    // Get bootstrap seeds
    const seeds = this.seedRegistry.getBootstrapSeeds();
    
    // Join cluster via seed nodes
    await this.communicationService.join(seeds, this.joinTimeoutMs);
    
    // Start gossip protocol
    this.communicationService.startGossip();
    
    console.log(`[MembershipPhase] Joined cluster via ${seeds.length} seeds and started gossip`);
  }

  async stop(): Promise<void> {
    this.communicationService.stopGossip();
  }
}
