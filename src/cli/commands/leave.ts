/**
 * leave command - Signal a node to leave the cluster gracefully
 *
 * In a research kernel the simplest approach is to create a temporary
 * node that joins, sends a leave notification for the target, and exits.
 * For now this is a placeholder that prints guidance.
 */

import { ResolvedConfig } from '../config';
import { printError, printInfo } from '../output';

export async function leaveCommand(config: ResolvedConfig): Promise<void> {
  if (!config.nodeId) {
    printError('The "leave" command requires --node-id/-n to identify which node should leave.');
    process.exitCode = 1;
    return;
  }

  // In a full implementation we would connect to the target node and
  // instruct it to leave. For the research kernel, print what would happen.
  printInfo(`Requesting node ${config.nodeId} to leave the cluster...`);
  printInfo('Note: In the current research kernel, stop the target node process directly (SIGTERM/SIGINT).');
}
