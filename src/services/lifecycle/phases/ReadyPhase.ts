import { Phase } from '../../ports';
import { Logger } from '../../../common/logger';

/**
 * ReadyPhase - Phase 7: Final phase marking node as ready
 */
export class ReadyPhase implements Phase {
  readonly name = 'READY';
  private logger = Logger.create('ReadyPhase');

  async run(): Promise<void> {
    // This phase marks the node as fully operational
    // Could start metrics export, health checks, etc.
    this.logger.info('Node is ready and operational');
  }

  async stop(): Promise<void> {
    // Cleanup any observability or metrics
    this.logger.info('Node shutdown complete');
  }
}
