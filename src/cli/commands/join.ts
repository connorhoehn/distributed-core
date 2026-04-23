/**
 * join command - Join an existing distributed-core cluster
 *
 * Same as start, but validates that seed nodes are provided so the
 * node can discover and join an existing cluster.
 */

import { createNode } from '../../frontdoor';
import { ResolvedConfig } from '../config';
import { printSuccess, printError, printInfo, printJson } from '../output';

export async function joinCommand(config: ResolvedConfig): Promise<void> {
  // Validate that seeds are specified
  if (!config.seedNodes || config.seedNodes.length === 0) {
    printError('The "join" command requires at least one seed node. Use --seed/-s to specify seeds.');
    process.exitCode = 1;
    return;
  }

  const handle = await createNode({
    id: config.nodeId,
    port: config.port,
    address: config.host,
    transport: config.transport === 'grpc' ? 'tcp' : config.transport,
    seedNodes: config.seedNodes,
    logging: config.enableLogging,
    region: config.region,
    zone: config.zone,
    role: config.role,
  });

  try {
    await handle.start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`Failed to join cluster: ${msg}`);
    process.exitCode = 1;
    return;
  }

  if (config.outputJson) {
    printJson({
      event: 'joined',
      nodeId: handle.id,
      address: `${config.host}:${config.port}`,
      transport: config.transport,
      seedNodes: config.seedNodes,
    });
  } else {
    printSuccess(`Node ${handle.id} joined cluster`);
    printInfo(`  Address:   ${config.host}:${config.port}`);
    printInfo(`  Transport: ${config.transport}`);
    printInfo(`  Seeds:     ${config.seedNodes.join(', ')}`);
    if (config.region) printInfo(`  Region:    ${config.region}`);
    if (config.zone) printInfo(`  Zone:      ${config.zone}`);
    if (config.role) printInfo(`  Role:      ${config.role}`);
  }

  // Graceful shutdown handlers
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (!config.outputJson) {
      printInfo('\nShutting down...');
    }

    try {
      await handle.stop();
      if (config.outputJson) {
        printJson({ event: 'stopped', nodeId: handle.id });
      } else {
        printSuccess(`Node ${handle.id} stopped`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      printError(`Error during shutdown: ${msg}`);
      process.exitCode = 1;
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
