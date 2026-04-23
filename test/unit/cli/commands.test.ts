import { main } from '../../../src/cli/index';
import { DEFAULTS, ResolvedConfig } from '../../../src/cli/config';

// Capture console output
let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

beforeEach(() => {
  consoleOutput = [];
  consoleErrors = [];
  console.log = (...args: any[]) => {
    consoleOutput.push(args.map(String).join(' '));
  };
  console.error = (...args: any[]) => {
    consoleErrors.push(args.map(String).join(' '));
  };
  console.warn = (...args: any[]) => {
    // suppress warnings
  };
  process.exitCode = undefined;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  process.exitCode = undefined;
});

describe('CLI Command Dispatch', () => {
  describe('help flag', () => {
    it('should print usage when --help is passed', async () => {
      await main(['node', 'dcore', '--help']);
      const output = consoleOutput.join('\n');
      expect(output).toContain('Usage: dcore <command>');
      expect(output).toContain('start');
      expect(output).toContain('join');
      expect(output).toContain('status');
      expect(output).toContain('info');
      expect(output).toContain('leave');
    });
  });

  describe('no command', () => {
    it('should print error and usage when no command is given', async () => {
      await main(['node', 'dcore']);
      const errOutput = consoleErrors.join('\n');
      expect(errOutput).toContain('No command specified');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('unknown command', () => {
    it('should print error and usage for unknown commands', async () => {
      await main(['node', 'dcore', 'foobar']);
      const errOutput = consoleErrors.join('\n');
      expect(errOutput).toContain('Unknown command: foobar');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('join command without seeds', () => {
    it('should print error when no seeds are provided', async () => {
      // Clear env seeds
      delete process.env.DCORE_SEED;

      await main(['node', 'dcore', 'join']);
      const errOutput = consoleErrors.join('\n');
      expect(errOutput).toContain('requires at least one seed node');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('leave command without node-id', () => {
    it('should print error when no node-id is provided', async () => {
      delete process.env.DCORE_NODE_ID;

      await main(['node', 'dcore', 'leave']);
      const errOutput = consoleErrors.join('\n');
      expect(errOutput).toContain('requires --node-id');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('leave command with node-id', () => {
    it('should print leave message when node-id is provided', async () => {
      delete process.env.DCORE_NODE_ID;

      await main(['node', 'dcore', 'leave', '--node-id', 'test-node-123']);
      const output = consoleOutput.join('\n');
      expect(output).toContain('test-node-123');
      expect(output).toContain('leave');
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('invalid flags', () => {
    it('should print error for unknown flags', async () => {
      await main(['node', 'dcore', 'start', '--nonexistent-flag']);
      const errOutput = consoleErrors.join('\n');
      expect(errOutput.length).toBeGreaterThan(0);
      expect(process.exitCode).toBe(1);
    });
  });

  describe('short flags', () => {
    it('should accept -h as alias for --help', async () => {
      await main(['node', 'dcore', '-h']);
      const output = consoleOutput.join('\n');
      expect(output).toContain('Usage: dcore <command>');
    });
  });
});
