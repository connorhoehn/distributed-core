/**
 * start command - Start a distributed-core node
 *
 * Creates a node via the Front Door API, starts it, and keeps the
 * process alive. Installs SIGINT/SIGTERM handlers for graceful shutdown.
 */

import { createNode } from '../../frontdoor';
import { ResolvedConfig } from '../config';
import { printSuccess, printError, printInfo, printJson } from '../output';

export async function startCommand(config: ResolvedConfig): Promise<void> {
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
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`Failed to start node: ${msg}`);
    process.exitCode = 1;
    return;
  }

  if (config.outputJson) {
    printJson({
      event: 'started',
      nodeId: handle.id,
      address: `${config.host}:${config.port}`,
      transport: config.transport,
      coordinator: config.coordinator,
      seedNodes: config.seedNodes,
    });
  } else {
    printSuccess(`Node ${handle.id} started`);
    printInfo(`  Address:     ${config.host}:${config.port}`);
    printInfo(`  Transport:   ${config.transport}`);
    printInfo(`  Coordinator: ${config.coordinator}`);
    if (config.seedNodes.length > 0) {
      printInfo(`  Seeds:       ${config.seedNodes.join(', ')}`);
    }
    if (config.region) printInfo(`  Region:      ${config.region}`);
    if (config.zone) printInfo(`  Zone:        ${config.zone}`);
    if (config.role) printInfo(`  Role:        ${config.role}`);
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
