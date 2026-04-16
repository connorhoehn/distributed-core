import { parseArgs, loadConfig } from '../../../src/cli/index';

describe('CLI argument parsing', () => {
  // Helper: simulates process.argv with the given CLI tokens.
  // process.argv[0] = node, argv[1] = script path, rest = user args.
  function argv(...tokens: string[]): string[] {
    return ['node', 'distributed-core', ...tokens];
  }

  // -- parseArgs -------------------------------------------------------------

  describe('parseArgs', () => {
    it('parses "start --id node-1 --port 4000" correctly', () => {
      const result = parseArgs(argv('start', '--id', 'node-1', '--port', '4000'));

      expect(result.command).toBe('start');
      expect(result.flags.id).toBe('node-1');
      expect(result.flags.port).toBe('4000');
    });

    it('parses --seed with comma-separated addresses as a single string value', () => {
      const result = parseArgs(
        argv('start', '--seed', '127.0.0.1:4001,127.0.0.1:4002'),
      );

      expect(result.command).toBe('start');
      expect(result.flags.seed).toBe('127.0.0.1:4001,127.0.0.1:4002');
    });

    it('parses --transport tcp', () => {
      const result = parseArgs(argv('start', '--transport', 'tcp'));

      expect(result.command).toBe('start');
      expect(result.flags.transport).toBe('tcp');
    });

    it('defaults to "help" when no command is given', () => {
      const result = parseArgs(argv());

      expect(result.command).toBe('help');
    });

    it('treats boolean-style flags (no value) as "true"', () => {
      const result = parseArgs(argv('start', '--verbose'));

      expect(result.flags.verbose).toBe('true');
    });

    it('captures an unknown command string as-is', () => {
      const result = parseArgs(argv('frobnicate'));

      expect(result.command).toBe('frobnicate');
    });
  });

  // -- loadConfig (flag-based, no YAML file) ---------------------------------

  describe('loadConfig', () => {
    it('returns defaults when no flags are provided', () => {
      const config = loadConfig({});

      expect(config.address).toBe('127.0.0.1');
      expect(config.port).toBe(4000);
      expect(config.seeds).toEqual([]);
      expect(config.transport).toBe('websocket');
      expect(config.enableLogging).toBe(false);
      // id falls back to `node-<pid>`
      expect(config.id).toMatch(/^node-/);
    });

    it('splits --seed into an array of addresses', () => {
      const config = loadConfig({ seed: '127.0.0.1:4001,127.0.0.1:4002' });

      expect(config.seeds).toEqual(['127.0.0.1:4001', '127.0.0.1:4002']);
    });

    it('overrides defaults with explicit flags', () => {
      const config = loadConfig({
        id: 'my-node',
        address: '0.0.0.0',
        port: '5000',
        transport: 'tcp',
        verbose: 'true',
      });

      expect(config.id).toBe('my-node');
      expect(config.address).toBe('0.0.0.0');
      expect(config.port).toBe(5000);
      expect(config.transport).toBe('tcp');
      expect(config.enableLogging).toBe(true);
    });

    it('exits on invalid port', () => {
      // loadConfig calls fatal() which calls process.exit(1)
      const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit');
      }) as any);
      const mockError = jest.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => loadConfig({ port: 'not-a-number' })).toThrow('process.exit');

      mockExit.mockRestore();
      mockError.mockRestore();
    });
  });

  // -- Unknown command behavior (integration-style, using parseArgs) ----------

  describe('unknown command detection', () => {
    it('returns the unknown command so the caller can show help', () => {
      const result = parseArgs(argv('bogus-cmd'));

      // The main() switch treats anything not in {start,health,status,help}
      // as unknown and prints help.  parseArgs itself just returns the string.
      expect(result.command).toBe('bogus-cmd');
      expect(['start', 'health', 'status', 'help', '--help', '-h']).not.toContain(
        result.command,
      );
    });
  });
});
