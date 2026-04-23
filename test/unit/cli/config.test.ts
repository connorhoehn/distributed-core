import {
  resolveConfig,
  DEFAULTS,
  CLIFlags,
  _loadEnvConfig,
  _loadCLIConfig,
  _mergeConfigs,
  ResolvedConfig,
} from '../../../src/cli/config';

describe('CLI Config Resolution', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore environment after each test
    process.env = { ...originalEnv };
  });

  describe('DEFAULTS', () => {
    it('should have correct default values', () => {
      expect(DEFAULTS.port).toBe(8080);
      expect(DEFAULTS.host).toBe('0.0.0.0');
      expect(DEFAULTS.transport).toBe('websocket');
      expect(DEFAULTS.coordinator).toBe('gossip');
      expect(DEFAULTS.seedNodes).toEqual([]);
      expect(DEFAULTS.enableLogging).toBe(false);
      expect(DEFAULTS.outputJson).toBe(false);
    });
  });

  describe('resolveConfig with no overrides', () => {
    it('should return defaults when no flags, env, or yaml are set', async () => {
      // Clear DCORE_ env vars
      delete process.env.DCORE_PORT;
      delete process.env.DCORE_HOST;
      delete process.env.DCORE_TRANSPORT;
      delete process.env.DCORE_COORDINATOR;
      delete process.env.DCORE_SEED;
      delete process.env.DCORE_NODE_ID;
      delete process.env.DCORE_REGION;
      delete process.env.DCORE_ZONE;
      delete process.env.DCORE_ROLE;

      const config = await resolveConfig({});
      expect(config.port).toBe(8080);
      expect(config.host).toBe('0.0.0.0');
      expect(config.transport).toBe('websocket');
      expect(config.coordinator).toBe('gossip');
      expect(config.seedNodes).toEqual([]);
      expect(config.enableLogging).toBe(false);
      expect(config.outputJson).toBe(false);
    });
  });

  describe('CLI flags override defaults', () => {
    it('should apply CLI flags on top of defaults', async () => {
      delete process.env.DCORE_PORT;
      delete process.env.DCORE_HOST;
      delete process.env.DCORE_TRANSPORT;
      delete process.env.DCORE_COORDINATOR;
      delete process.env.DCORE_SEED;
      delete process.env.DCORE_NODE_ID;
      delete process.env.DCORE_REGION;
      delete process.env.DCORE_ZONE;
      delete process.env.DCORE_ROLE;

      const flags: CLIFlags = {
        port: '9090',
        host: '127.0.0.1',
        transport: 'tcp',
        coordinator: 'gossip',
        seed: 'a:1,b:2',
        'node-id': 'my-node',
        log: true,
        json: true,
        region: 'us-east-1',
        zone: 'az-a',
        role: 'worker',
      };

      const config = await resolveConfig(flags);
      expect(config.port).toBe(9090);
      expect(config.host).toBe('127.0.0.1');
      expect(config.transport).toBe('tcp');
      expect(config.coordinator).toBe('gossip');
      expect(config.seedNodes).toEqual(['a:1', 'b:2']);
      expect(config.nodeId).toBe('my-node');
      expect(config.enableLogging).toBe(true);
      expect(config.outputJson).toBe(true);
      expect(config.region).toBe('us-east-1');
      expect(config.zone).toBe('az-a');
      expect(config.role).toBe('worker');
    });
  });

  describe('environment variables override defaults', () => {
    it('should apply env vars on top of defaults', async () => {
      process.env.DCORE_PORT = '3000';
      process.env.DCORE_HOST = '10.0.0.1';
      process.env.DCORE_TRANSPORT = 'udp';
      process.env.DCORE_COORDINATOR = 'in-memory';
      process.env.DCORE_SEED = 'seed1:8080,seed2:8080';
      process.env.DCORE_NODE_ID = 'env-node';
      process.env.DCORE_REGION = 'eu-west-1';
      process.env.DCORE_ZONE = 'az-b';
      process.env.DCORE_ROLE = 'coordinator';

      const config = await resolveConfig({});
      expect(config.port).toBe(3000);
      expect(config.host).toBe('10.0.0.1');
      expect(config.transport).toBe('udp');
      expect(config.coordinator).toBe('in-memory');
      expect(config.seedNodes).toEqual(['seed1:8080', 'seed2:8080']);
      expect(config.nodeId).toBe('env-node');
      expect(config.region).toBe('eu-west-1');
      expect(config.zone).toBe('az-b');
      expect(config.role).toBe('coordinator');
    });
  });

  describe('CLI flags beat environment variables', () => {
    it('should let CLI flags win over env vars', async () => {
      process.env.DCORE_PORT = '3000';
      process.env.DCORE_HOST = '10.0.0.1';
      process.env.DCORE_TRANSPORT = 'udp';

      const flags: CLIFlags = {
        port: '4000',
        host: '192.168.1.1',
        transport: 'http',
      };

      const config = await resolveConfig(flags);
      expect(config.port).toBe(4000);
      expect(config.host).toBe('192.168.1.1');
      expect(config.transport).toBe('http');
    });
  });

  describe('DCORE_SEED parsing', () => {
    it('should parse comma-separated seed strings', () => {
      process.env.DCORE_SEED = 'host1:8080, host2:8081, host3:8082';
      const partial = _loadEnvConfig();
      expect(partial.seedNodes).toEqual(['host1:8080', 'host2:8081', 'host3:8082']);
    });

    it('should handle single seed', () => {
      process.env.DCORE_SEED = 'host1:8080';
      const partial = _loadEnvConfig();
      expect(partial.seedNodes).toEqual(['host1:8080']);
    });

    it('should filter empty entries from trailing commas', () => {
      process.env.DCORE_SEED = 'host1:8080,,host2:8081,';
      const partial = _loadEnvConfig();
      expect(partial.seedNodes).toEqual(['host1:8080', 'host2:8081']);
    });
  });

  describe('missing config file handling', () => {
    it('should not throw when --config points to a nonexistent file', async () => {
      delete process.env.DCORE_PORT;
      delete process.env.DCORE_HOST;
      delete process.env.DCORE_TRANSPORT;
      delete process.env.DCORE_COORDINATOR;
      delete process.env.DCORE_SEED;
      delete process.env.DCORE_NODE_ID;
      delete process.env.DCORE_REGION;
      delete process.env.DCORE_ZONE;
      delete process.env.DCORE_ROLE;

      const config = await resolveConfig({ config: '/nonexistent/path/dcore.yaml' });
      // Should still return defaults without error
      expect(config.port).toBe(8080);
      expect(config.host).toBe('0.0.0.0');
    });
  });

  describe('_loadCLIConfig', () => {
    it('should ignore invalid transport values', () => {
      const partial = _loadCLIConfig({ transport: 'invalid-transport' });
      expect(partial.transport).toBeUndefined();
    });

    it('should ignore invalid coordinator values', () => {
      const partial = _loadCLIConfig({ coordinator: 'invalid-coordinator' });
      expect(partial.coordinator).toBeUndefined();
    });

    it('should ignore NaN port values', () => {
      const partial = _loadCLIConfig({ port: 'not-a-number' });
      expect(partial.port).toBeUndefined();
    });
  });

  describe('_mergeConfigs', () => {
    it('should only overwrite defined values', () => {
      const base: ResolvedConfig = { ...DEFAULTS };
      const override: Partial<ResolvedConfig> = { port: 9999 };
      const merged = _mergeConfigs(base, override);
      expect(merged.port).toBe(9999);
      expect(merged.host).toBe('0.0.0.0'); // unchanged
      expect(merged.transport).toBe('websocket'); // unchanged
    });
  });
});
