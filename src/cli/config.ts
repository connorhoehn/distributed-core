/**
 * CLI configuration resolution
 *
 * Precedence (later wins):
 *   defaults -> YAML file -> environment variables -> CLI flags
 */

import { existsSync } from 'fs';
import { YamlSeedConfiguration } from '../config/YamlSeedConfiguration';

export interface ResolvedConfig {
  nodeId?: string;
  port: number;
  host: string;
  transport: 'in-memory' | 'websocket' | 'tcp' | 'udp' | 'http' | 'grpc';
  coordinator: 'in-memory' | 'gossip' | 'etcd' | 'zookeeper';
  seedNodes: string[];
  enableLogging: boolean;
  region?: string;
  zone?: string;
  role?: string;
  outputJson: boolean;
}

/** Hard-coded defaults used when no other source provides a value. */
export const DEFAULTS: ResolvedConfig = {
  port: 8080,
  host: '0.0.0.0',
  transport: 'websocket',
  coordinator: 'gossip',
  seedNodes: [],
  enableLogging: false,
  outputJson: false,
};

const VALID_TRANSPORTS = ['in-memory', 'websocket', 'tcp', 'udp', 'http', 'grpc'] as const;
const VALID_COORDINATORS = ['in-memory', 'gossip', 'etcd', 'zookeeper'] as const;

function isValidTransport(v: string): v is ResolvedConfig['transport'] {
  return (VALID_TRANSPORTS as readonly string[]).includes(v);
}

function isValidCoordinator(v: string): v is ResolvedConfig['coordinator'] {
  return (VALID_COORDINATORS as readonly string[]).includes(v);
}

/**
 * Read configuration from a YAML file using the existing YamlSeedConfiguration loader.
 * Returns a partial config; missing fields stay undefined.
 */
async function loadYamlConfig(filePath: string): Promise<Partial<ResolvedConfig>> {
  const partial: Partial<ResolvedConfig> = {};

  try {
    const loader = new YamlSeedConfiguration();
    await loader.loadFromFile(filePath);
    const seeds = loader.toLegacyStringArray();
    if (seeds.length > 0) {
      partial.seedNodes = seeds;
    }
    const cfg = loader.getConfig();
    if (cfg?.cluster?.name) {
      // The cluster name could serve as context; we don't map it to a
      // specific CLI field but we could in the future.
    }
  } catch {
    // If the file is unreadable or invalid, we silently fall back.
  }

  return partial;
}

/**
 * Read overrides from environment variables.
 */
function loadEnvConfig(): Partial<ResolvedConfig> {
  const partial: Partial<ResolvedConfig> = {};

  if (process.env.DCORE_PORT) {
    const p = parseInt(process.env.DCORE_PORT, 10);
    if (!isNaN(p)) partial.port = p;
  }
  if (process.env.DCORE_HOST) {
    partial.host = process.env.DCORE_HOST;
  }
  if (process.env.DCORE_TRANSPORT && isValidTransport(process.env.DCORE_TRANSPORT)) {
    partial.transport = process.env.DCORE_TRANSPORT;
  }
  if (process.env.DCORE_COORDINATOR && isValidCoordinator(process.env.DCORE_COORDINATOR)) {
    partial.coordinator = process.env.DCORE_COORDINATOR;
  }
  if (process.env.DCORE_SEED) {
    partial.seedNodes = process.env.DCORE_SEED.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.DCORE_NODE_ID) {
    partial.nodeId = process.env.DCORE_NODE_ID;
  }
  if (process.env.DCORE_REGION) {
    partial.region = process.env.DCORE_REGION;
  }
  if (process.env.DCORE_ZONE) {
    partial.zone = process.env.DCORE_ZONE;
  }
  if (process.env.DCORE_ROLE) {
    partial.role = process.env.DCORE_ROLE;
  }

  return partial;
}

export interface CLIFlags {
  config?: string;
  'node-id'?: string;
  port?: string;
  host?: string;
  transport?: string;
  coordinator?: string;
  seed?: string;
  log?: boolean;
  json?: boolean;
  region?: string;
  zone?: string;
  role?: string;
}

/**
 * Map raw CLI flags (all strings/booleans from parseArgs) into a partial config.
 */
function loadCLIConfig(flags: CLIFlags): Partial<ResolvedConfig> {
  const partial: Partial<ResolvedConfig> = {};

  if (flags['node-id']) {
    partial.nodeId = flags['node-id'];
  }
  if (flags.port) {
    const p = parseInt(flags.port, 10);
    if (!isNaN(p)) partial.port = p;
  }
  if (flags.host) {
    partial.host = flags.host;
  }
  if (flags.transport && isValidTransport(flags.transport)) {
    partial.transport = flags.transport;
  }
  if (flags.coordinator && isValidCoordinator(flags.coordinator)) {
    partial.coordinator = flags.coordinator;
  }
  if (flags.seed) {
    partial.seedNodes = flags.seed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (flags.log !== undefined) {
    partial.enableLogging = flags.log;
  }
  if (flags.json !== undefined) {
    partial.outputJson = flags.json;
  }
  if (flags.region) {
    partial.region = flags.region;
  }
  if (flags.zone) {
    partial.zone = flags.zone;
  }
  if (flags.role) {
    partial.role = flags.role;
  }

  return partial;
}

/**
 * Merge multiple partial configs onto a base, left-to-right (later wins).
 * Only defined values overwrite the base.
 */
function mergeConfigs(base: ResolvedConfig, ...overrides: Partial<ResolvedConfig>[]): ResolvedConfig {
  const result = { ...base };

  for (const override of overrides) {
    for (const key of Object.keys(override) as (keyof ResolvedConfig)[]) {
      const value = override[key];
      if (value !== undefined) {
        (result as any)[key] = value;
      }
    }
  }

  return result;
}

/**
 * Resolve the final configuration by layering:
 *   defaults -> YAML -> env vars -> CLI flags
 */
export async function resolveConfig(flags: CLIFlags): Promise<ResolvedConfig> {
  // 1. Start with defaults
  let config = { ...DEFAULTS };

  // 2. YAML file (explicit --config path or ./dcore.yaml)
  const yamlPath = flags.config || (existsSync('dcore.yaml') ? 'dcore.yaml' : undefined);
  if (yamlPath) {
    const yamlPartial = await loadYamlConfig(yamlPath);
    config = mergeConfigs(config, yamlPartial);
  }

  // 3. Environment variables
  const envPartial = loadEnvConfig();
  config = mergeConfigs(config, envPartial);

  // 4. CLI flags (highest priority)
  const cliPartial = loadCLIConfig(flags);
  config = mergeConfigs(config, cliPartial);

  return config;
}

// Export helpers for testing
export { loadEnvConfig as _loadEnvConfig, loadCLIConfig as _loadCLIConfig, mergeConfigs as _mergeConfigs };
