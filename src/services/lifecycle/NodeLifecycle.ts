import { INodeLifecycle, Phase } from '../ports';

/**
 * NodeLifecycle coordinates all startup phases in strict sequence
 */
export class NodeLifecycle implements INodeLifecycle {
  private currentPhaseIndex = -1;
  private isStarted = false;

  constructor(
    private phases: Phase[],
    private logger = console
  ) {}

  async start(): Promise<void> {
    if (this.isStarted) {
      throw new Error('NodeLifecycle is already started');
    }

    this.logger.log('[NodeLifecycle] Starting node lifecycle...');
    
    for (let i = 0; i < this.phases.length; i++) {
      const phase = this.phases[i];
      this.currentPhaseIndex = i;
      
      this.logger.log(`[${phase.name}] starting`);
      
      try {
        await phase.run();
        this.logger.log(`[${phase.name}] completed`);
      } catch (error) {
        this.logger.error(`[${phase.name}] failed:`, error);
        
        // Stop any previously started phases
        await this.stopPhases(i - 1);
        throw error;
      }
    }
    
    this.isStarted = true;
    this.logger.log('[READY] Node lifecycle startup complete');
  }

  async stop(): Promise<void> {
    if (!this.isStarted) {
      return;
    }

    this.logger.log('[NodeLifecycle] Stopping node lifecycle...');
    await this.stopPhases(this.currentPhaseIndex);
    
    this.isStarted = false;
    this.currentPhaseIndex = -1;
    this.logger.log('[NodeLifecycle] Node lifecycle stopped');
  }

  private async stopPhases(endIndex: number): Promise<void> {
    // Stop phases in reverse order
    for (let i = endIndex; i >= 0; i--) {
      const phase = this.phases[i];
      
      if (phase.stop) {
        try {
          this.logger.log(`[${phase.name}] stopping`);
          await phase.stop();
          this.logger.log(`[${phase.name}] stopped`);
        } catch (error) {
          this.logger.error(`[${phase.name}] stop failed:`, error);
          // Continue stopping other phases even if one fails
        }
      }
    }
  }

  getPhases(): readonly Phase[] {
    return this.phases;
  }

  getCurrentPhase(): Phase | null {
    return this.currentPhaseIndex >= 0 && this.currentPhaseIndex < this.phases.length
      ? this.phases[this.currentPhaseIndex]
      : null;
  }
}
