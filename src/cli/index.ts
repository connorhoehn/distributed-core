#!/usr/bin/env node
/**
 * dcore CLI - Command-line interface for distributed-core
 *
 * Uses node:util parseArgs (built-in, zero external deps).
 *
 * Commands:
 *   start   Start a new node
 *   join    Join an existing cluster (requires seeds)
 *   status  Query cluster health/membership
 *   info    Print detailed topology/introspection data
 *   leave   Request a node to leave the cluster
 */

import { parseArgs } from 'node:util';
import { resolveConfig, CLIFlags } from './config';
import { startCommand } from './commands/start';
import { joinCommand } from './commands/join';
import { statusCommand } from './commands/status';
import { infoCommand } from './commands/info';
import { leaveCommand } from './commands/leave';
import { printError } from './output';

const USAGE = `
Usage: dcore <command> [options]

Commands:
  start    Start a new distributed-core node
  join     Join an existing cluster (requires --seed)
  status   Show cluster health and membership
  info     Show detailed cluster topology and metadata
  leave    Request a node to leave the cluster

Options:
  -c, --config <path>       Path to YAML config file (default: ./dcore.yaml)
  -n, --node-id <id>        Node identifier
  -p, --port <number>       Port to listen on (default: 8080)
      --host <address>      Host/address to bind (default: 0.0.0.0)
  -t, --transport <type>    Transport: in-memory|websocket|tcp|udp|http|grpc
      --coordinator <type>  Coordinator: in-memory|gossip
  -s, --seed <nodes>        Comma-separated seed node addresses
      --log                 Enable logging
      --json                Output as JSON
      --region <region>     Region for topology-aware placement
      --zone <zone>         Availability zone
      --role <role>         Node role (worker, coordinator, gateway, ...)
  -h, --help                Show this help message
`;

function printUsage(): void {
  console.log(USAGE.trim());
}

/**
 * Parse process.argv and dispatch to the appropriate command.
 * Exported for testing.
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;

  try {
    parsed = parseArgs({
      args: argv.slice(2),
      options: {
        config: { type: 'string', short: 'c' },
        'node-id': { type: 'string', short: 'n' },
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        transport: { type: 'string', short: 't' },
        coordinator: { type: 'string' },
        seed: { type: 'string', short: 's' },
        log: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        region: { type: 'string' },
        zone: { type: 'string' },
        role: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(msg);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const { values: flags, positionals } = parsed;

  if (flags.help) {
    printUsage();
    return;
  }

  const command = positionals[0];

  if (!command) {
    printError('No command specified.');
    printUsage();
    process.exitCode = 1;
    return;
  }

  const config = await resolveConfig(flags as CLIFlags);

  switch (command) {
    case 'start':
      return startCommand(config);
    case 'join':
      return joinCommand(config);
    case 'status':
      return statusCommand(config);
    case 'info':
      return infoCommand(config);
    case 'leave':
      return leaveCommand(config);
    default:
      printError(`Unknown command: ${command}`);
      printUsage();
      process.exitCode = 1;
  }
}

// Run when invoked directly (not when imported as a module in tests)
if (require.main === module) {
  main().catch((err) => {
    printError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
