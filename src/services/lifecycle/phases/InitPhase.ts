import { Phase, ISeedRegistry } from '../../ports';
import { Logger } from '../../../common/logger';

/**
 * InitPhase - Phase 1: Initialize configuration and start seed monitoring
 */
export class InitPhase implements Phase {
  readonly name = 'INIT';
  private logger = Logger.create('InitPhase');

  constructor(private seedRegistry: ISeedRegistry) {}

  async run(): Promise<void> {
    // Start seed health monitoring
    this.seedRegistry.startHealthMonitoring();
    this.logger.info('Configuration validated and seed monitoring started');
  }

  async stop(): Promise<void> {
    this.seedRegistry.stopHealthMonitoring();
  }
}
