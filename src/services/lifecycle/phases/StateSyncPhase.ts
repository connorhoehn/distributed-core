import { Phase, IStateSyncService } from '../../ports';

/**
 * StateSyncPhase - Phase 4: WAL catch-up, delta sync, and schedule anti-entropy
 */
export class StateSyncPhase implements Phase {
  readonly name = 'STATE_SYNC';
  
  constructor(private stateSyncService: IStateSyncService) {}

  async run(): Promise<void> {
    // State sync service handles its own sequencing
    await this.stateSyncService.run();
    console.log('[StateSyncPhase] State synchronization completed');
  }

  async stop(): Promise<void> {
    if (this.stateSyncService.stop) {
      await this.stateSyncService.stop();
    }
  }
}
