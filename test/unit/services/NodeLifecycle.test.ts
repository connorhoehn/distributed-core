/**
 * Unit tests for NodeLifecycle service
 */

import { NodeLifecycle } from '../../../src/services/lifecycle/NodeLifecycle';
import { Phase } from '../../../src/services/ports';

// Mock console to capture logs
const mockConsole = {
  log: jest.fn(),
  error: jest.fn()
};

// Mock phase implementations
class MockPhase implements Phase {
  constructor(public readonly name: string, private shouldFail = false) {}
  
  async run(): Promise<void> {
    if (this.shouldFail) {
      throw new Error(`${this.name} failed`);
    }
  }
  
  async stop(): Promise<void> {
    // Optional stop implementation
  }
}

describe('NodeLifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should start all phases in sequence', async () => {
    const phases = [
      new MockPhase('INIT'),
      new MockPhase('NETWORK'),
      new MockPhase('MEMBERSHIP')
    ];
    
    const lifecycle = new NodeLifecycle(phases, mockConsole as any);
    
    await lifecycle.start();
    
    // Verify all phases were logged
    expect(mockConsole.log).toHaveBeenCalledWith('[NodeLifecycle] Starting node lifecycle...');
    expect(mockConsole.log).toHaveBeenCalledWith('[INIT] starting');
    expect(mockConsole.log).toHaveBeenCalledWith('[INIT] completed');
    expect(mockConsole.log).toHaveBeenCalledWith('[NETWORK] starting');
    expect(mockConsole.log).toHaveBeenCalledWith('[NETWORK] completed');
    expect(mockConsole.log).toHaveBeenCalledWith('[MEMBERSHIP] starting');
    expect(mockConsole.log).toHaveBeenCalledWith('[MEMBERSHIP] completed');
    expect(mockConsole.log).toHaveBeenCalledWith('[READY] Node lifecycle startup complete');
  });

  it('should stop phases in reverse order on failure', async () => {
    const phases = [
      new MockPhase('INIT'),
      new MockPhase('NETWORK', true), // This phase will fail
      new MockPhase('MEMBERSHIP')
    ];
    
    const lifecycle = new NodeLifecycle(phases, mockConsole as any);
    
    await expect(lifecycle.start()).rejects.toThrow('NETWORK failed');
    
    // Verify failure was logged
    expect(mockConsole.error).toHaveBeenCalledWith('[NETWORK] failed:', expect.any(Error));
  });

  it('should return current phase during startup', async () => {
    const phases = [new MockPhase('INIT')];
    const lifecycle = new NodeLifecycle(phases, mockConsole as any);
    
    // Before start
    expect(lifecycle.getCurrentPhase()).toBeNull();
    
    await lifecycle.start();
    
    // After start, no current phase (all completed)
    expect(lifecycle.getCurrentPhase()).toBeNull();
  });

  it('should prevent double start', async () => {
    const phases = [new MockPhase('INIT')];
    const lifecycle = new NodeLifecycle(phases, mockConsole as any);
    
    await lifecycle.start();
    
    await expect(lifecycle.start()).rejects.toThrow('NodeLifecycle is already started');
  });
});
