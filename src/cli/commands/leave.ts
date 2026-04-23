/**
 * leave command - Signal a node to leave the cluster gracefully.
 *
 * Creates a temporary probe node that joins the cluster via seed nodes,
 * sends a drain/leave signal to the target node, waits for confirmation
 * (or times out), then cleans up and exits.
 *
 * Usage:
 *   dcore leave --node-id <target-id> --seed <seed-address,...>
 *
 * Options forwarded from ResolvedConfig:
 *   nodeId      - ID of the node that should leave (required)
 *   seedNodes   - At least one seed used to reach the cluster (required)
 *   port/host   - Bind address for the temporary probe node
 *   transport   - Transport layer to use
 */

import { createNode } from '../../frontdoor';
import { ResolvedConfig } from '../config';
import { printSuccess, printError, printInfo, printJson } from '../output';

/** How long (ms) we wait for the drain to be acknowledged before giving up. */
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

export async function leaveCommand(config: ResolvedConfig): Promise<void> {
  if (!config.nodeId) {
    printError('The "leave" command requires --node-id/-n to identify which node should leave.');
    process.exitCode = 1;
    return;
  }

  if (!config.seedNodes || config.seedNodes.length === 0) {
    printError('The "leave" command requires at least one seed node (--seed/-s) to reach the cluster.');
    process.exitCode = 1;
    return;
  }

  const targetNodeId = config.nodeId;

  // Create a short-lived probe node that joins the cluster purely to send the
  // leave signal.  We give it a unique ephemeral ID so it does not conflict
  // with the target node that is already a member.
  const probeId = `leave-probe-${Date.now()}`;

  const handle = await createNode({
    id: probeId,
    port: config.port,
    address: config.host,
    transport: config.transport === 'grpc' ? 'tcp' : config.transport,
    seedNodes: config.seedNodes,
    logging: config.enableLogging,
    role: 'probe',
  });

  if (!config.outputJson) {
    printInfo(`Connecting to cluster via ${config.seedNodes.join(', ')}…`);
  }

  try {
    await handle.start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`Failed to connect to cluster: ${msg}`);
    process.exitCode = 1;
    return;
  }

  try {
    const cluster = handle.getCluster();

    // Verify the target node is actually known to the cluster.
    const membership = handle.getMembership();
    if (!membership.has(targetNodeId)) {
      printError(`Node "${targetNodeId}" is not a known member of the cluster.`);
      process.exitCode = 1;
      return;
    }

    if (!config.outputJson) {
      printInfo(`Sending graceful leave signal to node "${targetNodeId}"…`);
    }

    // drainNode signals the target node to stop accepting new work and then
    // leave the cluster.  It returns true on success within the timeout.
    const drained = await cluster.drainNode(targetNodeId, DEFAULT_DRAIN_TIMEOUT_MS);

    if (drained) {
      if (config.outputJson) {
        printJson({ event: 'left', nodeId: targetNodeId, success: true });
      } else {
        printSuccess(`Node "${targetNodeId}" has left the cluster gracefully.`);
      }
    } else {
      if (config.outputJson) {
        printJson({ event: 'leave-timeout', nodeId: targetNodeId, success: false });
      } else {
        printError(
          `Timed out waiting for node "${targetNodeId}" to leave after ${DEFAULT_DRAIN_TIMEOUT_MS / 1000}s. ` +
            `The node may still be draining or unreachable.`
        );
      }
      process.exitCode = 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`Failed to send leave signal: ${msg}`);
    process.exitCode = 1;
  } finally {
    try {
      await handle.stop();
    } catch {
      // Best-effort cleanup — do not mask the original error.
    }
  }
}
