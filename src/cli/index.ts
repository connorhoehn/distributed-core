#!/usr/bin/env node
/**
 * distributed-core CLI
 *
 * Usage:
 *   distributed-core start --config node.yaml
 *   distributed-core start --id node-1 --port 4000 --seed 127.0.0.1:4001
 *   distributed-core health --port 4000
 *   distributed-core status --port 4000
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { DistributedNodeFactory, DistributedNodeComponents } from '../factories/DistributedNodeFactory';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  // Skip node and script path
  const args = argv.slice(2);
  const command = args[0] || 'help';
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }

  return { command, flags };
}

// ---------------------------------------------------------------------------
// Config loading (YAML or flags)
// ---------------------------------------------------------------------------

export interface NodeStartConfig {
  id: string;
  address: string;
  port: number;
  seeds: string[];
  transport: 'websocket' | 'tcp';
  enableLogging: boolean;
}

export function loadConfig(flags: Record<string, string>): NodeStartConfig {
  let base: Partial<NodeStartConfig> = {};

  // If a YAML config file is provided, load it first
  if (flags.config) {
    const configPath = path.resolve(flags.config);
    if (!fs.existsSync(configPath)) {
      fatal(`Config file not found: ${configPath}`);
    }
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    base = {
      id: parsed.id as string | undefined,
      address: parsed.address as string | undefined,
      port: parsed.port != null ? Number(parsed.port) : undefined,
      seeds: Array.isArray(parsed.seeds)
        ? (parsed.seeds as string[])
        : parsed.seed
          ? String(parsed.seed).split(',').map(s => s.trim())
          : undefined,
      transport: (parsed.transport as 'websocket' | 'tcp') || undefined,
      enableLogging: parsed.enableLogging != null ? Boolean(parsed.enableLogging) : undefined,
    };
  }

  // CLI flags override config file values
  const id = flags.id || base.id || `node-${process.pid}`;
  const address = flags.address || base.address || '127.0.0.1';
  const port = flags.port ? Number(flags.port) : (base.port || 4000);
  const seeds = flags.seed
    ? flags.seed.split(',').map(s => s.trim())
    : (base.seeds || []);
  const transport = (flags.transport as 'websocket' | 'tcp') || base.transport || 'websocket';
  const enableLogging = flags.verbose === 'true' || base.enableLogging || false;

  if (isNaN(port) || port < 1 || port > 65535) {
    fatal(`Invalid port: ${flags.port}`);
  }

  return { id, address, port, seeds, transport, enableLogging };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function startCommand(flags: Record<string, string>): Promise<void> {
  const config = loadConfig(flags);

  console.log(`[distributed-core] Starting node "${config.id}"`);
  console.log(`  address   : ${config.address}:${config.port}`);
  console.log(`  transport : ${config.transport}`);
  console.log(`  seeds     : ${config.seeds.length > 0 ? config.seeds.join(', ') : '(none — standalone)'}`);
  console.log();

  let components: DistributedNodeComponents;

  try {
    components = await DistributedNodeFactory.builder()
      .id(config.id)
      .network(config.address, config.port)
      .transport(config.transport)
      .seedNodes(config.seeds)
      .enableLogging(config.enableLogging)
      .enableResources()
      .build();
  } catch (err: any) {
    fatal(`Failed to start node: ${err.message}`);
    return; // unreachable but helps TS
  }

  const { node } = components;
  console.log(`[distributed-core] Node "${config.id}" is running.`);

  // Periodic status printer
  const statusInterval = setInterval(() => {
    const health = node.getClusterHealth();
    const membership = node.getMembership();
    const memberList = membership instanceof Map ? Array.from(membership.keys()) : [];
    console.log(
      `[status] members=${health.totalNodes} alive=${health.aliveNodes} ` +
      `suspect=${health.suspectNodes} dead=${health.deadNodes} ` +
      `healthy=${health.isHealthy} nodes=[${memberList.join(', ')}]`
    );
  }, 10_000);
  statusInterval.unref();

  // Graceful shutdown handler
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[distributed-core] Received ${signal}, shutting down...`);
    clearInterval(statusInterval);
    try {
      await node.stop();
      console.log('[distributed-core] Node stopped.');
    } catch (err: any) {
      console.error(`[distributed-core] Error during shutdown: ${err.message}`);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function healthCommand(flags: Record<string, string>): void {
  const port = flags.port ? Number(flags.port) : 4000;
  const address = flags.address || '127.0.0.1';

  // Without an HTTP health endpoint baked into the running node, we perform a
  // simple TCP connect check to see if the port is accepting connections.
  const net = require('net') as typeof import('net');
  const socket = net.createConnection({ host: address, port }, () => {
    console.log(`[health] Node at ${address}:${port} is REACHABLE`);
    socket.destroy();
    process.exit(0);
  });

  socket.setTimeout(3000);
  socket.on('timeout', () => {
    console.error(`[health] Node at ${address}:${port} TIMEOUT`);
    socket.destroy();
    process.exit(1);
  });
  socket.on('error', (err: any) => {
    console.error(`[health] Node at ${address}:${port} UNREACHABLE — ${err.message}`);
    process.exit(1);
  });
}

function statusCommand(flags: Record<string, string>): void {
  const port = flags.port ? Number(flags.port) : 4000;
  const address = flags.address || '127.0.0.1';

  // Similar to health — without a dedicated query protocol we probe the port
  // and report basic reachability.  A future iteration could speak the gossip
  // protocol to pull the full membership table.
  const net = require('net') as typeof import('net');
  const socket = net.createConnection({ host: address, port }, () => {
    console.log(`[status] Connected to node at ${address}:${port}`);
    console.log('[status] Membership query not yet implemented — node is reachable.');
    socket.destroy();
    process.exit(0);
  });

  socket.setTimeout(3000);
  socket.on('timeout', () => {
    console.error(`[status] Node at ${address}:${port} TIMEOUT`);
    socket.destroy();
    process.exit(1);
  });
  socket.on('error', (err: any) => {
    console.error(`[status] Node at ${address}:${port} UNREACHABLE — ${err.message}`);
    process.exit(1);
  });
}

function printHelp(): void {
  console.log(`distributed-core CLI

Usage:
  distributed-core <command> [options]

Commands:
  start     Start a distributed node
  health    Check if a node is reachable
  status    Query node membership status
  help      Show this help message

Start options:
  --id <name>              Node identifier (default: node-<pid>)
  --address <addr>         Bind address (default: 127.0.0.1)
  --port <port>            Bind port (default: 4000)
  --seed <addr:port,...>   Comma-separated seed node addresses
  --transport <type>       Transport type: tcp | websocket (default: websocket)
  --config <path>          Path to a YAML configuration file
  --verbose                Enable verbose logging

Health / Status options:
  --address <addr>         Target address (default: 127.0.0.1)
  --port <port>            Target port (default: 4000)

Example YAML config (node.yaml):
  id: node-1
  address: 127.0.0.1
  port: 4000
  transport: websocket
  seeds:
    - 127.0.0.1:4001
    - 127.0.0.1:4002
  enableLogging: true
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function fatal(message: string): never {
  console.error(`[distributed-core] ERROR: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  switch (command) {
    case 'start':
      await startCommand(flags);
      break;
    case 'health':
      healthCommand(flags);
      break;
    case 'status':
      statusCommand(flags);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  fatal(err.message || String(err));
});
