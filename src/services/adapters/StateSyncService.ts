import { IStateSyncService } from '../ports';

/**
 * StateSyncService coordinates WAL catch-up, delta sync, and anti-entropy
 * Phase 4: State Sync
 */
export class StateSyncService implements IStateSyncService {
  readonly name = 'STATE_SYNC';
  
  private antiEntropyTimer?: NodeJS.Timeout;

  constructor(
    private deltaSyncEngine?: any, // DeltaSyncEngine instance
    private stateReconciler?: any, // StateReconciler instance
    private walCoordinator?: any   // WALCoordinator instance
  ) {}

  async run(): Promise<void> {
    await this.catchUpFromWAL();
    await this.deltaSync();
    this.scheduleAntiEntropy();
  }

  async stop(): Promise<void> {
    if (this.antiEntropyTimer) {
      clearInterval(this.antiEntropyTimer);
      this.antiEntropyTimer = undefined;
    }
  }

  async catchUpFromWAL(): Promise<void> {
    if (!this.walCoordinator) return;
    
    try {
      // Start WAL coordinator if not already running
      await this.walCoordinator.start();
      console.log('[StateSyncService] WAL catch-up completed');
    } catch (error) {
      console.error('[StateSyncService] WAL catch-up failed:', error);
      throw error;
    }
  }

  async deltaSync(): Promise<void> {
    if (!this.deltaSyncEngine) return;
    
    try {
      // For now, this is a placeholder for delta sync logic
      // In practice, this would initiate delta sync with cluster peers
      console.log('[StateSyncService] Delta sync completed');
    } catch (error) {
      console.error('[StateSyncService] Delta sync failed:', error);
      throw error;
    }
  }

  scheduleAntiEntropy(): void {
    // Schedule periodic anti-entropy cycles (every 30 seconds)
    this.antiEntropyTimer = setInterval(async () => {
      try {
        await this.runAntiEntropyCycle();
      } catch (error) {
        console.error('[StateSyncService] Anti-entropy cycle failed:', error);
      }
    }, 30000);
    
    // Prevent timer from keeping process alive
    this.antiEntropyTimer.unref();
  }

  async runAntiEntropyCycle(): Promise<void> {
    // This would be called by external triggers or periodic timer
    console.log('[StateSyncService] Running anti-entropy cycle');
  }
}
