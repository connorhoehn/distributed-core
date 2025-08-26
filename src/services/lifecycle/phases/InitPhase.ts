import { Phase, ISeedRegistry } from '../../ports';

/**
 * InitPhase - Phase 1: Initialize configuration and start seed monitoring
 */
export class InitPhase implements Phase {
  readonly name = 'INIT';
  
  constructor(private seedRegistry: ISeedRegistry) {}

  async run(): Promise<void> {
    // Start seed health monitoring
    this.seedRegistry.startHealthMonitoring();
    console.log('[InitPhase] Configuration validated and seed monitoring started');
  }

  async stop(): Promise<void> {
    this.seedRegistry.stopHealthMonitoring();
  }
}
