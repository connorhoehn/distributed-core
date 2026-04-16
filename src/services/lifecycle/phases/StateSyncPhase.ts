import { Phase, IStateSyncService } from '../../ports';
import { Logger } from '../../../common/logger';

/**
 * StateSyncPhase - Phase 4: WAL catch-up, delta sync, and schedule anti-entropy
 */
export class StateSyncPhase implements Phase {
  readonly name = 'STATE_SYNC';
  private logger = Logger.create('StateSyncPhase');

  constructor(private stateSyncService: IStateSyncService) {}

  async run(): Promise<void> {
    // State sync service handles its own sequencing
    await this.stateSyncService.run();
    this.logger.info('State synchronization completed');
  }

  async stop(): Promise<void> {
    if (this.stateSyncService.stop) {
      await this.stateSyncService.stop();
    }
  }
}
